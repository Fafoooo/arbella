/**
 * All Claude-specific path knowledge for the arbella Claude adapter.
 *
 * This is the ONE place that encodes where things live under ~/.claude. Every
 * other Claude module (capture/restore/plugins/index) asks here rather than
 * re-deriving paths, so a layout change is a single-file edit.
 *
 * Cross-OS: the tool home is resolved via src/platform/os.ts (toolHomeDir),
 * never hardcoded. All sub-paths are built with node:path.join so separators are
 * correct on win32 as well. The `repoPath` prefix, by contrast, is a POSIX-only
 * string used inside the backup repo and is intentionally a literal.
 */

import path from "node:path";

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
  /** ~/.claude/plugins */
  pluginsDir: string;
  /** ~/.claude/plugins/installed_plugins.json */
  installedPlugins: string;
  /** ~/.claude/plugins/known_marketplaces.json */
  knownMarketplaces: string;
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
    agentsDir: path.join(base, "agents"),
    commandsDir: path.join(base, "commands"),
    hooksDir: path.join(base, "hooks"),
    statuslineDir: path.join(base, "statusline"),
    skillsDir: path.join(base, "skills"),
    pluginsDir: path.join(base, "plugins"),
    installedPlugins: path.join(base, "plugins", "installed_plugins.json"),
    knownMarketplaces: path.join(base, "plugins", "known_marketplaces.json"),
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
] as const;

/** Basename of the Claude global instructions file (R9). */
export const INSTRUCTIONS_FILE = "CLAUDE.md";
