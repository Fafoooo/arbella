/**
 * All Cursor-specific path knowledge for the arbella Cursor adapter.
 *
 * This is the ONE place that encodes where things live under ~/.cursor. The
 * Cursor adapter (index.ts) asks here rather than re-deriving paths, so a layout
 * change is a single-file edit.
 *
 * Cross-OS: the tool home is resolved via src/platform/os.ts (toolHomeDir),
 * never hardcoded. All sub-paths are built with node:path.join so separators are
 * correct on win32 as well. The `repoPath` prefix, by contrast, is a POSIX-only
 * string used inside the backup repo and is intentionally a literal.
 *
 * Cursor reality: Cursor is a desktop app and may be entirely absent (the IDE has
 * no headless install on Linux). It ALSO ships a terminal CLI, `cursor-agent`,
 * which SHARES this same ~/.cursor config dir (adding cli-config.json and global
 * commands/) and does run on Linux. Portable global state is split between
 * `~/.cursor` (MCP config, skills, rules, CLI config, commands) and the VS Code-
 * style application User directory (settings, keybindings, snippets). The CLI's
 * own runtime/credentials live under ~/.local/share/cursor-agent (a different
 * home this adapter never touches); runtime state, projects, workspace DBs,
 * worktrees, and extension payloads remain out of scope.
 */

import path from "node:path";

import type { EnvVars, OS } from "../../types.js";
import { appUserConfigRoot, toolHomeDir } from "../../platform/os.js";

/** Absolute path to ~/.cursor on this machine. */
export function home(): string {
  return toolHomeDir("cursor");
}

/**
 * Prefix (POSIX) for every CapturedFile.repoPath this adapter emits.
 * A file at `<home>/X` is stored at `cursor/files/X` in the backup repo.
 */
export const REPO_PREFIX = "cursor/files";

/**
 * Prefix (POSIX) for Cursor application User data. A file at
 * `<Cursor User>/X` is stored at `cursor/user/X` in the backup repo.
 */
export const USER_REPO_PREFIX = "cursor/user";

/** Fully-resolved set of Cursor paths, all absolute. */
export interface CursorPaths {
  /** ~/.cursor */
  home: string;
  /** ~/.cursor/mcp.json */
  mcpJson: string;
  /** ~/.cursor/skills */
  skillsDir: string;
}

/** Fully-resolved Cursor application User data paths, all absolute. */
export interface CursorUserPaths {
  /** VS Code-style Cursor User data directory. */
  userDir: string;
  /** settings.json */
  settingsJson: string;
  /** keybindings.json */
  keybindingsJson: string;
  /** snippets directory */
  snippetsDir: string;
}

/**
 * Build the absolute Cursor path set.
 * @param overrideHome optional home dir (tests point this at a fixture); when
 *                     omitted, the live ~/.cursor is used.
 */
export function paths(overrideHome?: string): CursorPaths {
  const base = overrideHome ?? home();
  return {
    home: base,
    mcpJson: path.join(base, "mcp.json"),
    skillsDir: path.join(base, "skills"),
  };
}

/**
 * Build Cursor's platform-specific app User data paths from the tool home. The
 * tests pass a fixture tool home; live code passes the real ~/.cursor.
 */
export function cursorUserPaths(toolHome: string, os: OS, env: EnvVars = {}): CursorUserPaths {
  const userHome = path.dirname(toolHome);
  const userDir = path.join(appUserConfigRoot(os, userHome, env), "Cursor", "User");

  return {
    userDir,
    settingsJson: path.join(userDir, "settings.json"),
    keybindingsJson: path.join(userDir, "keybindings.json"),
    snippetsDir: path.join(userDir, "snippets"),
  };
}

/**
 * Files/dirs to FREEZE (copy into the repo), relative to the tool home, in
 * capture order. Cursor's `skills` dir is intentionally included: symlinked
 * skills are recorded as reinstallable skills.sh entries, while local skill dirs
 * are frozen just like Claude/Codex local skills.
 *
 * The trailing three cover the Cursor CLI (cursor-agent), which shares ~/.cursor
 * with the IDE: `cli-config.json` is its user config (editor prefs, permission
 * allow/deny, model, notifications — no credentials), `commands/` holds global
 * slash-command markdown shared by IDE + CLI, and `rules/` holds global rules
 * when present (harmless if absent — capture skips missing paths).
 *
 * NOTE: anything matching the denylist is skipped during capture regardless of
 * its presence here.
 */
export const FROZEN_PATHS: readonly string[] = [
  "mcp.json",
  "skills",
  "cli-config.json",
  "commands",
  "rules",
] as const;
