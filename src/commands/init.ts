/**
 * `arbella init` — interactive first-run setup (R11, R12, R4-config).
 *
 * Flow:
 *   1. Detect which tools are installed on this machine (tool-home presence).
 *   2. Prompt (clack) for provider + repo name + tools + sourceOfTruth +
 *      auto-push + includeSecrets + includeMemories — unless supplied via flags
 *      or `--yes` (which accepts defaults non-interactively).
 *   3. Create the PRIVATE backup repo if it is missing (core/repo provider) and
 *      resolve its clone URL (`ensureRemoteRepo`).
 *   4. Clone it locally (`ensureLocalClone`).
 *   5. Persist the arbella config (`saveConfig`).
 *   6. Install/remove the throttled auto-push hook (`setAutoBackup`).
 *   7. Offer to run the first push right away.
 *
 * SECURITY: this command never prints, logs, or echoes tokens. Provider CLIs
 * (gh/glab) own their own auth; we only ever surface the provider id + repo name
 * and a debug-level note that a URL was resolved — never the URL with creds.
 *
 * The clock is owned here (command layer): the first-backup invocation lets the
 * backup command stamp its own timestamp.
 */

import path from "node:path";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import { Option, type Command } from "commander";

import type {
  AutoBackupMode,
  RepoProvider,
  SourceOfTruth,
  ToolId,
} from "../types.js";
import { TOOL_IDS } from "../types.js";
import { setAutoBackup } from "../core/autobackup/index.js";
import {
  type ArbellaConfig,
  arbellaConfigSchema,
} from "../core/config/schema.js";
import {
  configExists,
  configPath,
  loadConfigOrDefault,
  saveConfig,
} from "../core/config/index.js";
import { ensureLocalClone, ensureRemoteRepo } from "../core/repo/index.js";
import { buildRepoAuthHooks } from "./_context.js";
import { ensureDeps } from "./setup.js";
import {
  isProviderCliInstalled,
  providerCliAuthStatus,
  providerCliLogin,
  providerById,
  type AuthProviderId,
} from "../core/auth/index.js";
import { cliBinaryName, dataDir, toolHomeDir } from "../platform/os.js";
import { fs } from "../utils/fs.js";
import { log } from "../utils/log.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Flags accepted by `arbella init`. The first six fields are the normative set;
 * the rest are convenience flags so a fully
 * non-interactive run is possible (each maps 1:1 onto a config field).
 */
export interface InitOptions {
  provider?: RepoProvider;
  /** Repo name ("owner/name" / bare name for github/gitlab; full URL for generic). */
  repo?: string;
  /** Comma-separated tool ids, e.g. "claude,codex". */
  tools?: string;
  sourceOfTruth?: SourceOfTruth;
  autoPush?: AutoBackupMode;
  autoBackup?: AutoBackupMode;
  /** Accept defaults for anything not supplied via flags (no prompting). */
  yes?: boolean;
  /** Allow secrets into the private repo (default false; see R5). */
  includeSecrets?: boolean;
  /** Include memories/ in backups (default false; see R13). */
  includeMemories?: boolean;
  /** Offer to run the first push after setup. Commander's --no-push => false. */
  push?: boolean;
  /** Legacy alias for --no-push. */
  backup?: boolean;
}

/* -------------------------------------------------------------------------- */
/* commander registration                                                      */
/* -------------------------------------------------------------------------- */

/** Attach the `init` subcommand to the program. */
export function register(program: Command): void {
  program
    .command("init")
    .description("Set up the backup repo and configure which tools to manage")
    .option(
      "--provider <provider>",
      "repo host: github | gitlab | generic",
    )
    .option(
      "--repo <name>",
      "repo name (owner/name or bare for github/gitlab; full git URL for generic)",
    )
    .option(
      "--tools <list>",
      "comma-separated tools to manage (claude,codex,cursor)",
    )
    .option(
      "--source-of-truth <which>",
      "conflict winner: local | repo",
    )
    .addOption(
      new Option("--auto-push <mode>", "auto-push cadence: off | session-start | daily"),
    )
    .addOption(
      new Option("--auto-backup <mode>", "legacy alias for --auto-push").hideHelp(),
    )
    .option("--include-secrets", "allow secrets into the private repo (default: off)")
    .option("--include-memories", "include memories/ in pushes (default: off)")
    .option("--no-push", "do not offer to run the first push")
    .addOption(new Option("--no-backup", "legacy alias for --no-push").hideHelp())
    .option("-y, --yes", "accept defaults for anything not provided (no prompts)")
    .action(async (opts: InitOptions) => {
      await run(opts);
    });
}

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Execute the init flow. Directly callable (for tests) without commander.
 */
export async function run(opts: InitOptions): Promise<void> {
  intro("arbella — set up your AI dev-setup backup");

  // 0. If a config already exists, confirm we may overwrite it.
  if (await configExists()) {
    const proceed = opts.yes
      ? true
      : await confirm({
          message: `A config already exists at ${configPath()}. Reconfigure it?`,
          initialValue: false,
        });
    if (isCancel(proceed) || proceed === false) {
      cancel("Keeping the existing configuration.");
      return;
    }
  }

  const current = await loadConfigOrDefault();

  // 1. Detect installed tools (tool-home presence + best-effort CLI probe).
  const detected = await detectTools();
  reportDetection(detected);

  // 2. Provider.
  const provider = await resolveProvider(opts);
  if (provider === undefined) return; // cancelled

  // 3. Repo name / URL.
  const repoInput = await resolveRepoInput(opts, provider);
  if (repoInput === undefined) return; // cancelled

  // 4. Tools to manage (default to detected, else the config/default set).
  const defaultTools = pickDefaultTools(detected, current.tools);
  const tools = await resolveTools(opts, defaultTools);
  if (tools === undefined) return; // cancelled

  // 5. Source of truth.
  const sourceOfTruth = await resolveSourceOfTruth(opts, current.sourceOfTruth);
  if (sourceOfTruth === undefined) return; // cancelled

  // 6. Auto-backup cadence.
  const autoBackup = await resolveAutoBackup(opts, current.autoBackup);
  if (autoBackup === undefined) return; // cancelled

  // 7. Secrets / memories opt-ins.
  const includeSecrets = await resolveBooleanOption({
    flag: opts.includeSecrets,
    yes: opts.yes,
    fallback: current.includeSecrets,
    message:
      "Carry inline secret VALUES (in settings/mcp/config) into the (private) repo? " +
      "OFF (default) redacts them in place; ON stores the real values — keep OFF " +
      "unless you understand the risk. Whole-file credentials are always excluded.",
  });
  if (includeSecrets === undefined) return; // cancelled

  const includeMemories = await resolveBooleanOption({
    flag: opts.includeMemories,
    yes: opts.yes,
    fallback: current.includeMemories,
    message: "Include memories/ in backups?",
  });
  if (includeMemories === undefined) return; // cancelled

  // 8. Sign in to the provider FIRST (gh/glab-first) so creating the PRIVATE
  //    repo and the subsequent clone "just work". For github/gitlab this ensures
  //    the CLI is installed (offering to install it) and logged in; for generic
  //    remotes there is no provider CLI step. Best-effort: a failure here is not
  //    fatal — repo creation falls back to a generic remote and the clone path
  //    has its own auth retry.
  await ensureProviderSignedIn(provider, opts.yes === true);

  // 9. Resolve / create the remote repo (PRIVATE when created) + local clone path.
  const localPath = defaultLocalPath();

  let repoConfig;
  try {
    log.step(`Resolving ${provider} repo "${repoInput}"…`);
    repoConfig = await ensureRemoteRepo({
      provider,
      name: repoInput,
      localPath,
    });
  } catch (err) {
    log.error(`Could not resolve or create the backup repo: ${errMessage(err)}`);
    cancel("Setup aborted before any config was written.");
    return;
  }

  // 9. Assemble + persist the config (validated by the schema on save).
  const config: ArbellaConfig = arbellaConfigSchema.parse({
    repo: repoConfig,
    sourceOfTruth,
    autoBackup,
    includeSecrets,
    includeMemories,
    tools,
  });

  try {
    await saveConfig(config);
    log.success(`Saved config to ${configPath()}`);
  } catch (err) {
    log.error(`Failed to write config: ${errMessage(err)}`);
    cancel("Setup aborted.");
    return;
  }

  // 11. Clone the repo locally (no-op if already present). The clone is
  //     auth-aware (gh/glab-first; device-flow/token fallback) for private repos.
  try {
    const authHooks = buildRepoAuthHooks({
      createdAt: new Date().toISOString(),
      interactive: opts.yes !== true,
    });
    await ensureLocalClone(repoConfig, authHooks);
    log.success(`Backup repo ready at ${repoConfig.localPath}`);
  } catch (err) {
    log.error(`Could not clone the backup repo: ${errMessage(err)}`);
    log.warn(
      "Config was saved, but the local clone failed. Fix access (auth/network) " +
        "then re-run `arbella init` or `arbella push`.",
    );
    cancel("Setup partially complete.");
    return;
  }

  // 11. Install (or remove) the throttled auto-push hook for the chosen cadence.
  try {
    await setAutoBackup(autoBackup);
    if (autoBackup === "off") {
      log.step("Auto-push is off (no session hook installed).");
    } else {
      log.success(`Auto-push enabled (${autoBackup}).`);
    }
  } catch (err) {
    // Non-fatal: the rest of setup succeeded; the user can re-run later.
    log.warn(`Could not configure the auto-push hook: ${errMessage(err)}`);
  }

  // 12. Offer to run the first push now.
  await maybeRunFirstPush(opts);

  outro("arbella is configured. Run `arbella push` any time to snapshot your setup.");
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

/** One detected tool: whether its home dir exists and whether its CLI is on PATH. */
interface DetectedTool {
  id: ToolId;
  homePresent: boolean;
  /** undefined when the CLI probe could not be run. */
  cliPresent?: boolean;
}

/**
 * Detect installed tools. Home presence is authoritative (and dependency-free,
 * via fs + os.ts); the CLI probe is best-effort and never blocks setup if the
 * platform install helper is unavailable.
 */
async function detectTools(): Promise<DetectedTool[]> {
  const probe = await loadWhich();
  const results: DetectedTool[] = [];
  for (const id of TOOL_IDS) {
    const homePresent = await fs.exists(toolHomeDir(id));
    let cliPresent: boolean | undefined;
    if (probe) {
      try {
        cliPresent = await probe(cliBinaryName(id));
      } catch {
        cliPresent = undefined;
      }
    }
    results.push({ id, homePresent, cliPresent });
  }
  return results;
}

/** Print a short detection summary (decorative; goes to stderr via log). */
function reportDetection(detected: DetectedTool[]): void {
  const lines = detected.map((d) => {
    const home = d.homePresent ? "config found" : "no config";
    const cli =
      d.cliPresent === undefined
        ? ""
        : d.cliPresent
          ? ", CLI installed"
          : ", CLI missing";
    return `${displayName(d.id)}: ${home}${cli}`;
  });
  note(lines.join("\n"), "Detected tools");
}

/** The tools to pre-select: detected ones, else the existing/default config set. */
function pickDefaultTools(detected: DetectedTool[], fallback: ToolId[]): ToolId[] {
  const present = detected.filter((d) => d.homePresent).map((d) => d.id);
  if (present.length > 0) return present;
  return fallback.length > 0 ? fallback : ["claude", "codex"];
}

/**
 * Best-effort loader for the platform `which` probe. Dynamically imported so
 * that init does not hard-depend on src/platform/install.ts existing at compile
 * time in isolation; returns null when it cannot be loaded.
 */
async function loadWhich(): Promise<((bin: string) => Promise<boolean>) | null> {
  try {
    const mod = (await import("../platform/install.js")) as {
      which?: (bin: string) => Promise<boolean>;
    };
    return typeof mod.which === "function" ? mod.which : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Prompt resolvers (flag/--yes aware)                                         */
/* -------------------------------------------------------------------------- */

/** Resolve the repo provider. Returns undefined when the user cancels. */
async function resolveProvider(
  opts: InitOptions,
): Promise<RepoProvider | undefined> {
  if (opts.provider) {
    if (!isProvider(opts.provider)) {
      throw new Error(
        `Invalid --provider "${opts.provider}". Use github | gitlab | generic.`,
      );
    }
    return opts.provider;
  }
  if (opts.yes) return "github";

  const picked = await select({
    message: "Where should the private backup repo live?",
    initialValue: "github" as RepoProvider,
    options: [
      { value: "github" as RepoProvider, label: "GitHub", hint: "via gh CLI" },
      { value: "gitlab" as RepoProvider, label: "GitLab", hint: "via glab CLI" },
      {
        value: "generic" as RepoProvider,
        label: "Generic git remote",
        hint: "you supply a ready-made private repo URL",
      },
    ],
  });
  if (isCancel(picked)) {
    cancel("Setup cancelled.");
    return undefined;
  }
  return picked;
}

/** Resolve the repo name (github/gitlab) or full URL (generic). */
async function resolveRepoInput(
  opts: InitOptions,
  provider: RepoProvider,
): Promise<string | undefined> {
  if (opts.repo && opts.repo.trim() !== "") return opts.repo.trim();

  if (opts.yes) {
    if (provider === "generic") {
      throw new Error(
        "--yes with provider=generic requires --repo <git-url> (no default URL can be assumed).",
      );
    }
    return "arbella-backup";
  }

  const message =
    provider === "generic"
      ? "Full git URL of your (private) backup repo:"
      : "Backup repo name (created PRIVATE if it does not exist):";
  const placeholder =
    provider === "generic"
      ? "git@github.com:you/arbella-backup.git"
      : "arbella-backup";

  const value = await text({
    message,
    placeholder,
    defaultValue: provider === "generic" ? "" : "arbella-backup",
    validate(input) {
      const v = (input ?? "").trim();
      if (provider === "generic") {
        if (v === "") return "A git URL is required for a generic remote.";
        if (!looksLikeGitUrl(v)) {
          return "That does not look like a git URL (expected git@… or https://…).";
        }
      } else if (v === "") {
        return "A repo name is required.";
      }
      return undefined;
    },
  });
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? "arbella-backup" : trimmed;
}

/** Resolve which tools to manage (multiselect, pre-checked from detection). */
async function resolveTools(
  opts: InitOptions,
  defaults: ToolId[],
): Promise<ToolId[] | undefined> {
  if (opts.tools && opts.tools.trim() !== "") {
    const parsed = parseToolList(opts.tools);
    if (parsed.length === 0) {
      throw new Error(
        `--tools "${opts.tools}" did not contain any known tools (claude,codex,cursor).`,
      );
    }
    return parsed;
  }
  if (opts.yes) return defaults;

  const selected = await multiselect({
    message: "Which tools should arbella manage?",
    required: true,
    initialValues: defaults,
    options: TOOL_IDS.map((id) => ({
      value: id,
      label: displayName(id),
    })),
  });
  if (isCancel(selected)) {
    cancel("Setup cancelled.");
    return undefined;
  }
  return selected as ToolId[];
}

/** Resolve the source-of-truth direction. */
async function resolveSourceOfTruth(
  opts: InitOptions,
  fallback: SourceOfTruth,
): Promise<SourceOfTruth | undefined> {
  if (opts.sourceOfTruth) {
    if (opts.sourceOfTruth !== "local" && opts.sourceOfTruth !== "repo") {
      throw new Error(
        `Invalid --source-of-truth "${opts.sourceOfTruth}". Use local | repo.`,
      );
    }
    return opts.sourceOfTruth;
  }
  if (opts.yes) return fallback;

  const picked = await select({
    message: "On conflicts, which side wins?",
    initialValue: fallback,
    options: [
      {
        value: "local" as SourceOfTruth,
        label: "This machine",
        hint: "your local setup is authoritative; backup pushes",
      },
      {
        value: "repo" as SourceOfTruth,
        label: "The repo",
        hint: "the repo wins; restore overwrites local",
      },
    ],
  });
  if (isCancel(picked)) {
    cancel("Setup cancelled.");
    return undefined;
  }
  return picked;
}

/** Resolve the auto-push cadence. */
async function resolveAutoBackup(
  opts: InitOptions,
  fallback: AutoBackupMode,
): Promise<AutoBackupMode | undefined> {
  const requested = opts.autoPush ?? opts.autoBackup;
  if (requested) {
    if (!isAutoBackupMode(requested)) {
      const flag = opts.autoPush ? "--auto-push" : "--auto-backup";
      throw new Error(
        `Invalid ${flag} "${requested}". Use off | session-start | daily.`,
      );
    }
    return requested;
  }
  if (opts.yes) return fallback;

  const picked = await select({
    message: "Auto-push cadence?",
    initialValue: fallback,
    options: [
      { value: "off" as AutoBackupMode, label: "Off", hint: "manual pushes only" },
      {
        value: "session-start" as AutoBackupMode,
        label: "On session start",
        hint: "throttled to once every few minutes",
      },
      {
        value: "daily" as AutoBackupMode,
        label: "Daily",
        hint: "at most once per 24h",
      },
    ],
  });
  if (isCancel(picked)) {
    cancel("Setup cancelled.");
    return undefined;
  }
  return picked;
}

/**
 * Resolve a yes/no option from a flag, --yes, or a confirm prompt.
 * Returns undefined when the user cancels.
 */
async function resolveBooleanOption(args: {
  flag: boolean | undefined;
  yes: boolean | undefined;
  fallback: boolean;
  message: string;
}): Promise<boolean | undefined> {
  if (args.flag === true) return true;
  if (args.yes) return args.fallback;

  const answer = await confirm({
    message: args.message,
    initialValue: args.fallback,
  });
  if (isCancel(answer)) {
    cancel("Setup cancelled.");
    return undefined;
  }
  return answer;
}

/* -------------------------------------------------------------------------- */
/* First push                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Offer to run the first push. Suppressed by `--no-push`. The push command
 * is dynamically imported so init stays decoupled from it at compile time and
 * never hard-fails if it is unavailable.
 */
async function maybeRunFirstPush(opts: InitOptions): Promise<void> {
  if (opts.push === false || opts.backup === false) return;

  let go: boolean;
  if (opts.yes) {
    go = true;
  } else {
    const answer = await confirm({
      message: "Run the first push now?",
      initialValue: true,
    });
    if (isCancel(answer)) {
      // Treat a cancel here as "skip the push" — setup itself already succeeded.
      log.step("Skipped the first push. Run `arbella push` when ready.");
      return;
    }
    go = answer;
  }
  if (!go) {
    log.step("Skipped the first push. Run `arbella push` when ready.");
    return;
  }

  try {
    const mod = (await import("./backup.js")) as {
      run?: (o: { dryRun?: boolean; auto?: boolean; message?: string }) => Promise<void>;
    };
    if (typeof mod.run !== "function") {
      log.warn("Push command unavailable; run `arbella push` manually.");
      return;
    }
    log.step("Running first push...");
    await mod.run({});
  } catch (err) {
    log.warn(
      `First push did not complete: ${errMessage(err)}. ` +
        "You can run `arbella push` later.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Provider sign-in (gh/glab-first) pre-flight                                 */
/* -------------------------------------------------------------------------- */

/**
 * For a github/gitlab init, make sure the provider CLI is installed and signed
 * in BEFORE we try to create the private repo + clone (both of which use the CLI
 * / its git credential helper). Steps, all best-effort:
 *   1. ensure the CLI dependency (gh/glab) — offering to install it on demand
 *      (honoring `yes` for a non-interactive init);
 *   2. if installed but not logged in, run `<cli> auth login` (inherited stdio);
 *   3. on any miss, just warn — `ensureRemoteRepo` falls back to a generic remote
 *      and the clone path has its own gh/glab-first + device-flow/token retry.
 *
 * Generic provider: nothing to do (no provider CLI). Never throws.
 */
async function ensureProviderSignedIn(
  provider: RepoProvider,
  yes: boolean,
): Promise<void> {
  if (provider !== "github" && provider !== "gitlab") return;
  const providerId = provider as AuthProviderId;
  const spec = providerById(providerId);
  const dep = provider === "github" ? "gh" : "glab";

  try {
    // 1. Make sure the CLI is available (offer to install when missing).
    const deps = await ensureDeps([dep], { yes });
    if (!(await isProviderCliInstalled(providerId))) {
      log.warn(
        `${spec.displayName} CLI (${dep}) is not available. arbella will try to ` +
          "create/clone the repo anyway and sign you in if needed.",
      );
      void deps; // result already surfaced by ensureDeps' own logging.
      return;
    }

    // 2. Ensure it is logged in (run the interactive login if not).
    const state = await providerCliAuthStatus(providerId);
    if (state === "authenticated") {
      log.debug(`init: ${dep} is already signed in.`);
      return;
    }
    if (yes) {
      // Non-interactive init can't drive an interactive browser login.
      log.warn(
        `${dep} is not signed in and --yes was given; skipping interactive ` +
          `login. Run \`arbella auth login --provider ${providerId}\` if creation fails.`,
      );
      return;
    }
    log.info(`Signing in to ${spec.displayName} with ${dep}…`);
    await providerCliLogin(providerId);
  } catch (err) {
    // Pre-flight is advisory; never block init on it.
    log.debug(`init: provider sign-in pre-flight skipped: ${errMessage(err)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Default local clone path: dataDir()/repo (cross-OS, via os.ts). */
function defaultLocalPath(): string {
  return path.join(dataDir(), "repo");
}

/** Human display name for a tool id. */
function displayName(id: ToolId): string {
  switch (id) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "opencode";
    case "copilot":
      return "GitHub Copilot CLI";
    case "kilo":
      return "Kilo Code";
  }
}

/** Parse a comma/space-separated tool list into known, de-duplicated ToolIds. */
function parseToolList(raw: string): ToolId[] {
  const seen = new Set<ToolId>();
  const out: ToolId[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim().toLowerCase();
    if (t === "") continue;
    if (isToolId(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Type guard for ToolId. */
function isToolId(value: string): value is ToolId {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "copilot" ||
    value === "kilo"
  );
}

/** Type guard for RepoProvider. */
function isProvider(value: string): value is RepoProvider {
  return value === "github" || value === "gitlab" || value === "generic";
}

/** Type guard for AutoBackupMode. */
function isAutoBackupMode(value: string): value is AutoBackupMode {
  return value === "off" || value === "session-start" || value === "daily";
}

/** Loose check that a string is a git remote URL (ssh or http(s) or scp-like). */
function looksLikeGitUrl(value: string): boolean {
  return (
    /^https?:\/\//.test(value) ||
    /^git@/.test(value) ||
    /^ssh:\/\//.test(value) ||
    /^git:\/\//.test(value)
  );
}

/** Best-effort message extraction from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
