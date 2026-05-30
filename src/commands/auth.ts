/**
 * `arbella auth login | status | logout` — manage backup-repo authentication (P4).
 *
 * arbella is gh/glab-FIRST: for a known provider it prefers the official CLI
 * (`gh auth login` / `glab auth login`), which handles OAuth itself and wires up
 * git's credential helper so clones/pushes "just work". Only when the CLI is
 * missing (and the user declines to install it) or unavailable does arbella fall
 * back to its own RFC 8628 device flow or an interactive Personal-Access-Token
 * paste. All of that orchestration lives in `core/auth`; this command is the thin
 * UI shell that:
 *   - injects the interactive seams the auth core needs but must not import
 *     itself: a @clack password prompt (token paste) and a @clack confirm +
 *     platform installer (install gh/glab on demand);
 *   - owns the clock (passes `createdAt` inward for any stored token);
 *   - renders human status / outcome lines.
 *
 * Subcommands:
 *   login   [--provider github|gitlab] [--device-flow]
 *           Sign in to a provider. Defaults to GitHub. `--device-flow` skips the
 *           provider CLI and forces arbella's own device-flow/token path.
 *   status  Show, per provider, whether its CLI is installed + logged in, plus any
 *           arbella-held fallback tokens (metadata only — never a token value).
 *   logout  [--provider github|gitlab]
 *           Sign out. With a provider: clears arbella's stored token for it AND
 *           runs the provider CLI's logout. Without: clears ALL arbella-stored
 *           tokens (leaves the CLIs alone).
 *
 * SECURITY (HARD): this command never prints a token. The device-flow URL + user
 * code and a provider login username/host are NOT secrets and may be shown; the
 * token itself only ever lives in gh/glab's own store or arbella's 0600 store.
 */

import { confirm, isCancel, password } from "@clack/prompts";
import type { Command } from "commander";

import { log } from "../utils/log.js";
import { install, type DependencyId, type InstallOutcome } from "../platform/install.js";
import {
  login as authLogin,
  logout as authLogout,
  providerStatuses,
  status as storedCredentials,
  providerById,
  type AuthProviderId,
  type AuthProviderSpec,
  type CliInstaller,
  type ProviderCli,
  type TokenPaster,
} from "../core/auth/index.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** Flags for `arbella auth login`. */
export interface AuthLoginOptions {
  /** Which provider to sign in to ("github" | "gitlab"). Default "github". */
  provider?: string;
  /** Skip the provider CLI and force arbella's device-flow / token paste. */
  deviceFlow?: boolean;
}

/** Flags for `arbella auth logout`. */
export interface AuthLogoutOptions {
  /** Limit logout to this provider; omit to clear ALL arbella-stored tokens. */
  provider?: string;
}

/** Flags for `arbella auth status`. */
export interface AuthStatusOptions {
  /** Emit machine-readable JSON to stdout instead of a human table. */
  json?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Injected seams (so core/auth stays UI-free)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The token-paste prompt the auth core invokes when it falls back to a PAT. Uses
 * @clack's masked `password` input and points the user at the provider's token
 * page. Returns the trimmed token, or null on cancel / empty.
 */
const tokenPaster: TokenPaster = async ({ provider, host, hint }) => {
  log.info(`Paste a Personal Access Token for ${host}.`);
  if (provider.patHelpUrl) {
    log.step(`Create one here: ${provider.patHelpUrl}`);
  }
  log.step(hint);
  const value = await password({
    message: `${provider.displayName} token (input hidden):`,
    validate: (v) => (v && v.trim() !== "" ? undefined : "Enter a token, or Esc to cancel."),
  });
  if (isCancel(value)) return null;
  const token = String(value).trim();
  return token === "" ? null : token;
};

/**
 * The install-on-demand seam the auth core uses when a preferred provider CLI is
 * missing. Confirms with the user, then installs via the platform layer.
 */
const cliInstaller: CliInstaller = {
  async confirm({ cli, host }: { cli: ProviderCli; host: string }): Promise<boolean> {
    const answer = await confirm({
      message:
        `${cli.label} is not installed. It is the easiest way to sign in to ` +
        `${host} (it handles the login for you). Install it now?`,
      initialValue: true,
    });
    if (isCancel(answer)) return false;
    return answer === true;
  },
  async install(dependency: DependencyId): Promise<InstallOutcome> {
    return install(dependency);
  },
};

/* -------------------------------------------------------------------------- */
/* commander registration                                                      */
/* -------------------------------------------------------------------------- */

/** Attach the `auth` command group (login/status/logout) to the program. */
export function register(program: Command): void {
  const auth = program
    .command("auth")
    .description(
      "Manage backup-repo authentication. Prefers the GitHub/GitLab CLI " +
        "(gh/glab); falls back to arbella's device-flow or a token paste.",
    );

  auth
    .command("login")
    .description("Sign in to a provider (GitHub or GitLab) for private-repo access.")
    .option("--provider <provider>", "provider to sign in to: github | gitlab")
    .option(
      "--device-flow",
      "skip the gh/glab CLI and use arbella's own device-flow / token paste",
    )
    .action(async (opts: AuthLoginOptions) => {
      await runLogin(opts);
    });

  auth
    .command("status")
    .description("Show provider CLI sign-in state and any arbella-held tokens.")
    .option("--json", "print machine-readable JSON to stdout")
    .action(async (opts: AuthStatusOptions) => {
      await runStatus(opts);
    });

  auth
    .command("logout")
    .description(
      "Sign out. With --provider, also runs the provider CLI's logout; without " +
        "it, clears all arbella-stored tokens.",
    )
    .option("--provider <provider>", "provider to sign out of: github | gitlab")
    .action(async (opts: AuthLogoutOptions) => {
      await runLogout(opts);
    });
}

/* -------------------------------------------------------------------------- */
/* login                                                                       */
/* -------------------------------------------------------------------------- */

/** Execute `arbella auth login`. Directly callable (for tests). */
export async function runLogin(opts: AuthLoginOptions): Promise<void> {
  const provider = resolveProviderSpec(opts.provider) ?? providerById("github");

  log.info(`Signing in to ${provider.displayName}…`);
  const result = await authLogin({
    provider,
    paste: tokenPaster,
    installer: cliInstaller,
    preferDeviceFlow: opts.deviceFlow === true,
    createdAt: new Date().toISOString(),
  });

  if (!result) {
    throw new Error(
      `Could not sign in to ${provider.displayName}. ` +
        "No provider CLI completed the login and no token was provided. " +
        `Install ${provider.id === "github" ? "gh" : "glab"} ` +
        "(`arbella setup`) or re-run and paste a token.",
    );
  }

  switch (result.method) {
    case "provider-cli":
      log.success(
        `Signed in to ${provider.displayName} via its CLI — git is configured ` +
          "to use it; private clone/push will work.",
      );
      break;
    case "device-flow":
      log.success(
        `Signed in to ${provider.displayName} via arbella's device flow ` +
          "(token stored locally, 0600).",
      );
      break;
    case "token-paste":
      log.success(
        `Stored your ${provider.displayName} token locally (0600). ` +
          "arbella will use it for private clone/push.",
      );
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* status                                                                      */
/* -------------------------------------------------------------------------- */

/** Execute `arbella auth status`. Directly callable (for tests). */
export async function runStatus(opts: AuthStatusOptions): Promise<void> {
  const providers = await providerStatuses();
  const stored = await storedCredentials();

  if (opts.json) {
    // Machine-readable: ONLY metadata. Token values are never present here.
    const payload = {
      providers: providers.map((p) => ({
        provider: p.provider,
        cli: p.cli,
        cliInstalled: p.cliInstalled,
        cliState: p.cliState,
      })),
      storedTokens: stored.map((c) => ({
        host: c.host,
        provider: c.provider,
        source: c.source,
        createdAt: c.createdAt,
        scope: c.scope ?? null,
        tokenHint: c.tokenHint,
        hasRefreshToken: c.hasRefreshToken,
      })),
    };
    // Data payload goes to stdout (logger writes to stderr).
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  log.info("Provider CLI sign-in state:");
  for (const p of providers) {
    const spec = providerById(p.provider);
    if (!p.cliInstalled) {
      log.step(`${spec.displayName}: ${p.cli} not installed (run \`arbella setup\`).`);
      continue;
    }
    switch (p.cliState) {
      case "authenticated":
        log.step(`${spec.displayName}: ${p.cli} installed and signed in. ✓`);
        break;
      case "not-authenticated":
        log.step(
          `${spec.displayName}: ${p.cli} installed but NOT signed in ` +
            `(run \`arbella auth login --provider ${p.provider}\`).`,
        );
        break;
      default:
        log.step(`${spec.displayName}: ${p.cli} installed; sign-in state unknown.`);
        break;
    }
  }

  if (stored.length === 0) {
    log.info("No arbella-stored tokens (the gh/glab CLI handles sign-in, or none yet).");
    return;
  }
  log.info("arbella-stored tokens (fallback; metadata only):");
  for (const c of stored) {
    log.step(
      `${c.host} · ${c.provider} · via ${c.source} · token ${c.tokenHint} · ` +
        `since ${c.createdAt}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* logout                                                                      */
/* -------------------------------------------------------------------------- */

/** Execute `arbella auth logout`. Directly callable (for tests). */
export async function runLogout(opts: AuthLogoutOptions): Promise<void> {
  const provider = opts.provider
    ? resolveProviderSpec(opts.provider)
    : undefined;

  if (opts.provider && !provider) {
    throw new Error(
      `Unknown provider "${opts.provider}". Use "github" or "gitlab".`,
    );
  }

  const removed = await authLogout(provider?.id);

  if (provider) {
    log.success(
      `Signed out of ${provider.displayName}` +
        (removed > 0 ? ` and cleared ${removed} stored token(s).` : "."),
    );
  } else if (removed > 0) {
    log.success(`Cleared ${removed} arbella-stored token(s).`);
  } else {
    log.info("No arbella-stored tokens to clear.");
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a `--provider` flag into a provider spec. Accepts "github"/"gitlab"
 * (case-insensitive); returns undefined for anything else so the caller can
 * error or default as appropriate.
 */
function resolveProviderSpec(raw: string | undefined): AuthProviderSpec | undefined {
  if (!raw) return undefined;
  const id = raw.trim().toLowerCase();
  if (id === "github" || id === "gitlab") {
    return providerById(id as AuthProviderId);
  }
  return undefined;
}

export default runLogin;
