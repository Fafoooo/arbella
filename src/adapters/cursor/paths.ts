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
 * Cursor reality: Cursor is a desktop app and may be
 * entirely absent (no CLI on Linux). The only globally-portable artifact is
 * `~/.cursor/mcp.json` (`{ "mcpServers": { ... } }`). Project-level
 * `.cursor/rules` are repo-specific and out of scope for the global backup; on
 * restore, the shared-instructions (R9) content is materialized as a Cursor user
 * rule under the rules dir.
 */

import path from "node:path";

import { toolHomeDir } from "../../platform/os.js";

/** Absolute path to ~/.cursor on this machine. */
export function home(): string {
  return toolHomeDir("cursor");
}

/**
 * Prefix (POSIX) for every CapturedFile.repoPath this adapter emits.
 * A file at `<home>/X` is stored at `cursor/files/X` in the backup repo.
 */
export const REPO_PREFIX = "cursor/files";

/** Fully-resolved set of Cursor paths, all absolute. */
export interface CursorPaths {
  /** ~/.cursor */
  home: string;
  /** ~/.cursor/mcp.json */
  mcpJson: string;
  /** ~/.cursor/skills */
  skillsDir: string;
  /** ~/.cursor/rules (global user rules; may not exist) */
  rulesDir: string;
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
    rulesDir: path.join(base, "rules"),
  };
}

/**
 * Files/dirs to FREEZE (copy into the repo), relative to the tool home, in
 * capture order. Cursor's global, portable state is just `mcp.json`. The skills
 * dir is intentionally NOT frozen here: like Claude/Codex it is a skills.sh
 * mechanism (relative symlinks into ~/.agents/skills) handled centrally, and the
 * minimal Cursor adapter keeps to the MCP config + R9 rule on restore.
 *
 * NOTE: anything matching the denylist is skipped during capture regardless of
 * its presence here.
 */
export const FROZEN_PATHS: readonly string[] = ["mcp.json"] as const;

/**
 * Repo path (POSIX) of the shared-instructions file the backup command writes at
 * the repo root when R9 is active. The Cursor adapter reads this on restore to
 * materialize a Cursor user rule.
 */
export const SHARED_INSTRUCTIONS_REPO_PATH = "shared/instructions.md";

/**
 * Basename of the Cursor user-rule file the adapter writes (under the rules dir)
 * to carry the shared CLAUDE.md/AGENTS.md instructions across to Cursor (R9).
 * `.mdc` is Cursor's rule file extension.
 */
export const SHARED_RULE_FILENAME = "arbella-shared-instructions.mdc";

/** Absolute path to the Cursor user rule deployed on restore for R9. */
export function sharedRulePath(overrideHome?: string): string {
  return path.join(paths(overrideHome).rulesDir, SHARED_RULE_FILENAME);
}
