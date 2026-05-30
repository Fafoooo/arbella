/**
 * Repo orchestration: provider selection + the high-level git flows the
 * commands call (init/backup/status/restore). This module is the single source
 * of truth for the `RepoProviderApi` shape — the three providers import the TYPE
 * from here (type-only, so there is no runtime import cycle even though this
 * file imports their concrete singletons).
 *
 * Path handling goes through node:path and src/utils/fs.ts; no hardcoded
 * separators, no machine paths. All git work is delegated to ./git.js.
 */

import path from "node:path";

import type { RepoProvider } from "../../types.js";
import { fs } from "../../utils/fs.js";
import { log } from "../../utils/log.js";
import type { RepoConfig } from "../config/schema.js";
import {
  ensureRepoAuth,
  isAuthFailure,
  redactAuthUrl,
  type EnsureRepoAuthArgs,
  type RepoAuth,
} from "../auth/index.js";

import * as git from "./git.js";
import { genericProvider } from "./providers/generic.js";
import { githubProvider } from "./providers/github.js";
import { gitlabProvider } from "./providers/gitlab.js";

/* -------------------------------------------------------------------------- */
/* Auth integration (P5)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Interactive auth seams threaded from the COMMAND layer down into a clone/pull.
 * The repo layer must stay free of UI deps (@clack) and the platform installer
 * import cycle, so commands pass these in. They are the SAME seams `ensureRepoAuth`
 * accepts (token paste + provider-CLI install-on-demand) plus the timestamp the
 * command owns. When omitted, auth still runs but only NON-interactively: it uses
 * an already-logged-in gh/glab or an already-stored token, and never prompts.
 */
export type RepoAuthHooks = Pick<
  EnsureRepoAuthArgs,
  "interactive" | "paste" | "installer" | "clientIdOverrides" | "preferDeviceFlow" | "createdAt"
>;

/**
 * Run an authenticated git operation against `repoUrl` with one retry on an auth
 * failure. The first attempt uses the ORIGINAL url (so public repos and
 * already-working credential helpers need nothing). If it fails with an
 * auth/permission signal AND `hooks` allow it, we call {@link ensureRepoAuth}
 * (gh/glab-first, device-flow/token fallback) and retry — using the provider CLI
 * (original url, helper-configured) when that path wins, or the token-embedded
 * `authUrl` when arbella obtained a token itself.
 *
 * `op(url, credentialed)` performs the git work for a given url; `credentialed`
 * is true ONLY on the fallback retry when `url` carries an embedded arbella token
 * (so a clone op can scrub the persisted remote afterward — see ensureLocalClone).
 * Returns nothing; throws the original error when auth can't help (so callers see
 * the real failure). NEVER logs a token: only {@link redactAuthUrl}-safe URLs and
 * secret-free reasons.
 */
async function withRepoAuth(
  repoUrl: string,
  hooks: RepoAuthHooks | undefined,
  op: (url: string, credentialed: boolean) => Promise<void>,
): Promise<void> {
  try {
    await op(repoUrl, false);
    return;
  } catch (err) {
    if (!isAuthFailure(err)) {
      throw err; // not an auth problem — propagate verbatim.
    }
    log.debug("repo: git operation failed with an auth signal; attempting sign-in.");

    let auth: RepoAuth;
    try {
      auth = await ensureRepoAuth({
        repoUrl,
        interactive: hooks?.interactive ?? true,
        requireAuth: true,
        ...(hooks?.paste ? { paste: hooks.paste } : {}),
        ...(hooks?.installer ? { installer: hooks.installer } : {}),
        ...(hooks?.clientIdOverrides
          ? { clientIdOverrides: hooks.clientIdOverrides }
          : {}),
        ...(hooks?.preferDeviceFlow !== undefined
          ? { preferDeviceFlow: hooks.preferDeviceFlow }
          : {}),
        ...(hooks?.createdAt ? { createdAt: hooks.createdAt } : {}),
      });
    } catch (authErr) {
      // Auth itself blew up (network, CLI crash). Surface the ORIGINAL git error
      // as the primary cause; note the auth failure at debug.
      log.debug(
        `repo: sign-in attempt failed: ${
          authErr instanceof Error ? authErr.message : String(authErr)
        }`,
      );
      throw err;
    }

    // Decide the retry URL: provider-CLI path keeps the original (git helper is
    // configured); arbella-token path uses the embedded-credential URL (flagged
    // `credentialed` so a clone op scrubs the persisted remote afterward).
    if (auth.useProviderCli) {
      log.debug(`repo: retrying using ${auth.cli ?? "provider CLI"} credentials.`);
      await op(repoUrl, false);
    } else if (auth.authUrl) {
      log.debug(`repo: retrying with credentials for ${redactAuthUrl(auth.authUrl)}.`);
      await op(auth.authUrl, true);
    } else {
      // Could not obtain any usable credential — re-throw the original error with
      // a friendlier hint appended.
      log.warn(
        "Could not authenticate to the backup repo. " +
          "Install/sign in with `arbella auth login` (or gh/glab) and retry.",
      );
      throw err;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Provider contract (the single definition; providers import this type)       */
/* -------------------------------------------------------------------------- */

/**
 * A hosting-provider adapter for the backup repo. `github`/`gitlab` shell out to
 * their CLIs; `generic` is a no-op creator over a user-supplied remote.
 */
export interface RepoProviderApi {
  /** Stable provider id. */
  readonly id: RepoProvider;
  /** Is the provider usable here? (gh/glab present; generic => always true.) */
  isAvailable(): Promise<boolean>;
  /** Does the named repo already exist for the user? (generic => assumed true.) */
  repoExists(name: string): Promise<boolean>;
  /**
   * Create a PRIVATE repo named `name` and return its clone URL (ssh or https).
   * `private` defaults to true; arbella never creates public backup repos.
   */
  createRepo(
    name: string,
    opts?: { private?: boolean; description?: string },
  ): Promise<string>;
  /** Resolve an "owner/name" or full URL into a clone URL for this provider. */
  resolveUrl(input: string): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* Provider selection                                                          */
/* -------------------------------------------------------------------------- */

/** Return the provider implementation for a given id. */
export function getProvider(provider: RepoProvider): RepoProviderApi {
  switch (provider) {
    case "github":
      return githubProvider;
    case "gitlab":
      return gitlabProvider;
    case "generic":
      return genericProvider;
  }
}

/* -------------------------------------------------------------------------- */
/* High-level flows used by commands                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ensure the configured backup repo is cloned locally at `repo.localPath`.
 *
 *  - If `localPath` already holds a git repo: no-op (caller pulls separately
 *    when it wants repo-as-source freshness).
 *  - If `localPath` exists but is NOT a git repo and is non-empty: throw, rather
 *    than risk clobbering unrelated files.
 *  - Otherwise: `git clone repo.url localPath` (parent dir is created first).
 *
 * AUTH (P5): the clone is attempted unauthenticated first, so PUBLIC repos and
 * machines whose gh/glab/credential-helper is already set up need nothing. On an
 * auth/permission failure for a PRIVATE repo, {@link ensureRepoAuth} runs
 * (gh/glab-first; install-on-demand or device-flow/token fallback) and the clone
 * is retried with the resulting credentials — all WITHOUT mutating global git
 * config. `auth` carries the interactive seams from the command layer; when it is
 * omitted, the retry is non-interactive (reuse a logged-in CLI / stored token).
 *
 * ssh / file:// / generic remotes are untouched by auth (ensureRepoAuth returns
 * `needsAuth:false` for them), so they keep working exactly as before.
 *
 * Requires `repo.url` to be set; throws a friendly error if it is empty.
 */
export async function ensureLocalClone(
  repo: RepoConfig,
  auth?: RepoAuthHooks,
): Promise<void> {
  const localPath = repo.localPath;
  if (!localPath) {
    throw new Error("repo.localPath is not configured; run `arbella init` first.");
  }

  if (await git.isGitRepo(localPath)) {
    log.debug(`Backup repo already cloned at ${localPath}`);
    return;
  }

  // Not a git repo yet. If the directory exists and has content, refuse.
  if (await fs.exists(localPath)) {
    const entries = await fs.list(localPath);
    const meaningful = entries.filter((e) => e !== ".git");
    if (meaningful.length > 0) {
      throw new Error(
        `Cannot clone backup repo: ${localPath} exists and is not empty. ` +
          "Move it aside or point repo.localPath at a fresh directory.",
      );
    }
  }

  if (!repo.url) {
    throw new Error(
      "repo.url is not configured; cannot clone. Run `arbella init` first.",
    );
  }

  // Ensure the parent directory exists so `git clone <url> <dest>` succeeds.
  await fs.ensureDir(path.dirname(localPath));
  log.step(`Cloning backup repo into ${localPath}`);
  await withRepoAuth(repo.url, auth, async (url, credentialed) => {
    await git.clone(url, localPath);
    // SECURITY: `git clone <token-url>` persists that URL as the `origin` remote
    // in .git/config — which would leave a token at rest in the repo. When we
    // cloned with an arbella-embedded credential, immediately rewrite `origin`
    // back to the clean URL so no token is ever stored. (Provider-CLI clones use
    // the clean URL already and need no scrub.)
    if (credentialed) {
      await git.setRemote(localPath, "origin", repo.url);
      log.debug("repo: scrubbed credential from origin remote after clone.");
    }
  });
}

/**
 * Pull the latest into an already-cloned backup repo, with the same gh/glab-first
 * auth retry as {@link ensureLocalClone}. A plain `git pull` uses whatever remote
 * URL is configured (typically the original, helper-authenticated one); on an auth
 * failure we sign in and retry by pulling explicitly from the resolved URL so a
 * private repo refreshes without the user pre-configuring credentials.
 *
 * `repo.url` is used for the auth retry's remote; when it is empty we just do a
 * plain pull (and let any auth error surface).
 */
export async function pullWithAuth(
  repo: RepoConfig,
  auth?: RepoAuthHooks,
): Promise<void> {
  if (!repo.url) {
    await git.pull(repo.localPath);
    return;
  }
  await withRepoAuth(repo.url, auth, async (url, credentialed) => {
    if (!credentialed) {
      // Original URL (provider CLI / public): a normal pull from origin.
      await git.pull(repo.localPath);
    } else {
      // Token-embedded URL (arbella fallback): pull explicitly from it so the
      // one-shot credential is used WITHOUT writing it into git config.
      await git.pullFrom(repo.localPath, url);
    }
  });
}

/**
 * Create the remote repo if missing and return the resolved RepoConfig (R11).
 *
 * Behavior:
 *  - Pick the provider; if its CLI is unavailable, fall back to the GENERIC
 *    provider (which resolves `name` to a URL verbatim and warns).
 *  - If the repo does not already exist (per `repoExists`), create it PRIVATE.
 *  - Resolve the final clone URL and return a RepoConfig pointing `localPath` at
 *    the requested path.
 *
 * Never prints tokens; only the resolved URL is logged at debug level.
 */
export async function ensureRemoteRepo(args: {
  provider: RepoProvider;
  name: string;
  localPath: string;
}): Promise<RepoConfig> {
  const { name, localPath } = args;
  let provider = getProvider(args.provider);

  if (!(await provider.isAvailable())) {
    if (provider.id !== "generic") {
      log.warn(
        `${provider.id} CLI not available; treating "${name}" as a generic ` +
          "remote URL (no auto-create).",
      );
    }
    provider = genericProvider;
  }

  let url: string;
  if (await provider.repoExists(name)) {
    log.debug(`Remote repo "${name}" already exists; resolving URL.`);
    url = await provider.resolveUrl(name);
  } else {
    log.step(`Creating private remote repo "${name}"`);
    url = await provider.createRepo(name, {
      private: true,
      description: "arbella backup of AI dev setup",
    });
  }

  log.debug(`Resolved backup repo clone URL for ${name}`);
  return {
    provider: provider.id,
    url,
    localPath,
  };
}

/**
 * Stage + commit + push the local working copy. Returns false when there was
 * nothing to commit (no changes) — in that case nothing is pushed.
 *
 * On the first push to a freshly-created remote there is no upstream yet, so we
 * detect "no upstream / no remote tracking" and retry with `-u origin <branch>`.
 * The commit `message` is supplied by the caller (commands own the clock).
 *
 * AUTH (P5): like clone/pull, the push is attempted as-is first (credential
 * helper / public access). On an auth failure, when `opts.url` is known,
 * {@link ensureRepoAuth} runs (gh/glab-first; install-on-demand or device-flow/
 * token fallback) and the push is retried — to `origin` when the provider CLI
 * configured git, or to a one-shot credential-embedded URL when arbella holds the
 * token (never written into `.git/config`). `opts.auth` carries the command
 * layer's interactive seams; without `opts.url` the push behaves exactly as
 * before (no auth retry).
 */
export async function commitAndPush(
  localPath: string,
  message: string,
  opts: { url?: string; auth?: RepoAuthHooks } = {},
): Promise<boolean> {
  await git.addAll(localPath);
  const committed = await git.commit(localPath, message);
  if (!committed) {
    log.debug("No changes to commit; skipping push.");
    return false;
  }

  // Decide whether we need to set upstream on this push: no remote yet, or a
  // remote exists but the current branch has no upstream tracking ref.
  let needUpstream = false;
  try {
    if (!(await git.hasRemote(localPath, "origin"))) {
      needUpstream = true;
    } else {
      needUpstream = !(await git.hasUpstream(localPath));
    }
  } catch {
    // If branch/remote probing fails for any reason, fall back to set-upstream.
    needUpstream = true;
  }

  // The push-to-origin attempt, with the existing set-upstream retry preserved.
  const pushToOrigin = async (): Promise<void> => {
    try {
      await git.push(localPath, { setUpstream: needUpstream });
    } catch (err) {
      // Retry once with explicit upstream — covers the "has no upstream branch"
      // case that some git versions only report at push time. (An auth failure is
      // re-thrown unchanged so the auth wrapper above can catch + handle it.)
      if (!needUpstream && !isAuthFailure(err)) {
        log.debug("Initial push failed; retrying with --set-upstream.");
        await git.push(localPath, { setUpstream: true });
      } else {
        throw err;
      }
    }
  };

  if (!opts.url) {
    // No URL to authenticate against — preserve the original behavior exactly.
    await pushToOrigin();
    return true;
  }

  // Auth-aware: first attempt pushes to origin; an auth failure triggers sign-in,
  // then either re-push to origin (provider CLI) or push to the token URL.
  await withRepoAuth(opts.url, opts.auth, async (url, credentialed) => {
    if (!credentialed) {
      await pushToOrigin();
    } else {
      // arbella-token path: push to the one-shot credential URL (no config write).
      await git.pushTo(localPath, url);
    }
  });
  return true;
}

/**
 * Changed paths of the local working copy vs the committed repo, for the
 * `status` command. Delegates to git porcelain status.
 */
export async function repoStatus(
  localPath: string,
): Promise<Array<{ path: string; status: string }>> {
  if (!(await git.isGitRepo(localPath))) {
    return [];
  }
  return git.status(localPath);
}
