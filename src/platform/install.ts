/**
 * Platform install layer (R6).
 *
 * The ONE place that shells out to package managers (`npm`, `brew`, `winget`)
 * and probes `PATH` (`which` / `where`). Everything tool-specific (which command
 * installs which tool on which OS, which binary name to probe) is resolved via
 * `./os.js` — this module only knows *how* to run those commands and how to read
 * their results.
 *
 * Design rules honored here:
 *  - Never shell-interpolate: every spawn uses an explicit argv array (execa).
 *  - Never throw on a "tool is simply absent" probe — `which` returns a boolean.
 *  - Surface missing package managers with a clear, actionable error so a restore
 *    on a fresh machine fails loudly instead of silently producing a broken setup.
 *  - `runInstall(null)` is a graceful no-op + warning (e.g. Cursor has no headless
 *    install path on Linux).
 */

import { promises as fsp, constants as fsConstants } from "node:fs";
import path from "node:path";

import { execa } from "execa";

import type { OS, ToolId } from "../types.js";
import {
  cliBinaryName,
  detectOS,
  installCommandFor,
  linuxInstallArgs,
  linuxPackageManagerCandidates,
  type InstallCommand,
  type LinuxPackageManager,
} from "./os.js";
import { log } from "../utils/log.js";
import { isSafeToolName, type ExternalToolManager } from "../core/externaltools/classify.js";

/* -------------------------------------------------------------------------- */
/* PATH probing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * True if `bin` resolves on PATH.
 *
 * POSIX uses the `which` executable, win32 uses `where`. We deliberately do NOT
 * use `command -v`, which is a shell *builtin* (no standalone executable) and so
 * cannot be spawned directly. A non-zero exit / spawn failure simply means
 * "not found" — never an error to propagate.
 */
export async function which(bin: string): Promise<boolean> {
  // Guard against accidental empty lookups (would make `where`/`which` hang or
  // match nothing in confusing ways).
  if (!bin) return false;

  const probe = detectOS() === "win32" ? "where" : "which";
  try {
    const result = await execa(probe, [bin], {
      // We interpret exit codes ourselves; do not let execa throw on non-zero.
      reject: false,
      // Some shells/PATH setups are slow; keep it bounded.
      timeout: 10_000,
      // We don't need the output, but capture it so nothing leaks to our stderr.
      stdio: "pipe",
    });
    return result.exitCode === 0;
  } catch {
    // `which`/`where` itself missing, timeout, or any spawn error => not found.
    return false;
  }
}

/**
 * Resolve a command name/path to an absolute binary path (WP-C).
 *
 *  - Already absolute -> returned as-is when it exists on disk, else `null`.
 *    We never "correct" a stale absolute path to something else on PATH — the
 *    config said exactly where the binary is, so either it's there or it isn't.
 *  - A bare name -> resolved through the shell lookup that mirrors how it
 *    would actually be spawned:
 *      POSIX:  `sh -c 'command -v -- "$1"' _ <name>` — `command -v` is a shell
 *              builtin (unlike the standalone `which` executable used by
 *              {@link which} above) and matches aliases/functions/PATH the
 *              same way a real spawn would resolve the name.
 *      win32:  `where <name>` — first line of stdout.
 *
 * Never throws: any spawn failure, timeout, non-zero exit, or empty output
 * resolves to `null`.
 */
export async function resolveBinaryPath(name: string): Promise<string | null> {
  if (!name) return null;

  if (path.isAbsolute(name)) {
    try {
      await fsp.access(name, fsConstants.F_OK);
      return name;
    } catch {
      return null;
    }
  }

  try {
    const result =
      detectOS() === "win32"
        ? await execa("where", [name], { reject: false, stdio: "pipe", timeout: 10_000 })
        : await execa("sh", ["-c", 'command -v -- "$1"', "_", name], {
            reject: false,
            stdio: "pipe",
            timeout: 10_000,
          });
    if (result.exitCode !== 0) return null;
    const firstLine = (result.stdout ?? "").split(/\r?\n/, 1)[0]?.trim();
    return firstLine ? firstLine : null;
  } catch {
    return null;
  }
}

/**
 * `node:fs/promises.realpath`, falling back to the input path on any error
 * (missing file, permission denied, not a symlink to resolve, ...). Used to
 * resolve a binary's real install location before classifying it (WP-C) —
 * never throws, since "couldn't resolve" just means "classify the path as
 * given".
 */
export async function realPathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/**
 * The command that installs an external tool for its manager (WP-C). `null`
 * for `manager: "unknown"` — arbella has no install path for a tool it
 * couldn't attribute to a known package manager; the caller falls back to a
 * manual-install reminder.
 *
 *   brew    -> `brew install <name>`
 *   uv      -> `uv tool install <name>`
 *   pipx    -> `pipx install <name>`
 *   unknown -> null
 */
export function externalToolInstallCommand(ref: {
  manager: ExternalToolManager;
  name: string;
}): InstallCommand | null {
  switch (ref.manager) {
    case "brew":
      return { cmd: "brew", args: ["install", ref.name] };
    case "uv":
      return { cmd: "uv", args: ["tool", "install", ref.name] };
    case "pipx":
      return { cmd: "pipx", args: ["install", ref.name] };
    case "unknown":
      return null;
  }
}

/** Injectable collaborators for {@link installExternalTool} (tests only). */
export interface InstallExternalToolOptions {
  /** Checks whether the MANAGER binary (e.g. "brew") is on PATH. Default: {@link which}. */
  which?: (bin: string) => Promise<boolean>;
  /** Runs the resolved install command. Default: {@link runInstall}. */
  run?: (cmd: InstallCommand) => Promise<void>;
}

/**
 * Install one external tool (WP-C restore planning), via the injected `which`
 * / `run` collaborators (defaulting to this module's own {@link which} and
 * {@link runInstall}) so tests never actually shell out.
 *
 *  - `name` is not {@link isSafeToolName} -> `"rejected-name"`. The manifest
 *    schema already drops such entries on parse; this is the SECOND line, right
 *    at the spawn, so no future caller can hand a repo-supplied `--cask` or
 *    `git+https://…` to a package manager as a package name.
 *  - `manager: "unknown"` -> `"unsupported"` (no install command exists).
 *  - The manager binary itself (`brew`/`uv`/`pipx`) is not on PATH ->
 *    `"skipped-manager-missing"` (installing the manager is out of scope here).
 *  - Otherwise runs the install command and resolves `"installed"`.
 *
 * Does not swallow a failing `run`: its error is caught and re-thrown with a
 * `external tool <name>: ` prefix so the caller can report which tool failed
 * without losing the underlying reason.
 */
export async function installExternalTool(
  ref: { manager: ExternalToolManager; name: string },
  opts: InstallExternalToolOptions = {},
): Promise<"installed" | "skipped-manager-missing" | "unsupported" | "rejected-name"> {
  if (!isSafeToolName(ref.name)) return "rejected-name";

  const cmd = externalToolInstallCommand(ref);
  if (cmd === null) return "unsupported";

  const whichFn = opts.which ?? which;
  const runFn = opts.run ?? runInstall;

  if (!(await whichFn(cmd.cmd))) return "skipped-manager-missing";

  try {
    await runFn(cmd);
    return "installed";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`external tool ${ref.name}: ${reason}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Running install commands                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Human-readable package-manager name + the hint we show when it is missing.
 * Keyed by the executable that `InstallCommand.cmd` will be.
 */
const PKG_MANAGER_HINTS: Record<string, string> = {
  npm: "npm (ships with Node.js). Install Node.js from https://nodejs.org/ and try again.",
  brew: "Homebrew. Install it from https://brew.sh/ and try again.",
  winget:
    "winget (App Installer). Install it from the Microsoft Store (\"App Installer\") and try again.",
};

/** Best-effort friendly name for the manager driving an install command. */
function managerHint(cmd: string): string {
  return PKG_MANAGER_HINTS[cmd] ?? `\`${cmd}\` (required to install this tool).`;
}

/* -- global-npm permission handling (so installs work on system Node too) -- */

/** Cached writability of the global npm install dir (constant within a run). */
let cachedGlobalNpmWritable: boolean | undefined;

/** Walk up to the nearest existing directory and test W_OK. Never throws. */
async function isPathWritable(target: string): Promise<boolean> {
  let p = target;
  for (;;) {
    try {
      await fsp.access(p, fsConstants.W_OK);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const parent = path.dirname(p);
        if (parent === p) return false;
        p = parent;
        continue;
      }
      return false; // EACCES / EPERM / anything else -> not writable
    }
  }
}

/**
 * True when the npm GLOBAL install dir is writable by the current user — what
 * decides whether `npm install -g` needs `sudo`:
 *  - nvm / Homebrew / a user `prefix` / Windows     -> writable -> plain npm.
 *  - system Node (apt's /usr/lib/node_modules etc.) -> NOT writable -> needs root.
 * Probes `<npm prefix -g>/lib/node_modules` (Windows: `<prefix>`), climbing to the
 * nearest existing ancestor. Never throws; unknown -> not writable (prefer sudo,
 * the safe default for the EACCES case). Cached for the run.
 */
async function isGlobalNpmWritable(): Promise<boolean> {
  if (cachedGlobalNpmWritable !== undefined) return cachedGlobalNpmWritable;
  let dir: string | null = null;
  try {
    const res = await execa("npm", ["prefix", "-g"], {
      reject: false,
      stdio: "pipe",
      timeout: 10_000,
    });
    const prefix = (res.stdout ?? "").trim();
    if (prefix) {
      dir =
        detectOS() === "win32" ? prefix : path.join(prefix, "lib", "node_modules");
    }
  } catch {
    // unknown prefix -> treated as not writable below.
  }
  cachedGlobalNpmWritable = dir ? await isPathWritable(dir) : false;
  return cachedGlobalNpmWritable;
}

/**
 * Given an install command, add `sudo` IFF it is a global `npm install -g` that
 * needs root on this machine — and only when sudo is possible. This single choke
 * point makes EVERY path (restore's CLI installs, the captured-globals reinstall,
 * and setup) elevate correctly, while user-owned Node (nvm/brew/Windows) is never
 * needlessly sudo'd. Returns the (possibly elevated) command + a one-line note
 * when sudo was added.
 */
async function elevateForNpmGlobal(
  cmd: InstallCommand,
): Promise<{ command: InstallCommand; note?: string }> {
  if (cmd.cmd !== "npm") return { command: cmd };
  const a = cmd.args;
  const installs = a.includes("install") || a.includes("i") || a.includes("add");
  const global = a.includes("-g") || a.includes("--global");
  if (!installs || !global) return { command: cmd };
  if (detectOS() === "win32" || isRoot() || (await isGlobalNpmWritable())) {
    return { command: cmd };
  }
  if (await which("sudo")) {
    return {
      command: { cmd: "sudo", args: ["npm", ...a] },
      note:
        "The global npm folder needs root here — using sudo for this install. " +
        "You may be prompted for your password.",
    };
  }
  return { command: cmd };
}

/**
 * True for a package whose NAME encodes a platform/arch that is NOT this machine
 * (e.g. `@scope/tui-darwin-arm64` on Linux). Such native builds only install on
 * their own OS, so reinstalling them elsewhere just fails noisily — restore skips
 * them. Conservative: only the unambiguous os tokens darwin/win32/linux as
 * delimited segments count, so ordinary names (winston, macaron) are safe.
 */
export function isForeignPlatformPackage(
  name: string,
  os: OS = detectOS(),
): boolean {
  const lower = name.toLowerCase();
  const tokenFor: Record<OS, RegExp> = {
    darwin: /(^|[-_/@])darwin([-_/]|$)/,
    win32: /(^|[-_/@])win32([-_/]|$)/,
    linux: /(^|[-_/@])linux([-_/]|$)/,
  };
  for (const other of ["darwin", "win32", "linux"] as OS[]) {
    if (other !== os && tokenFor[other].test(lower)) return true;
  }
  return false;
}

/**
 * Execute an `InstallCommand` produced by `installCommandFor`.
 *
 *  - `null` (no supported install path on this OS, e.g. Cursor on Linux) => warn
 *    and return without throwing, so a backup/restore of other tools proceeds.
 *  - If the underlying package manager is not on PATH, throw a clear error naming
 *    the missing manager and how to get it.
 *  - Inherit stdio so the user sees real-time install progress (npm/brew are
 *    chatty and long-running; swallowing their output would look frozen).
 */
export async function runInstall(cmd: InstallCommand | null): Promise<void> {
  if (cmd === null) {
    log.warn(
      "No supported automatic install for this tool on this OS — skipping. Install it manually.",
    );
    return;
  }

  // Elevate a global `npm install -g` with sudo when the global folder is
  // root-owned (system Node); a no-op for user-owned Node, Windows, and non-npm.
  const elevated = await elevateForNpmGlobal(cmd);
  if (elevated.note) log.info(elevated.note);
  const { cmd: program, args } = elevated.command;

  // Fail fast with a useful message if the package manager itself is absent.
  const hasManager = await which(program);
  if (!hasManager) {
    throw new Error(
      `Cannot run "${program} ${args.join(" ")}": ${managerHint(program)}`,
    );
  }

  log.step(`Running: ${program} ${args.join(" ")}`);
  try {
    await execa(program, args, {
      // Show progress live; these commands are interactive-ish and slow.
      stdio: "inherit",
      // Generous: brew cask / npm global installs can take minutes.
      timeout: 10 * 60_000,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Install command failed (${program} ${args.join(" ")}): ${reason}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Per-tool CLI helpers (used by the adapter index modules)                    */
/* -------------------------------------------------------------------------- */

/**
 * True if a tool's CLI/app binary is on PATH.
 * Thin wrapper over `which(cliBinaryName(tool))` so adapters don't repeat the
 * binary-name lookup. (Cursor in particular is frequently absent — that's fine.)
 */
export async function isCliInstalled(tool: ToolId): Promise<boolean> {
  return which(cliBinaryName(tool));
}

/**
 * Install a tool's CLI/app for the given OS (R6).
 * Resolves the correct command via `installCommandFor` and runs it. Safe to call
 * even if already installed; callers should `isCliInstalled()`-guard to avoid
 * redundant work, but this remains idempotent-ish (package managers no-op or
 * upgrade). A `null` command (unsupported OS) is handled gracefully by
 * `runInstall`.
 */
export async function installCli(tool: ToolId, os: OS): Promise<void> {
  await runInstall(installCommandFor(tool, os));
}

/**
 * Convenience: ensure a tool's CLI is present for `os`, skipping the install when
 * it already resolves on PATH. Used by restore to only install what's missing.
 */
export async function ensureCli(tool: ToolId, os: OS): Promise<void> {
  if (await isCliInstalled(tool)) {
    log.debug(`${cliBinaryName(tool)} already installed; skipping.`);
    return;
  }
  log.step(`Installing ${tool} CLI…`);
  await installCli(tool, os);
}

/* -------------------------------------------------------------------------- */
/* npm globals                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Install a single global npm package (`npm install -g <pkg>`).
 * Throws a clear error if npm is missing, or if the install itself fails.
 */
export async function npmInstallGlobal(pkg: string): Promise<void> {
  await runInstall({ cmd: "npm", args: ["install", "-g", pkg] });
}

/**
 * Shape of `npm ls -g --json` (the only fields we rely on). npm emits
 * `{ name, dependencies: { "<pkg>": { version, overridden } } }`.
 */
interface NpmLsJson {
  dependencies?: Record<string, { version?: string } | undefined>;
}

/**
 * Packages that are part of the Node/npm toolchain itself, never user setup, and
 * which we must not try to "reinstall" on another machine.
 */
const NPM_GLOBAL_IGNORE = new Set<string>(["npm", "corepack", "lib", "arbella"]);

/**
 * List installed global npm packages as `[{ package, version? }]`.
 *
 * This is the SHARED source of `ToolManifest.npmGlobals` for both adapters.
 * Tolerant by design:
 *  - if npm is absent, returns `[]` (no globals we can speak to);
 *  - `npm ls -g` exits non-zero on peer-dep/extraneous warnings while STILL
 *    printing valid JSON, so we set `reject:false` and parse stdout regardless;
 *  - any parse failure / unexpected shape => `[]` rather than throwing.
 *
 * Note: tools installed outside npm (e.g. a binary in ~/.local/bin) do NOT appear
 * here. That is expected — we record only what npm actually reports and never
 * fabricate entries.
 */
export async function listNpmGlobals(): Promise<
  Array<{ package: string; version?: string }>
> {
  if (!(await which("npm"))) {
    log.debug("npm not found on PATH; reporting no global packages.");
    return [];
  }

  let stdout = "";
  try {
    const result = await execa(
      "npm",
      ["ls", "-g", "--depth=0", "--json"],
      {
        reject: false, // npm may exit 1 on warnings yet still emit valid JSON.
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    stdout = result.stdout ?? "";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.debug(`npm ls -g failed to run: ${reason}`);
    return [];
  }

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: NpmLsJson;
  try {
    parsed = JSON.parse(trimmed) as NpmLsJson;
  } catch {
    log.debug("Could not parse `npm ls -g --json` output; reporting none.");
    return [];
  }

  const deps = parsed.dependencies;
  if (!deps || typeof deps !== "object") return [];

  const out: Array<{ package: string; version?: string }> = [];
  for (const [name, info] of Object.entries(deps)) {
    if (NPM_GLOBAL_IGNORE.has(name)) continue;
    const version =
      info && typeof info === "object" && typeof info.version === "string"
        ? info.version
        : undefined;
    out.push(version ? { package: name, version } : { package: name });
  }

  // Deterministic order so manifests diff cleanly across runs/machines.
  out.sort((a, b) => a.package.localeCompare(b.package));
  return out;
}

/* ========================================================================== */
/* Cross-OS dependency registry (P1)                                          */
/*                                                                            */
/* The plug-&-play foundation the Auth (`core/auth`) and Setup                */
/* (`commands/setup`) layers build on. Everything here is metadata + thin     */
/* wrappers over the spawn helpers above:                                     */
/*                                                                            */
/*   DEPENDENCIES      a typed registry of every tool arbella can install     */
/*                     (git, gh, glab, claude, codex, cursor) with the per-OS */
/*                     install command resolved lazily.                       */
/*   isInstalled(id)   true if the dependency's binary resolves on PATH.      */
/*   install(id)       install it for the current OS (cross-OS dispatch).     */
/*                                                                            */
/* Design rules (same as the rest of this module):                           */
/*   - Never shell-interpolate: every spawn uses an explicit argv array.      */
/*   - A probe NEVER throws (absence is a boolean, not an error).             */
/*   - A missing package manager / unsupported OS surfaces a clear, actionable */
/*     message; `install` returns an outcome object rather than always        */
/*     throwing, so the Setup multiselect can install several deps and report */
/*     per-dep success/failure without aborting the whole batch.             */
/* ========================================================================== */

/**
 * Every dependency arbella knows how to detect + install. A superset of
 * {@link ToolId} (claude/codex/cursor) that also covers the version-control and
 * provider CLIs needed for auth:
 *   - `git`  : required for every clone/push.
 *   - `gh`   : GitHub CLI — preferred GitHub auth + repo creation path.
 *   - `glab` : GitLab CLI — preferred GitLab auth + repo creation path.
 *   - `claude`/`codex`/`cursor` : the AI tool CLIs arbella backs up.
 *
 * Kept LOCAL to the platform layer (not added to `src/types.ts`) so the install
 * foundation is self-contained and the Auth/Setup agents import it from here.
 */
export type DependencyId = "git" | "gh" | "glab" | ToolId;

/** All known dependency ids, in the order Setup should present them. */
export const DEPENDENCY_IDS: readonly DependencyId[] = [
  "git",
  "gh",
  "glab",
  "claude",
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "kilo",
  "antigravity",
] as const;

/**
 * How a dependency is installed on one OS. Exactly one variant applies per OS:
 *   - `npm`    : a global npm package (`npm install -g <package>`), OS-independent.
 *   - `brew`   : a Homebrew formula or cask (macOS).
 *   - `winget` : a winget package id (Windows).
 *   - `apt`    : a Linux distro package name; the install layer resolves the
 *                actual manager (apt-get/dnf/pacman/...) at runtime and prefixes
 *                `sudo`. `repoNote` is an optional one-line hint shown when the
 *                distro package is known to be stale/absent (e.g. gh/glab on
 *                older distros need the vendor apt/dnf repo).
 *   - `none`   : no supported headless install on this OS (e.g. Cursor on Linux,
 *                a desktop app). `reason` explains why; `install` warns + skips.
 */
export type InstallMethod =
  | { kind: "npm"; package: string }
  | { kind: "brew"; formula: string; cask?: boolean }
  | { kind: "winget"; id: string }
  | { kind: "apt"; package: string; repoNote?: string }
  | { kind: "none"; reason: string };

/** Per-OS install methods for a dependency. */
export interface PlatformInstall {
  readonly darwin: InstallMethod;
  readonly linux: InstallMethod;
  readonly win32: InstallMethod;
}

/**
 * Full metadata for a dependency. This is what the Setup multiselect renders and
 * what Auth consults before offering "install gh? [Y/n]".
 */
export interface DependencySpec {
  /** Stable id. */
  readonly id: DependencyId;
  /** Short human label for prompts ("GitHub CLI (gh)"). */
  readonly label: string;
  /** One-line rationale shown next to the checkbox ("preferred GitHub auth"). */
  readonly why: string;
  /** Executable probed on PATH to decide "installed?". */
  readonly binary: string;
  /**
   * True for the dependencies arbella recommends by default in `setup` (git, gh,
   * glab). The AI tool CLIs are opt-in (the user picks which they use), so they
   * are NOT recommended-by-default — a fresh user is not assumed to want all
   * three. `git` is the only STRONGLY recommended one (see `strong`).
   */
  readonly recommended: boolean;
  /**
   * True for git only — it is effectively required, so Setup should both
   * pre-check it AND label it "strongly recommended".
   */
  readonly strong: boolean;
  /** The per-OS install methods. */
  readonly install: PlatformInstall;
}

/** Convenience builder for an npm-global dependency (same on every OS). */
function npmEverywhere(pkg: string): PlatformInstall {
  const m: InstallMethod = { kind: "npm", package: pkg };
  return { darwin: m, linux: m, win32: m };
}

/**
 * The dependency registry. The single source of truth the Auth + Setup layers
 * import. Ordering matches {@link DEPENDENCY_IDS}.
 */
export const DEPENDENCIES: Readonly<Record<DependencyId, DependencySpec>> = {
  git: {
    id: "git",
    label: "Git",
    why: "Required to clone and push your backup repository.",
    binary: "git",
    recommended: true,
    strong: true,
    install: {
      darwin: { kind: "brew", formula: "git" },
      // git is in the base repos of every supported distro.
      linux: { kind: "apt", package: "git" },
      win32: { kind: "winget", id: "Git.Git" },
    },
  },
  gh: {
    id: "gh",
    label: "GitHub CLI (gh)",
    why: "Preferred GitHub sign-in (handles OAuth for you) and private-repo creation.",
    binary: "gh",
    recommended: true,
    strong: false,
    install: {
      darwin: { kind: "brew", formula: "gh" },
      linux: {
        kind: "apt",
        package: "gh",
        repoNote:
          "On older distros `gh` may be absent from the base repos — add GitHub's " +
          "official package repo (https://github.com/cli/cli/blob/trunk/docs/install_linux.md) " +
          "and retry.",
      },
      win32: { kind: "winget", id: "GitHub.cli" },
    },
  },
  glab: {
    id: "glab",
    label: "GitLab CLI (glab)",
    why: "Preferred GitLab sign-in (handles OAuth for you) and private-repo creation.",
    binary: "glab",
    recommended: true,
    strong: false,
    install: {
      darwin: { kind: "brew", formula: "glab" },
      linux: {
        kind: "apt",
        package: "glab",
        repoNote:
          "If your distro has no `glab` package, install it from " +
          "https://gitlab.com/gitlab-org/cli/-/releases (or via Homebrew on Linux) and retry.",
      },
      win32: { kind: "winget", id: "GitLab.GitLabCLI" },
    },
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    why: "Anthropic's CLI — backed up/restored by arbella.",
    binary: cliBinaryName("claude"),
    recommended: false,
    strong: false,
    install: npmEverywhere("@anthropic-ai/claude-code"),
  },
  codex: {
    id: "codex",
    label: "Codex",
    why: "OpenAI's CLI — backed up/restored by arbella.",
    binary: cliBinaryName("codex"),
    recommended: false,
    strong: false,
    install: npmEverywhere("@openai/codex"),
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    why: "The Cursor editor/CLI — backed up/restored by arbella.",
    binary: cliBinaryName("cursor"),
    recommended: false,
    strong: false,
    install: {
      darwin: { kind: "brew", formula: "cursor", cask: true },
      // Cursor is a desktop app with no standard headless Linux install.
      linux: {
        kind: "none",
        reason:
          "Cursor is a desktop app with no standard headless install on Linux — " +
          "download it from https://www.cursor.com/downloads.",
      },
      win32: { kind: "winget", id: "Anysphere.Cursor" },
    },
  },
  opencode: {
    id: "opencode",
    label: "opencode",
    why: "The opencode terminal AI agent — backed up/restored by arbella.",
    binary: cliBinaryName("opencode"),
    recommended: false,
    strong: false,
    install: npmEverywhere("opencode-ai"),
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot CLI",
    why: "GitHub's terminal Copilot CLI — backed up/restored by arbella.",
    binary: cliBinaryName("copilot"),
    recommended: false,
    strong: false,
    install: npmEverywhere("@github/copilot"),
  },
  kilo: {
    id: "kilo",
    label: "Kilo Code",
    why: "The Kilo Code CLI — backed up/restored by arbella.",
    binary: cliBinaryName("kilo"),
    recommended: false,
    strong: false,
    install: npmEverywhere("@kilocode/cli"),
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    why: "Google Antigravity (IDE + agent) — backed up/restored by arbella.",
    binary: cliBinaryName("antigravity"),
    recommended: false,
    strong: false,
    // A desktop app downloaded from antigravity.google — no package-manager
    // install on any OS. Setup reports the download URL and skips.
    install: {
      darwin: {
        kind: "none",
        reason: "Antigravity is a desktop app — download it from https://antigravity.google.",
      },
      linux: {
        kind: "none",
        reason: "Antigravity is a desktop app — download it from https://antigravity.google.",
      },
      win32: {
        kind: "none",
        reason: "Antigravity is a desktop app — download it from https://antigravity.google.",
      },
    },
  },
};

/** Look up a dependency spec by id. Throws on an unknown id (programmer error). */
export function getDependency(id: DependencyId): DependencySpec {
  const spec = DEPENDENCIES[id];
  if (!spec) throw new Error(`Unknown dependency id: ${String(id)}`);
  return spec;
}

/** Every dependency spec, in canonical order (handy for Setup's multiselect). */
export function allDependencies(): DependencySpec[] {
  return DEPENDENCY_IDS.map((id) => DEPENDENCIES[id]);
}

/* -------------------------------------------------------------------------- */
/* Linux package-manager probing                                               */
/* -------------------------------------------------------------------------- */

/** Memoized result of the (mildly expensive) PATH probe for a Linux manager. */
let cachedLinuxPm: LinuxPackageManager | undefined;

/**
 * Detect which supported Linux package manager is available, by probing PATH for
 * each candidate (apt-get -> dnf -> yum -> pacman -> zypper) in priority order.
 * Returns "unknown" when none is found. Cached after the first call (the answer
 * does not change within a process). Safe to call on non-Linux too — it simply
 * probes and returns "unknown" there.
 */
export async function detectLinuxPackageManager(): Promise<LinuxPackageManager> {
  if (cachedLinuxPm !== undefined) return cachedLinuxPm;
  for (const { id, bin } of linuxPackageManagerCandidates()) {
    if (await which(bin)) {
      cachedLinuxPm = id;
      return id;
    }
  }
  cachedLinuxPm = "unknown";
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Dependency detection                                                         */
/* -------------------------------------------------------------------------- */

/**
 * True if a dependency's binary resolves on PATH. Thin wrapper over
 * {@link which} keyed by the registry's `binary` field, so callers don't repeat
 * the binary-name lookup. Never throws (absence is a boolean).
 *
 * This is the public detection entrypoint the Auth + Setup layers use, e.g.
 * `if (!(await isInstalled("gh"))) { offer to install }`.
 */
export async function isInstalled(id: DependencyId): Promise<boolean> {
  return which(getDependency(id).binary);
}

/**
 * Resolve `[{ id, installed }]` for several dependencies at once (concurrently).
 * Used by `setup` to pre-check the boxes for what's missing. Order matches the
 * input.
 */
export async function checkInstalled(
  ids: readonly DependencyId[] = DEPENDENCY_IDS,
): Promise<Array<{ id: DependencyId; installed: boolean }>> {
  return Promise.all(
    ids.map(async (id) => ({ id, installed: await isInstalled(id) })),
  );
}

/* -------------------------------------------------------------------------- */
/* Dependency installation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of an {@link install} attempt. `install` does NOT throw on a failed
 * or unsupported install — it returns this so a Setup batch can install several
 * dependencies and report each one's result without aborting the rest. (The
 * lower-level {@link runInstall} still throws; this layer catches and classifies.)
 *
 *   - "installed"   : the install command ran successfully.
 *   - "already"     : the binary was already on PATH; nothing was done.
 *   - "unsupported" : no headless install for this dependency on this OS
 *                     (e.g. Cursor on Linux). `message` explains + points to a
 *                     manual download.
 *   - "failed"      : the install command (or its package manager) failed.
 *                     `message` is a secret-free, actionable error.
 */
export interface InstallOutcome {
  id: DependencyId;
  status: "installed" | "already" | "unsupported" | "failed";
  /** Human-readable, secret-free detail (always present for non-"installed"). */
  message?: string;
}

/** Options for {@link install}. */
export interface InstallOptions {
  /**
   * Re-install / upgrade even if the binary is already present. Default false:
   * an already-installed dependency short-circuits to `status: "already"`.
   */
  force?: boolean;
  /**
   * Override the target OS (defaults to {@link detectOS}). Mainly for tests; in
   * normal use the current OS is correct.
   */
  os?: OS;
}

/**
 * Install a dependency for the current OS (cross-OS dispatch). Resolves the
 * registry's per-OS {@link InstallMethod}, turns it into a concrete command, and
 * runs it via {@link runInstall}. System packages on Linux are installed via the
 * detected package manager, prefixed with `sudo` (with a clear message), since
 * apt/dnf/pacman need root; npm/brew/winget do not.
 *
 * Returns an {@link InstallOutcome} instead of throwing, so callers (Setup's
 * multiselect, Auth's install-on-demand) can handle each dependency's result
 * individually. Idempotent by default: an already-present binary is reported as
 * `"already"` without running anything (pass `force` to reinstall).
 */
export async function install(
  id: DependencyId,
  opts: InstallOptions = {},
): Promise<InstallOutcome> {
  const spec = getDependency(id);
  const targetOS = opts.os ?? detectOS();

  if (!opts.force && (await which(spec.binary))) {
    log.debug(`${spec.label} already installed; skipping.`);
    return { id, status: "already", message: `${spec.label} is already installed.` };
  }

  const method = spec.install[targetOS];

  // No headless install path on this OS (e.g. Cursor on Linux).
  if (method.kind === "none") {
    log.warn(`${spec.label}: ${method.reason}`);
    return { id, status: "unsupported", message: method.reason };
  }

  // Resolve the concrete command (+ any extra hint) for this method.
  const resolved = await resolveInstallCommand(spec, method, targetOS);
  if (resolved.error) {
    log.warn(`${spec.label}: ${resolved.error}`);
    return { id, status: "failed", message: resolved.error };
  }
  if (resolved.note) log.info(resolved.note);

  log.step(`Installing ${spec.label}…`);
  try {
    await runInstall(resolved.command);
    log.success(`${spec.label} installed.`);
    return { id, status: "installed" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // runInstall already prefixes context; keep the message but don't rethrow.
    return { id, status: "failed", message: reason };
  }
}

/**
 * Install several dependencies in sequence, returning one {@link InstallOutcome}
 * per id (input order preserved). Sequential by design: package managers
 * (apt/brew/npm) serialize internally and parallel runs would interleave their
 * inherited stdio into unreadable output. A single dependency failing does NOT
 * stop the rest — its outcome simply has `status: "failed"`.
 */
export async function installMany(
  ids: readonly DependencyId[],
  opts: InstallOptions = {},
): Promise<InstallOutcome[]> {
  const outcomes: InstallOutcome[] = [];
  for (const id of ids) {
    outcomes.push(await install(id, opts));
  }
  return outcomes;
}

/* -------------------------------------------------------------------------- */
/* Install-command resolution (internal)                                       */
/* -------------------------------------------------------------------------- */

/** Resolved command for an install method, plus optional UX note / hard error. */
interface ResolvedInstall {
  /** The command to run (null => runInstall warns + no-ops; only for safety). */
  command: InstallCommand | null;
  /** A one-line, non-error hint to print before installing (e.g. a repo note). */
  note?: string;
  /** A hard error meaning "cannot install here" — caller reports `failed`. */
  error?: string;
}

/**
 * Turn an {@link InstallMethod} into a concrete {@link InstallCommand} for the
 * target OS. The npm/brew/winget cases are direct; the Linux `apt` case probes
 * for the actual package manager and wraps the install in `sudo` (managers need
 * root). Returns an `error` string when the OS has no usable manager.
 */
async function resolveInstallCommand(
  spec: DependencySpec,
  method: InstallMethod,
  targetOS: OS,
): Promise<ResolvedInstall> {
  switch (method.kind) {
    case "npm":
      return { command: { cmd: "npm", args: ["install", "-g", method.package] } };

    case "brew":
      return {
        command: {
          cmd: "brew",
          args: method.cask
            ? ["install", "--cask", method.formula]
            : ["install", method.formula],
        },
      };

    case "winget":
      return {
        command: {
          cmd: "winget",
          args: ["install", "--id", method.id, "-e", "--source", "winget"],
        },
      };

    case "apt":
      return resolveLinuxInstall(spec, method, targetOS);

    case "none":
      // Handled by the caller before we get here; included for exhaustiveness.
      return { command: null, error: method.reason };
  }
}

/**
 * Resolve a Linux distro-package install: detect the package manager, build its
 * `install <pkg>` argv, and prefix `sudo` (we are almost never already root, and
 * apt/dnf/pacman require it). When no supported manager is found, returns a
 * helpful `error` (including any vendor-repo note for gh/glab).
 */
async function resolveLinuxInstall(
  spec: DependencySpec,
  method: Extract<InstallMethod, { kind: "apt" }>,
  targetOS: OS,
): Promise<ResolvedInstall> {
  // Only meaningful on Linux. On a non-Linux OS this method shouldn't be picked,
  // but guard so a misconfiguration produces a clear message, not a bad spawn.
  if (targetOS !== "linux") {
    return {
      command: null,
      error: `${spec.label} has no automatic install on this OS.`,
    };
  }

  const pm = await detectLinuxPackageManager();
  const base = linuxInstallArgs(pm, method.package);
  if (pm === "unknown" || base === null) {
    const extra = method.repoNote ? ` ${method.repoNote}` : "";
    return {
      command: null,
      error:
        `No supported package manager found (looked for apt-get, dnf, yum, ` +
        `pacman, zypper). Install ${spec.label} manually.${extra}`,
    };
  }

  // Build the note shown before a (chatty, root) system install.
  const noteParts = [
    `Using ${base.cmd} (with sudo) to install ${spec.label}. ` +
      "You may be prompted for your password.",
  ];
  if (method.repoNote) noteParts.push(method.repoNote);

  // Prefix sudo unless we are already root. We don't add `-n` because the user
  // may legitimately need to type their password (stdio is inherited).
  const useSudo = !isRoot();
  const command: InstallCommand = useSudo
    ? { cmd: "sudo", args: [base.cmd, ...base.args] }
    : { cmd: base.cmd, args: base.args };

  // If sudo itself is missing and we're not root, surface that clearly.
  if (useSudo && !(await which("sudo"))) {
    return {
      command: null,
      error:
        `Installing ${spec.label} needs root via the ${base.cmd} package manager, ` +
        `but \`sudo\` was not found. Re-run as root or install ${spec.label} manually.`,
    };
  }

  return { command, note: noteParts.join(" ") };
}

/** True when the process is running as root (uid 0). Best-effort; false on win32. */
function isRoot(): boolean {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  try {
    return typeof getuid === "function" && getuid.call(process) === 0;
  } catch {
    return false;
  }
}
