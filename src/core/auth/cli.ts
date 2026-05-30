/**
 * Provider-CLI bridge: arbella's PREFERRED authentication path.
 *
 * The plug-&-play promise (the auth task) is that the user does not care *how*
 * they get authenticated — they just want a private clone/push to work. The
 * smoothest way to deliver that is to let the official provider CLIs do the job
 * they already do well:
 *
 *   - GitHub: `gh auth status` / `gh auth login`
 *   - GitLab: `glab auth status` / `glab auth login`
 *
 * When `gh`/`glab` is present and logged in, it has ALREADY configured git's
 * credential helper, so a plain `git clone <https-url>` succeeds with no token
 * handling on arbella's side at all. That is strictly better than arbella
 * minting and embedding its own token: nothing sensitive ever flows through
 * arbella, and the user's existing login is reused. So `core/auth/index.ts`
 * tries THIS module first and only falls back to the device-flow / token-paste
 * engine (the rest of core/auth) when the CLI is missing and the user declines
 * to install it (or it is unavailable for the host).
 *
 * What this module does:
 *   - map an {@link AuthProviderId} ("github"/"gitlab") to its CLI binary +
 *     the {@link DependencyId} the platform installer knows ("gh"/"glab");
 *   - detect whether the CLI is installed (PATH probe, via the platform layer);
 *   - read login state with `<cli> auth status` (NON-interactive, captured);
 *   - run `<cli> auth login` with **inherited stdio** so the user completes the
 *     browser / device login in their own terminal (the CLI prints the URL +
 *     one-time code itself; arbella does not intermediate it);
 *   - run `<cli> auth logout` for `arbella auth logout`.
 *
 * SECURITY (HARD): this module never reads, prints, stores, or transports any
 * token. `gh`/`glab` keep their own credentials in their own stores; arbella's
 * 0600 credential store (store.ts) is used ONLY for tokens arbella itself
 * obtains via the device-flow / paste fallback — never for anything the CLI
 * holds. `auth status` output can include a username/host (not a secret) and is
 * surfaced only at debug volume; its stderr is never echoed verbatim to the
 * user (it can be noisy and occasionally embeds a token hint).
 *
 * NO CLOCK / NO FS here — this module only spawns the provider CLIs (via execa)
 * and reads the platform install layer. All human-facing lines go through
 * src/utils/log.ts.
 */

import { execa } from "execa";

import { log } from "../../utils/log.js";
import { isInstalled, type DependencyId } from "../../platform/install.js";

import type { AuthProviderId } from "./providers.js";

/* -------------------------------------------------------------------------- */
/* Provider <-> CLI mapping                                                     */
/* -------------------------------------------------------------------------- */

/** Static description of a provider's official CLI. */
export interface ProviderCli {
  /** The OAuth provider this CLI authenticates. */
  readonly provider: AuthProviderId;
  /** The executable name probed on PATH and spawned ("gh" / "glab"). */
  readonly bin: string;
  /** The dependency id the platform installer uses to install it ("gh"/"glab"). */
  readonly dependency: DependencyId;
  /** Human label for prompts/logs ("GitHub CLI (gh)"). */
  readonly label: string;
}

/** GitHub's `gh` CLI descriptor. */
const GH_CLI: ProviderCli = {
  provider: "github",
  bin: "gh",
  dependency: "gh",
  label: "GitHub CLI (gh)",
};

/** GitLab's `glab` CLI descriptor. */
const GLAB_CLI: ProviderCli = {
  provider: "gitlab",
  bin: "glab",
  dependency: "glab",
  label: "GitLab CLI (glab)",
};

/** All provider CLIs, keyed by provider id. */
const CLI_BY_PROVIDER: Readonly<Record<AuthProviderId, ProviderCli>> = {
  github: GH_CLI,
  gitlab: GLAB_CLI,
};

/** Resolve the CLI descriptor for a provider id. */
export function cliForProvider(provider: AuthProviderId): ProviderCli {
  return CLI_BY_PROVIDER[provider];
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * True if the provider's CLI binary resolves on PATH. Thin wrapper over the
 * platform install layer's {@link isInstalled} keyed by the CLI's dependency id,
 * so detection stays consistent with `arbella setup`. Never throws (absence is a
 * boolean, not an error).
 */
export async function isProviderCliInstalled(
  provider: AuthProviderId,
): Promise<boolean> {
  return isInstalled(cliForProvider(provider).dependency);
}

/* -------------------------------------------------------------------------- */
/* Login state                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The login state of a provider CLI for (optionally) a specific host.
 *   - "absent"            : the CLI is not installed.
 *   - "authenticated"     : `<cli> auth status` reports an active login.
 *   - "not-authenticated" : the CLI is installed but not logged in (for the host).
 *   - "unknown"           : the status probe could not be classified (treated by
 *                           callers like "not-authenticated" — they will offer a
 *                           login rather than assume success).
 */
export type CliAuthState =
  | "absent"
  | "authenticated"
  | "not-authenticated"
  | "unknown";

/**
 * Read whether the provider CLI is logged in, via `<cli> auth status`.
 *
 * Both `gh` and `glab` exit 0 when authenticated and non-zero when not, and
 * print their human report to STDERR. We run non-interactively (stdin ignored,
 * output captured) and classify by exit code first, then fall back to scanning
 * the combined output for the well-known "Logged in" / "not logged" phrasing so
 * a future exit-code change still resolves sensibly.
 *
 * `host` narrows the check to a specific hostname when given (`gh auth status
 * --hostname <h>` / `glab auth status --hostname <h>`), which matters for
 * self-hosted GitHub Enterprise / GitLab instances. The CLI output is NOT echoed
 * to the user (it can be noisy); only a debug-level classification is logged.
 */
export async function providerCliAuthStatus(
  provider: AuthProviderId,
  host?: string,
): Promise<CliAuthState> {
  const cli = cliForProvider(provider);
  if (!(await isProviderCliInstalled(provider))) {
    return "absent";
  }

  const args = ["auth", "status"];
  if (host && host.trim() !== "") {
    args.push("--hostname", host.trim());
  }

  let exitCode = 1;
  let combined = "";
  try {
    const res = await execa(cli.bin, args, {
      reject: false, // exit code is the signal; never throw on "not logged in".
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    exitCode = typeof res.exitCode === "number" ? res.exitCode : 1;
    combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  } catch (err) {
    // Spawn failure (CLI vanished between the probe and here, timeout, …): treat
    // as "unknown" so the caller offers a login rather than trusting a bad probe.
    log.debug(`auth: ${cli.bin} auth status could not run: ${errMessage(err)}`);
    return "unknown";
  }

  if (exitCode === 0) {
    log.debug(`auth: ${cli.bin} reports an active login${host ? ` for ${host}` : ""}.`);
    return "authenticated";
  }

  // Non-zero: usually "not logged in", but classify defensively from the text so
  // we don't misread an unrelated error as a clean "logged out".
  const text = combined.toLowerCase();
  if (text.includes("logged in") && !text.includes("not logged in")) {
    // Some `gh` versions exit non-zero when only SOME configured hosts are
    // logged in, while still reporting the one we asked about as logged in.
    return "authenticated";
  }
  if (
    text.includes("not logged in") ||
    text.includes("no accounts") ||
    text.includes("you are not logged") ||
    text.includes("not authenticated")
  ) {
    return "not-authenticated";
  }
  log.debug(
    `auth: ${cli.bin} auth status exited ${exitCode} with an unrecognized report.`,
  );
  return "unknown";
}

/** Convenience: is the provider CLI installed AND logged in (for `host`)? */
export async function isProviderCliAuthenticated(
  provider: AuthProviderId,
  host?: string,
): Promise<boolean> {
  return (await providerCliAuthStatus(provider, host)) === "authenticated";
}

/* -------------------------------------------------------------------------- */
/* Login (interactive, inherited stdio)                                         */
/* -------------------------------------------------------------------------- */

/** Options for {@link providerCliLogin}. */
export interface ProviderLoginOptions {
  /**
   * Restrict the login to a specific host (GitHub Enterprise / self-hosted
   * GitLab). When omitted the CLI uses its default host (github.com / gitlab.com).
   */
  host?: string;
  /**
   * Ask the CLI to also set up git to use it as a credential helper, so a later
   * `git clone`/`push` over https just works. `gh` does this by default during
   * `auth login`; `glab` configures the git credential helper on login too. We
   * pass the explicit flags where supported to be deterministic. Default true.
   */
  configureGit?: boolean;
}

/**
 * Run `<cli> auth login` with **inherited stdio** so the user completes the
 * interactive browser / device-code login directly in their terminal.
 *
 * This is the crux of the "plug & play" flow: arbella does NOT scrape, proxy, or
 * re-implement the OAuth dance — it hands control to `gh`/`glab`, which print the
 * verification URL + one-time code, open the browser if they can, wait for the
 * user, and on success store their own credentials AND wire up git's credential
 * helper. When it returns successfully, a plain clone of the https URL works.
 *
 * Returns true on a successful (exit 0) login, false otherwise. Never throws on
 * a normal "the user aborted / login failed" — the caller decides whether to
 * fall back to arbella's device flow. A genuine inability to spawn the CLI
 * (missing binary) returns false after a clear warning.
 *
 * SECURITY: with inherited stdio, the token the CLI obtains goes straight into
 * the CLI's own store and never passes through arbella; arbella sees only the
 * process exit code.
 */
export async function providerCliLogin(
  provider: AuthProviderId,
  opts: ProviderLoginOptions = {},
): Promise<boolean> {
  const cli = cliForProvider(provider);
  if (!(await isProviderCliInstalled(provider))) {
    log.warn(`${cli.label} is not installed; cannot run \`${cli.bin} auth login\`.`);
    return false;
  }

  const args = buildLoginArgs(cli, opts);

  log.info(
    `Signing in with ${cli.label}. Follow the prompts in your terminal — ` +
      `${cli.bin} will open a browser or show a one-time code.`,
  );
  log.step(`Running: ${cli.bin} ${args.join(" ")}`);

  try {
    await execa(cli.bin, args, {
      // INHERITED stdio: the user interacts with gh/glab directly. This is the
      // whole point — arbella steps out of the way for the actual login.
      stdio: "inherit",
      // A human is in the loop (browser, code entry); allow plenty of time.
      timeout: 10 * 60_000,
    });
    log.success(`${cli.label}: signed in.`);
    return true;
  } catch (err) {
    // Non-zero exit (user cancelled, network problem, declined scopes, …). Not
    // fatal: report and let the orchestrator fall back to the device flow.
    log.warn(
      `${cli.label} login did not complete (${errMessage(err)}). ` +
        "Falling back to arbella's own sign-in if available.",
    );
    return false;
  }
}

/** Build the provider-specific `auth login` argv (host + git-credential setup). */
function buildLoginArgs(cli: ProviderCli, opts: ProviderLoginOptions): string[] {
  const configureGit = opts.configureGit ?? true;
  const args = ["auth", "login"];

  if (opts.host && opts.host.trim() !== "") {
    args.push("--hostname", opts.host.trim());
  }

  if (cli.provider === "github") {
    // `gh` over https + git-credential setup so `git clone`/`push` just work.
    // `--web` triggers the browser/device-code flow without needing a pasted PAT.
    if (configureGit) {
      args.push("--git-protocol", "https");
    }
    args.push("--web");
  } else {
    // `glab auth login` is interactive by default; `--stdin` would expect a piped
    // token, which we explicitly do NOT do (the user logs in via the browser).
    // It configures the git credential helper as part of login.
    // (No extra flags needed; inherited stdio drives the interactive prompts.)
  }

  return args;
}

/* -------------------------------------------------------------------------- */
/* Logout                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Run `<cli> auth logout` for `arbella auth logout`. With inherited stdio so the
 * CLI can confirm interactively if it wants to (and to surface a host picker on
 * `gh` when multiple hosts are configured). Returns true on a clean logout.
 *
 * `host` targets a specific host; when omitted, `gh` may prompt and `glab` logs
 * out of its default host. arbella never stores these credentials, so this only
 * affects the CLI's own store.
 */
export async function providerCliLogout(
  provider: AuthProviderId,
  host?: string,
): Promise<boolean> {
  const cli = cliForProvider(provider);
  if (!(await isProviderCliInstalled(provider))) {
    log.debug(`auth: ${cli.label} not installed; nothing to log out of.`);
    return false;
  }

  const args = ["auth", "logout"];
  if (host && host.trim() !== "") {
    args.push("--hostname", host.trim());
  }

  log.step(`Running: ${cli.bin} ${args.join(" ")}`);
  try {
    await execa(cli.bin, args, { stdio: "inherit", timeout: 60_000 });
    log.success(`${cli.label}: signed out.`);
    return true;
  } catch (err) {
    log.warn(`${cli.label} logout did not complete: ${errMessage(err)}`);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Internal                                                                     */
/* -------------------------------------------------------------------------- */

/** Best-effort, secret-free message from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
