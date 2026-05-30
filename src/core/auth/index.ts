/**
 * Provider-agnostic auth orchestration for arbella — the public surface the
 * commands + the repo layer consume.
 *
 * Goal (A1/A2): make arbella able to clone/push a PRIVATE backup repo over https
 * WITHOUT depending on `gh`/`glab`. It does so by obtaining an OAuth access
 * token (device flow) or a pasted Personal Access Token, caching it locally
 * (0600), and rewriting an https remote into an authenticated form
 * `https://oauth2:<token>@host/owner/repo.git` — WITHOUT ever mutating the
 * user's global git config.
 *
 * The headline export is {@link ensureRepoAuth}. Given a repo URL it returns an
 * {@link RepoAuth} describing whether auth is needed and, if so, a ready-to-use
 * authenticated URL. The repo layer (core/repo) calls it like this:
 *
 *     try {
 *       await git.clone(repo.url, dest);              // try unauthenticated
 *     } catch (err) {
 *       if (!isAuthFailure(err)) throw err;           // not an auth problem
 *       const auth = await ensureRepoAuth({ repoUrl: repo.url, interactive: true });
 *       if (!auth.authUrl) throw err;                 // nothing we can do
 *       await git.clone(auth.authUrl, dest);          // retry with creds
 *     }
 *
 * Public repos keep working: the contract is "try unauthenticated first, only
 * authenticate when access is actually required/denied". {@link ensureRepoAuth}
 * never forces auth on its own — callers decide when to invoke it (on failure,
 * or when a private repo is known up front via `requireAuth: true`).
 *
 * SECURITY (HARD):
 *   - A token is returned only inside {@link RepoAuth.authUrl} (in memory) and is
 *     cached only by the store (0600, arbella data dir). It is NEVER logged,
 *     printed, written to the repo / manifest / README / git history, or placed
 *     in a normal (non-debug) log line. The verification URL + user code printed
 *     during the device flow are NOT secrets.
 *   - {@link redactAuthUrl} is exported so callers can safely log an auth URL
 *     (it replaces the token with `oauth2:***`). Use it anywhere a URL might be
 *     surfaced.
 *
 * NETWORK: device flow uses the Node 18+ global `fetch` (no node-fetch).
 * USER OUTPUT: all human-facing lines go through src/utils/log.ts.
 * CLOCK: no clock here — callers may pass `createdAt`;
 * when omitted we still store a token but with an epoch timestamp, leaving the
 * authoritative "now" to the command layer (which supplies it).
 */

import { log } from "../../utils/log.js";
import type { DependencyId, InstallOutcome } from "../../platform/install.js";

import {
  cliForProvider,
  isProviderCliInstalled,
  providerCliAuthStatus,
  providerCliLogin,
  providerCliLogout,
  type CliAuthState,
  type ProviderCli,
} from "./cli.js";
import {
  DeviceFlowError,
  runDeviceFlow,
  type DeviceCodePrompt,
} from "./device-flow.js";
import {
  buildEndpoints,
  detectProvider,
  parseHost,
  providerHasClientId,
  type AuthProviderId,
  type AuthProviderSpec,
} from "./providers.js";
import {
  clearAllCredentials,
  deleteCredential,
  deleteCredentialsForProvider,
  getCredential,
  listCredentials,
  saveCredential,
  type CredentialInfo,
  type StoredCredential,
} from "./store.js";

/* -------------------------------------------------------------------------- */
/* Install-on-demand seam (provider CLI)                                        */
/* -------------------------------------------------------------------------- */

/**
 * The auth core never imports `@clack/prompts` and never calls the platform
 * installer directly — both are injected by the command layer so this module
 * stays UI- and side-effect-light and trivially testable. When a provider CLI
 * (gh/glab) is the preferred path but is MISSING, {@link ensureRepoAuth} uses
 * these two seams to (1) ask the user whether to install it and (2) install it.
 * When either seam is absent, the install-the-CLI branch is skipped and auth
 * degrades straight to the device-flow / token-paste fallback.
 */
export interface CliInstaller {
  /**
   * Ask the user to confirm installing the provider CLI. Resolve true to
   * install, false to decline (and fall back). `cli` carries the label/binary
   * for a friendly prompt.
   */
  confirm(args: { cli: ProviderCli; host: string }): Promise<boolean>;
  /**
   * Install the dependency (e.g. "gh"/"glab") via the platform installer.
   * Returns the platform {@link InstallOutcome} so the orchestrator can tell a
   * successful install from an unsupported/failed one.
   */
  install(dependency: DependencyId): Promise<InstallOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Interactive prompt seam                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The interactive token-paste prompt. The auth core does NOT import
 * `@clack/prompts` directly — the command layer injects a prompt function so
 * this module stays free of UI deps and trivially testable. When no prompter is
 * provided (non-interactive contexts: hooks, tests), the paste fallback is
 * skipped and auth resolves to "no credentials" rather than hanging on stdin.
 */
export interface TokenPaster {
  /**
   * Ask the user to paste a token. `hint` is a help line pointing at the
   * provider's PAT page. Resolve with the trimmed token, or `null` if the user
   * cancels / declines.
   */
  (args: { provider: AuthProviderSpec; host: string; hint: string }): Promise<
    string | null
  >;
}

/* -------------------------------------------------------------------------- */
/* ensureRepoAuth                                                              */
/* -------------------------------------------------------------------------- */

/** Inputs to {@link ensureRepoAuth}. */
export interface EnsureRepoAuthArgs {
  /** The backup repo URL (the host is parsed from it). */
  repoUrl: string;
  /**
   * When true, arbella WILL try to obtain a token now (use a stored one, else
   * run the device flow / token paste). When false, it only uses an already
   * stored token and never prompts — handy for a pre-flight check. Defaults to
   * true.
   */
  interactive?: boolean;
  /**
   * Force authentication even if the caller hasn't seen a failure yet (e.g. the
   * repo is known to be private). Purely advisory: it does not change behavior
   * beyond `interactive` — it exists so callers can express intent and so the
   * messaging is accurate. Defaults to false.
   */
  requireAuth?: boolean;
  /**
   * Optional client_id overrides (per provider) read from the arbella config by
   * the caller. Lets a configured client_id win over the env var without this
   * module importing the config schema.
   */
  clientIdOverrides?: Partial<Record<AuthProviderId, string>>;
  /**
   * Interactive token-paste prompter (injected by the command layer). When
   * absent, the paste fallback is unavailable (device flow may still run).
   */
  paste?: TokenPaster;
  /**
   * Provider-CLI install-on-demand seam (injected by the command layer). When
   * present and a preferred CLI (gh/glab) is missing, arbella offers to install
   * it (via `confirm` + `install`) before falling back to the device flow. When
   * absent, a missing CLI degrades straight to device-flow / token-paste.
   */
  installer?: CliInstaller;
  /**
   * Skip the provider-CLI (gh/glab) path entirely and go straight to arbella's
   * own device-flow / token-paste engine. Default false. Used by callers that
   * specifically want an arbella-held token (rare) or by tests.
   */
  preferDeviceFlow?: boolean;
  /** ISO timestamp to stamp a newly-stored token with (command layer owns the clock). */
  createdAt?: string;
}

/**
 * The outcome of an auth attempt for a repo URL.
 *
 *  - `needsAuth`     : false for hosts arbella cannot/should not inject creds
 *                      into (ssh, file://, generic non-https, unknown host with
 *                      no token path) — the caller should just use the original
 *                      URL.
 *  - `useProviderCli`: true when a provider CLI (gh/glab) is installed AND logged
 *                      in for the host. In that case git's credential helper is
 *                      already configured, so the caller should clone/push the
 *                      ORIGINAL url unchanged (there is no `authUrl` — and that is
 *                      the preferred, most secure outcome: no token touches
 *                      arbella). `cli` names the CLI that handled it.
 *  - `authUrl`       : when present, an https URL with an arbella-obtained token
 *                      embedded, safe to hand to `git clone/push`. Only produced
 *                      by the device-flow / token-paste fallback. Undefined when
 *                      the CLI path is used or no token is available.
 *  - `provider`      : the detected provider id, when one was matched.
 *  - `host`          : the parsed host, when one was found.
 *  - `source`        : how the token used here was obtained, when one was used.
 *  - `cli`           : the provider CLI binary ("gh"/"glab") when that path won.
 *  - `reason`        : a short, secret-free explanation (for debug logging).
 */
export interface RepoAuth {
  needsAuth: boolean;
  useProviderCli?: boolean;
  authUrl?: string;
  provider?: AuthProviderId;
  host?: string;
  source?: StoredCredential["source"];
  cli?: string;
  reason: string;
}

/**
 * Ensure (as far as possible) that arbella can authenticate to the host behind
 * `repoUrl`, returning a usable authenticated clone/push URL when it can.
 *
 * Flow (gh/glab-first, device-flow/token fallback):
 *   1. Parse the host. Only https(-style) remotes can carry credentials this way;
 *      ssh / file:// / scp-style / hostless URLs are returned untouched
 *      (`needsAuth: false`) so existing SSH + local remotes behave exactly as
 *      before.
 *   2. If an arbella-stored token already exists for the host -> build + return
 *      the auth URL (the user previously chose the fallback; honor it).
 *   3. PREFERRED — provider CLI (gh/glab), when the host maps to a known provider:
 *        a. CLI installed AND logged in  -> return `useProviderCli:true` with NO
 *           authUrl: git's credential helper is already wired, so the caller
 *           clones the original URL. Nothing sensitive flows through arbella.
 *        b. CLI installed but logged out -> (interactive) run `<cli> auth login`
 *           with inherited stdio; on success -> `useProviderCli:true`.
 *        c. CLI missing -> (interactive, installer injected) offer to install it;
 *           if accepted, install then login -> `useProviderCli:true`.
 *      Any non-success here falls through to step 4 rather than failing.
 *   4. FALLBACK — arbella's own engine: if not interactive, report "needs auth".
 *      Otherwise, if a real OAuth App client_id is configured for the provider,
 *      run the device flow; else (or on device-flow failure) use interactive
 *      token paste. Store the obtained token (0600) and return the auth URL.
 *   5. If everything is exhausted, return "needs auth" with no `authUrl`/CLI so
 *      the caller can surface a clear error.
 *
 * This function NEVER mutates global git config and NEVER logs a token.
 */
export async function ensureRepoAuth(args: EnsureRepoAuthArgs): Promise<RepoAuth> {
  const interactive = args.interactive ?? true;
  const host = parseHost(args.repoUrl);

  // (1) Non-https / hostless remotes: leave them exactly as-is.
  if (!host) {
    return {
      needsAuth: false,
      reason: "URL has no http(s) host (ssh/file/local remote); using it as-is.",
    };
  }
  if (!isHttpUrl(args.repoUrl)) {
    return {
      needsAuth: false,
      host,
      reason: "Non-https remote (ssh/scp-style); credential injection not applicable.",
    };
  }

  // (2) Honor an existing arbella-stored token (the user previously used the
  //     fallback for this host; don't second-guess it).
  const existing = await getCredential(host);
  if (existing) {
    log.debug(`auth: using stored credential for ${host} (no token logged).`);
    return {
      needsAuth: true,
      authUrl: buildAuthenticatedUrl(args.repoUrl, existing.token),
      provider: existing.provider,
      host,
      source: existing.source,
      reason: "Reused a stored token for this host.",
    };
  }

  const provider = detectProvider(host);

  // (3) PREFERRED: try the provider CLI (gh/glab) for a known provider.
  if (provider && !args.preferDeviceFlow) {
    const viaCli = await tryProviderCli({
      provider,
      host,
      interactive,
      installer: args.installer,
    });
    if (viaCli) {
      return viaCli;
    }
    // else: CLI unavailable / login declined / failed — fall through to fallback.
  }

  // (4) FALLBACK: non-interactive can't prompt; report and let the caller decide.
  if (!interactive) {
    return {
      needsAuth: true,
      host,
      ...(provider ? { provider: provider.id } : {}),
      reason:
        "No stored token, provider CLI unavailable, and non-interactive; " +
        "cannot obtain credentials now.",
    };
  }

  // arbella's own engine: device flow when a client_id is configured, else paste.
  const acquired = await acquireToken({
    host,
    provider,
    clientIdOverrides: args.clientIdOverrides,
    paste: args.paste,
    createdAt: args.createdAt,
    requireAuth: args.requireAuth ?? false,
  });

  if (!acquired) {
    return {
      needsAuth: true,
      host,
      ...(provider ? { provider: provider.id } : {}),
      reason:
        "Could not authenticate (provider CLI unavailable/declined, device flow " +
        "unavailable/declined, and no token pasted).",
    };
  }

  return {
    needsAuth: true,
    authUrl: buildAuthenticatedUrl(args.repoUrl, acquired.token),
    provider: acquired.provider,
    host,
    source: acquired.source,
    reason: `Obtained a new token via ${acquired.source}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Provider-CLI path (preferred)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Attempt to satisfy auth via the provider CLI (gh/glab). Returns a {@link
 * RepoAuth} with `useProviderCli:true` when the CLI ends up installed AND logged
 * in for the host (git is then ready, no token in arbella). Returns null when the
 * CLI route cannot be completed (not installed and not installed-on-demand, login
 * declined / failed), so the caller falls back to the device flow / token paste.
 *
 * Steps:
 *   - status check; if already authenticated -> done (best outcome).
 *   - if installed but logged out and interactive -> `<cli> auth login`.
 *   - if missing and interactive and an installer was injected -> confirm +
 *     install, then log in.
 */
async function tryProviderCli(args: {
  provider: AuthProviderSpec;
  host: string;
  interactive: boolean;
  installer?: CliInstaller;
}): Promise<RepoAuth | null> {
  const { provider, host, interactive, installer } = args;
  const cli = cliForProvider(provider.id);

  let state: CliAuthState = await providerCliAuthStatus(provider.id, host);

  // Best case: already logged in. git's credential helper is configured.
  if (state === "authenticated") {
    return cliAuthResult(provider.id, host, cli);
  }

  // CLI missing: offer install-on-demand (needs an interactive installer seam).
  if (state === "absent") {
    if (!interactive || !installer) {
      log.debug(
        `auth: ${cli.label} not installed and no interactive installer; ` +
          "falling back.",
      );
      return null;
    }
    const installed = await offerInstallCli({ cli, host, installer });
    if (!installed) {
      return null; // user declined / install failed -> fall back.
    }
    // Installed now but certainly logged out; continue to the login step.
    state = "not-authenticated";
  }

  // Installed but not logged in: run the interactive login (inherited stdio).
  if (!interactive) {
    log.debug(`auth: ${cli.label} present but not logged in (non-interactive).`);
    return null;
  }

  const ok = await providerCliLogin(provider.id, { host });
  if (!ok) {
    return null; // login cancelled/failed -> fall back to device flow / paste.
  }

  // Re-verify so we only claim success when the CLI truly authenticated.
  if (await isProviderCliAuthenticatedSafe(provider.id, host)) {
    return cliAuthResult(provider.id, host, cli);
  }
  log.debug(`auth: ${cli.label} login returned ok but status still not logged in.`);
  return null;
}

/** Offer to install the provider CLI, then install it. Returns true on success. */
async function offerInstallCli(args: {
  cli: ProviderCli;
  host: string;
  installer: CliInstaller;
}): Promise<boolean> {
  const { cli, host, installer } = args;
  let agreed = false;
  try {
    agreed = await installer.confirm({ cli, host });
  } catch (err) {
    log.debug(`auth: install confirmation failed: ${errMessage(err)}`);
    return false;
  }
  if (!agreed) {
    log.info(
      `Skipping ${cli.label} install; using arbella's own sign-in instead.`,
    );
    return false;
  }

  log.step(`Installing ${cli.label}…`);
  let outcome: InstallOutcome;
  try {
    outcome = await installer.install(cli.dependency);
  } catch (err) {
    log.warn(`Could not install ${cli.label}: ${errMessage(err)}`);
    return false;
  }
  if (outcome.status === "installed" || outcome.status === "already") {
    return true;
  }
  log.warn(
    `${cli.label} could not be installed (${outcome.status})` +
      (outcome.message ? `: ${outcome.message}` : "") +
      ". Falling back to arbella's own sign-in.",
  );
  return false;
}

/** Build the success RepoAuth for the provider-CLI path (no token involved). */
function cliAuthResult(
  provider: AuthProviderId,
  host: string,
  cli: ProviderCli,
): RepoAuth {
  log.debug(`auth: ${cli.label} is authenticated for ${host}; using its git creds.`);
  return {
    needsAuth: true,
    useProviderCli: true,
    provider,
    host,
    cli: cli.bin,
    reason: `Authenticated via ${cli.label}; git credential helper is configured.`,
  };
}

/** Status recheck that never throws (absence/error -> false). */
async function isProviderCliAuthenticatedSafe(
  provider: AuthProviderId,
  host: string,
): Promise<boolean> {
  try {
    return (await providerCliAuthStatus(provider, host)) === "authenticated";
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Token acquisition (device flow -> paste fallback)                          */
/* -------------------------------------------------------------------------- */

/** Internal: the token + how it was obtained, after a successful acquisition. */
interface AcquiredToken {
  token: string;
  provider: AuthProviderId;
  source: StoredCredential["source"];
}

/**
 * Acquire and STORE a token for `host`. Tries the device flow first when the
 * provider is known and a client_id is configured; otherwise (or if the device
 * flow fails for a non-fatal reason) falls back to interactive token paste.
 * Returns null when no token could be obtained.
 *
 * The chosen provider for storage is the detected one, or — for an unknown host
 * reached via paste — we still record a best-effort provider id ("github") only
 * as a label; it never affects URL building (which is provider-independent).
 */
async function acquireToken(args: {
  host: string;
  provider: AuthProviderSpec | undefined;
  clientIdOverrides?: Partial<Record<AuthProviderId, string>>;
  paste?: TokenPaster;
  createdAt?: string;
  requireAuth: boolean;
}): Promise<AcquiredToken | null> {
  const { host, provider } = args;

  // ---- Device flow (preferred) when runnable ------------------------------
  if (provider && providerHasClientId(provider, args.clientIdOverrides)) {
    try {
      const token = await loginViaDeviceFlow({
        provider,
        clientIdOverrides: args.clientIdOverrides,
      });
      const stored = await persist({
        host,
        provider: provider.id,
        token,
        source: "device-flow",
        createdAt: args.createdAt,
      });
      return { token: stored.token, provider: provider.id, source: "device-flow" };
    } catch (err) {
      // A hard refusal (the user denied) should not silently fall through to a
      // second prompt; everything else degrades to the paste fallback.
      if (err instanceof DeviceFlowError && err.code === "access_denied") {
        log.warn("Authorization was denied; no token was stored.");
        return null;
      }
      log.warn(
        `Device flow did not complete (${errMessage(err)}). ` +
          "Falling back to token paste.",
      );
      // fall through to paste
    }
  } else if (provider) {
    log.debug(
      `auth: no OAuth App client_id configured for ${provider.displayName}; ` +
        "using token paste (set the client_id env var to enable the device flow).",
    );
  }

  // ---- Interactive token paste (fallback / unknown host) ------------------
  if (!args.paste) {
    // No prompter available (non-interactive UI). Nothing more we can do.
    return null;
  }

  const spec = provider ?? guessSpecForPaste(host);
  const token = await args.paste({ provider: spec, host, hint: spec.patHint });
  if (token === null || token.trim() === "") {
    return null;
  }
  const stored = await persist({
    host,
    provider: spec.id,
    token: token.trim(),
    source: "token-paste",
    createdAt: args.createdAt,
  });
  return { token: stored.token, provider: spec.id, source: "token-paste" };
}

/**
 * Run the device flow for a provider and return the access token (in memory).
 * Prints the verification URL + user code via the logger (those are NOT
 * secrets). Throws {@link DeviceFlowError} on failure.
 */
async function loginViaDeviceFlow(args: {
  provider: AuthProviderSpec;
  clientIdOverrides?: Partial<Record<AuthProviderId, string>>;
}): Promise<string> {
  const endpoints = buildEndpoints(args.provider, args.clientIdOverrides);
  const result = await runDeviceFlow({
    endpoints,
    onPrompt: (prompt) => announcePrompt(args.provider, prompt),
    onPoll: ({ attempt }) =>
      log.debug(`auth: polling ${args.provider.displayName} for token (attempt ${attempt})…`),
  });
  return result.accessToken;
}

/** Print the device-flow instructions. Verification URL + user code are safe. */
function announcePrompt(provider: AuthProviderSpec, prompt: DeviceCodePrompt): void {
  log.info(`Authorize arbella with ${provider.displayName} to access your backup repo.`);
  log.step(`1. Open: ${prompt.verificationUri}`);
  log.step(`2. Enter the code: ${prompt.userCode}`);
  if (prompt.verificationUriComplete) {
    log.step(`   (or open this pre-filled link: ${prompt.verificationUriComplete})`);
  }
  log.step("Waiting for authorization… (this window will continue automatically)");
}

/** Persist an acquired token and return the normalized stored credential. */
async function persist(args: {
  host: string;
  provider: AuthProviderId;
  token: string;
  source: StoredCredential["source"];
  createdAt?: string;
}): Promise<StoredCredential> {
  const stored = await saveCredential({
    host: args.host,
    provider: args.provider,
    token: args.token,
    source: args.source,
    // Library purity: when the caller didn't supply a timestamp we record the
    // epoch rather than read the clock here; the command layer passes a real one.
    createdAt: args.createdAt ?? new Date(0).toISOString(),
  });
  log.success(`Stored a ${args.provider} token for ${args.host} (local, 0600).`);
  return stored;
}

/* -------------------------------------------------------------------------- */
/* Command helpers: login / status / logout                                    */
/* -------------------------------------------------------------------------- */

/** How an explicit `arbella auth login` was satisfied. */
export type LoginMethod = "provider-cli" | "device-flow" | "token-paste";

/** Result of an explicit `auth login`. */
export interface LoginResult {
  host: string;
  provider: AuthProviderId;
  /** Which mechanism logged the user in. */
  method: LoginMethod;
  /**
   * For the fallback paths, how the arbella-stored token was obtained. Absent
   * when the provider CLI handled it (arbella stored nothing).
   */
  source?: StoredCredential["source"];
}

/**
 * Explicit login for `arbella auth login [--provider]` (P4). PREFERS the provider
 * CLI: if gh/glab is installed it runs `<cli> auth login` (installing it first
 * when an installer is injected and the user agrees); only if the CLI is
 * unavailable / declined does it fall back to arbella's device flow or token
 * paste. Authenticates against the provider's canonical host (github.com /
 * gitlab.com). Returns the login result, or null if nothing was obtained.
 */
export async function login(args: {
  provider: AuthProviderSpec;
  clientIdOverrides?: Partial<Record<AuthProviderId, string>>;
  paste?: TokenPaster;
  installer?: CliInstaller;
  /** Skip the provider CLI and force arbella's own engine. Default false. */
  preferDeviceFlow?: boolean;
  createdAt?: string;
}): Promise<LoginResult | null> {
  const host = args.provider.host;

  // Preferred: the provider CLI.
  if (!args.preferDeviceFlow) {
    const viaCli = await tryProviderCli({
      provider: args.provider,
      host,
      interactive: true,
      installer: args.installer,
    });
    if (viaCli?.useProviderCli) {
      return { host, provider: args.provider.id, method: "provider-cli" };
    }
  }

  // Fallback: arbella's own device flow / token paste.
  const acquired = await acquireToken({
    host,
    provider: args.provider,
    clientIdOverrides: args.clientIdOverrides,
    paste: args.paste,
    createdAt: args.createdAt,
    requireAuth: true,
  });
  if (!acquired) return null;
  return {
    host,
    provider: acquired.provider,
    method: acquired.source === "device-flow" ? "device-flow" : "token-paste",
    source: acquired.source,
  };
}

/** Login state for one provider, combining its CLI and arbella's own store. */
export interface ProviderAuthStatus {
  provider: AuthProviderId;
  /** Whether the provider CLI is installed. */
  cliInstalled: boolean;
  /** The CLI's login state ("absent" when not installed). */
  cliState: CliAuthState;
  /** The provider CLI binary name ("gh"/"glab"). */
  cli: string;
}

/**
 * Per-provider auth status for `arbella auth status` (P4), reflecting the
 * gh/glab-first model: it reports each provider CLI's install + login state.
 * arbella-held tokens (the fallback) are reported separately via {@link status}.
 * Secret-free: only install/login booleans + provider labels.
 */
export async function providerStatuses(): Promise<ProviderAuthStatus[]> {
  const out: ProviderAuthStatus[] = [];
  for (const id of ["github", "gitlab"] as AuthProviderId[]) {
    const cli = cliForProvider(id);
    const cliInstalled = await isProviderCliInstalled(id);
    const cliState = cliInstalled
      ? await providerCliAuthStatus(id)
      : ("absent" as CliAuthState);
    out.push({ provider: id, cliInstalled, cliState, cli: cli.bin });
  }
  return out;
}

/**
 * List arbella-STORED credentials as SECRET-FREE info for `arbella auth status`.
 * These exist only when the device-flow / token-paste fallback was used; the
 * token is reduced to a masked hint. (Provider-CLI logins are NOT here — they
 * live in gh/glab's own stores; see {@link providerStatuses}.)
 */
export async function status(): Promise<CredentialInfo[]> {
  return listCredentials();
}

/**
 * Log out for `arbella auth logout [--provider]` (P4). Clears BOTH surfaces:
 *   - arbella's own stored token(s) for the provider(s), and
 *   - the provider CLI's login (`<cli> auth logout`) when the CLI is present and
 *     a single provider was specified (a no-provider logout does not touch the
 *     CLIs — that would be surprising; it only clears arbella's own store).
 *
 * Returns the number of arbella-stored host credentials removed. The CLI logout
 * is best-effort and reported via logs (gh/glab manage their own state).
 */
export async function logout(provider?: AuthProviderId): Promise<number> {
  if (provider === undefined) {
    return clearAllCredentials();
  }
  // Also sign out of the provider CLI when present (best-effort).
  if (await isProviderCliInstalled(provider)) {
    await providerCliLogout(provider);
  }
  return deleteCredentialsForProvider(provider);
}

/** Remove the credential for an exact host (used by tests / advanced callers). */
export async function logoutHost(host: string): Promise<boolean> {
  return deleteCredential(host);
}

/* -------------------------------------------------------------------------- */
/* URL building + redaction                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rewrite an https repo URL into an authenticated form that embeds `token` as
 * the password of the `oauth2` user: `https://oauth2:<token>@host/owner/repo.git`.
 * Works for both GitHub and GitLab (both accept `oauth2:<token>` basic auth over
 * https). Any pre-existing userinfo in the URL is replaced.
 *
 * The token is URL-encoded so a token containing reserved characters can't break
 * the URL. Non-https URLs are returned unchanged (we never inject creds into ssh
 * or file remotes). This builds an in-memory URL only — it does not touch git
 * config.
 */
export function buildAuthenticatedUrl(repoUrl: string, token: string): string {
  if (!isHttpUrl(repoUrl)) return repoUrl;
  let u: URL;
  try {
    u = new URL(repoUrl.trim());
  } catch {
    return repoUrl;
  }
  u.username = "oauth2";
  u.password = encodeURIComponent(token);
  return u.toString();
}

/**
 * Redact the credentials out of an https URL for safe logging:
 * `https://oauth2:***@host/owner/repo.git`. Use this anywhere an auth URL might
 * be printed. Non-https or unparseable URLs are returned unchanged (they carry
 * no embedded token to leak).
 */
export function redactAuthUrl(url: string): string {
  if (!isHttpUrl(url)) return url;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username || "oauth2";
      u.password = "***";
    }
    return u.toString();
  } catch {
    return url;
  }
}

/* -------------------------------------------------------------------------- */
/* Auth-failure classification (so the repo layer can decide to retry)         */
/* -------------------------------------------------------------------------- */

/**
 * Heuristically decide whether a thrown error from a git clone/push/pull is an
 * AUTHENTICATION/authorization failure (so the caller should obtain creds and
 * retry) versus an unrelated error (which must propagate).
 *
 * Git itself does not give a stable machine code for this, so we inspect the
 * combined stderr/message text for the well-known phrases GitHub/GitLab/git emit
 * on a private-repo access denial or a missing credential. We deliberately treat
 * "repository not found" as an auth signal too: GitHub returns a 404 (not a 403)
 * for a private repo the caller can't see, so a not-found over https is, in
 * practice, usually a permissions problem worth one authenticated retry.
 *
 * This reads ONLY error metadata (message/stderr) and returns a boolean; it
 * never logs and never touches the token.
 */
export function isAuthFailure(err: unknown): boolean {
  const text = extractErrorText(err).toLowerCase();
  if (text === "") return false;

  // Strong, unambiguous auth signals.
  const authPhrases = [
    "authentication failed",
    "authorization failed",
    "could not read username",
    "could not read password",
    "terminal prompts disabled",
    "invalid username or password",
    "permission denied",
    "403 forbidden",
    "401 unauthorized",
    // git/curl smart-HTTP phrasing for a rejected request, e.g.
    // "fatal: unable to access '…': The requested URL returned error: 403".
    "returned error: 401",
    "returned error: 403",
    "error: 401",
    "error: 403",
    "access denied",
    "remote: invalid credentials",
    "remote: not authorized",
    "fatal: unable to access",
    "support for password authentication was removed",
  ];
  for (const phrase of authPhrases) {
    if (text.includes(phrase)) return true;
  }

  // "Repository not found" over https is usually a private-repo permission
  // problem (GitHub masks 403 as 404). Treat it as an auth signal so we retry
  // with credentials exactly once.
  if (
    text.includes("repository not found") ||
    (text.includes("not found") && text.includes("fatal:")) ||
    text.includes("the requested url returned error: 404")
  ) {
    return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/** True for an http/https URL (the only remotes we inject credentials into). */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * For an unknown host reached via token paste, synthesize a minimal provider
 * spec so the paste prompt + storage have a label + a sensible PAT hint. The id
 * defaults to "github" (most common) but is purely a label; URL building is
 * provider-independent.
 */
function guessSpecForPaste(host: string): AuthProviderSpec {
  return {
    id: "github",
    displayName: host,
    host,
    deviceCodeUrl: "",
    tokenUrl: "",
    scope: "",
    clientIdEnvVar: "",
    patHelpUrl: `https://${host}`,
    patHint:
      `Paste a personal access token for ${host} with permission to read and ` +
      "write the backup repository over https.",
  };
}

/** Pull a usable text blob out of an unknown thrown value (message + stderr). */
function extractErrorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    const anyErr = err as { stderr?: unknown; stdout?: unknown; shortMessage?: unknown };
    if (typeof anyErr.stderr === "string") parts.push(anyErr.stderr);
    if (typeof anyErr.stdout === "string") parts.push(anyErr.stdout);
    if (typeof anyErr.shortMessage === "string") parts.push(anyErr.shortMessage);
    return parts.join("\n");
  }
  // Plain object with execa-like fields.
  const o = err as { message?: unknown; stderr?: unknown; shortMessage?: unknown };
  const parts: string[] = [];
  if (typeof o.message === "string") parts.push(o.message);
  if (typeof o.stderr === "string") parts.push(o.stderr);
  if (typeof o.shortMessage === "string") parts.push(o.shortMessage);
  return parts.length > 0 ? parts.join("\n") : String(err);
}

/** Best-effort message extraction from an unknown thrown value (secret-free). */
function errMessage(err: unknown): string {
  if (err instanceof DeviceFlowError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------------- */
/* Re-exports for the command layer                                            */
/* -------------------------------------------------------------------------- */

export {
  detectProvider,
  parseHost,
  providerById,
  providerHasClientId,
  resolveClientId,
  AUTH_PROVIDER_SPECS,
  PLACEHOLDER_CLIENT_ID,
  type AuthProviderId,
  type AuthProviderSpec,
} from "./providers.js";

export {
  credentialsPath,
  getCredential,
  hasCredential,
  listCredentials,
  type CredentialInfo,
  type StoredCredential,
  type CredentialSource,
} from "./store.js";

export {
  DeviceFlowError,
  runDeviceFlow,
  type DeviceFlowToken,
  type DeviceCodePrompt,
  type DeviceFlowEndpoints,
} from "./device-flow.js";

export {
  cliForProvider,
  isProviderCliInstalled,
  isProviderCliAuthenticated,
  providerCliAuthStatus,
  providerCliLogin,
  providerCliLogout,
  type ProviderCli,
  type CliAuthState,
  type ProviderLoginOptions,
} from "./cli.js";
