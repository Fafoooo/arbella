/**
 * All Claude-specific path knowledge for the arbella Claude adapter.
 *
 * This is the ONE place that encodes where things live under ~/.claude. Every
 * other Claude module (capture/restore/plugins/mcp/memories/index) asks here
 * rather than re-deriving paths, so a layout change is a single-file edit.
 *
 * Cross-OS: the tool home is resolved via src/platform/os.ts (toolHomeDir),
 * never hardcoded. All sub-paths are built with node:path.join so separators are
 * correct on win32 as well. The `repoPath` prefix, by contrast, is a POSIX-only
 * string used inside the backup repo and is intentionally a literal.
 *
 * NOTE: `globalState` (~/.claude.json) is a SIBLING of the tool home, not a
 * child of it. It is derived from the tool home's PARENT so a test can point an
 * entire fixture $HOME at this module and still get the right file.
 */

import path from "node:path";

import type { FsService } from "../../types.js";
import { denylistFor, matchesDeny } from "../../core/sanitizer/denylist.js";
import { toolHomeDir } from "../../platform/os.js";

/** Absolute path to ~/.claude on this machine. */
export function home(): string {
  return toolHomeDir("claude");
}

/**
 * Prefix (POSIX) for every CapturedFile.repoPath this adapter emits.
 * A file at `<home>/X` is stored at `claude/files/X` in the backup repo.
 */
export const REPO_PREFIX = "claude/files";

/** Fully-resolved set of Claude paths, all absolute. */
export interface ClaudePaths {
  /** ~/.claude */
  home: string;
  /** ~/.claude/settings.json */
  settings: string;
  /** ~/.claude/settings.local.json */
  settingsLocal: string;
  /** ~/.claude/CLAUDE.md */
  claudeMd: string;
  /** ~/.claude/AGENTS.md (the Codex-flavored twin some setups keep here too) */
  agentsMd: string;
  /** ~/.claude/agents */
  agentsDir: string;
  /** ~/.claude/commands */
  commandsDir: string;
  /** ~/.claude/hooks */
  hooksDir: string;
  /** ~/.claude/statusline */
  statuslineDir: string;
  /** ~/.claude/skills */
  skillsDir: string;
  /** ~/.claude/rules (referenced by CLAUDE.md on most setups) */
  rulesDir: string;
  /** ~/.claude/scripts (hook dispatchers referenced by hooks.json) */
  scriptsDir: string;
  /** ~/.claude/output-styles */
  outputStylesDir: string;
  /** ~/.claude/keybindings.json */
  keybindings: string;
  /** ~/.claude/mcp-configs */
  mcpConfigsDir: string;
  /** ~/.claude/plugins */
  pluginsDir: string;
  /** ~/.claude/plugins/installed_plugins.json */
  installedPlugins: string;
  /** ~/.claude/plugins/known_marketplaces.json */
  knownMarketplaces: string;
  /**
   * ~/.claude.json — the SIBLING global-state file (auth + telemetry + project
   * history). Never captured as a file; only its `mcpServers` /
   * `projects.<path>.mcpServers` sub-objects are lifted into the manifest.
   */
  globalState: string;
  /** ~/.claude/projects — per-project state; only `<slug>/memory` is captured. */
  projectsDir: string;
}

/**
 * Build the absolute Claude path set.
 * @param overrideHome optional home dir (tests point this at a fixture); when
 *                     omitted, the live ~/.claude is used.
 */
export function paths(overrideHome?: string): ClaudePaths {
  const base = overrideHome ?? home();
  return {
    home: base,
    settings: path.join(base, "settings.json"),
    settingsLocal: path.join(base, "settings.local.json"),
    claudeMd: path.join(base, "CLAUDE.md"),
    agentsMd: path.join(base, "AGENTS.md"),
    agentsDir: path.join(base, "agents"),
    commandsDir: path.join(base, "commands"),
    hooksDir: path.join(base, "hooks"),
    statuslineDir: path.join(base, "statusline"),
    skillsDir: path.join(base, "skills"),
    rulesDir: path.join(base, "rules"),
    scriptsDir: path.join(base, "scripts"),
    outputStylesDir: path.join(base, "output-styles"),
    keybindings: path.join(base, "keybindings.json"),
    mcpConfigsDir: path.join(base, "mcp-configs"),
    pluginsDir: path.join(base, "plugins"),
    installedPlugins: path.join(base, "plugins", "installed_plugins.json"),
    knownMarketplaces: path.join(base, "plugins", "known_marketplaces.json"),
    globalState: path.join(path.dirname(base), ".claude.json"),
    projectsDir: path.join(base, "projects"),
  };
}

/**
 * Files/dirs to FREEZE (copy into the repo), relative to the tool home, in
 * capture order. Directories are walked recursively by capture.ts. Anything
 * matching the denylist is skipped during that walk.
 *
 * NOTE: CLAUDE.md is included here but capture may skip it when R9 shared
 * instructions are active (the backup command passes skipInstructions).
 */
export const FROZEN_PATHS: readonly string[] = [
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "hooks",
  "statusline",
  "skills",
  "rules",
  "scripts",
  "output-styles",
  "keybindings.json",
  "mcp-configs",
  "AGENTS.md",
] as const;

/** Basename of the Claude global instructions file (R9). */
export const INSTRUCTIONS_FILE = "CLAUDE.md";

/**
 * Top-level entries arbella deliberately leaves alone, beyond what the denylist
 * already excludes. They are NOT "unknown": each is either a secret store, live
 * machine state, or something the manifest reinstalls — so surfacing them in the
 * `status` "not backed up" hint would be noise, not information.
 */
const KNOWN_UNMANAGED: readonly string[] = [
  ".credentials.json", // secret store; `arbella secrets` owns it
  ".claude.json", // global state; only its mcpServers reach the manifest
  "plugins", // reinstalled from manifest.plugins
  "projects", // per-project state; memories are carried separately (A4)
  "todos", // ephemeral per-session scratch state
];

/**
 * List the top-level entries of a Claude home that arbella neither captures nor
 * knowingly ignores — the "you have stuff here we don't carry" hint for
 * `arbella status`.
 *
 * Pure over the injected fs (no node:fs, no clock) so it is testable against a
 * fixture dir. Absence of the home yields an empty list. Result is sorted.
 */
export async function listUnmanagedEntries(
  toolHome: string,
  fsSvc: FsService,
): Promise<string[]> {
  const deny = denylistFor("claude");
  const frozen = new Set<string>(FROZEN_PATHS);
  const known = new Set<string>(KNOWN_UNMANAGED);

  const entries = await fsSvc.list(toolHome);
  const out = entries.filter(
    (name) => !frozen.has(name) && !known.has(name) && !matchesDeny(name, deny),
  );
  return out.sort();
}
