/**
 * All Codex-specific path knowledge for the arbella Codex adapter.
 *
 * This is the ONE place that encodes where things live under ~/.codex. Every
 * other Codex module (capture/restore/configToml/index) asks here rather than
 * re-deriving paths, so a layout change is a single-file edit.
 *
 * Cross-OS: the tool home is resolved via src/platform/os.ts (toolHomeDir),
 * never hardcoded. All sub-paths are built with node:path.join so separators are
 * correct on win32 as well. The `repoPath` prefix, by contrast, is a POSIX-only
 * string used inside the backup repo and is intentionally a literal.
 *
 * Verified against the live ~/.codex: config.toml, AGENTS.md,
 * agents/*.toml, hooks/ (+ hooks.json), rules/, prompts/, skills/, vendor_imports/,
 * and memories/ (gated by includeMemories).
 */

import path from "node:path";

import { toolHomeDir } from "../../platform/os.js";

/** Absolute path to ~/.codex on this machine. */
export function home(): string {
  return toolHomeDir("codex");
}

/**
 * Prefix (POSIX) for every CapturedFile.repoPath this adapter emits.
 * A file at `<home>/X` is stored at `codex/files/X` in the backup repo.
 */
export const REPO_PREFIX = "codex/files";

/** Fully-resolved set of Codex paths, all absolute. */
export interface CodexPaths {
  /** ~/.codex */
  home: string;
  /** ~/.codex/config.toml */
  configToml: string;
  /** ~/.codex/AGENTS.md */
  agentsMd: string;
  /** ~/.codex/agents (per-agent *.toml definitions) */
  agentsDir: string;
  /** ~/.codex/hooks (shell + python hook scripts, executable) */
  hooksDir: string;
  /** ~/.codex/hooks.json (hook registration; contains absolute paths) */
  hooksJson: string;
  /** ~/.codex/rules */
  rulesDir: string;
  /** ~/.codex/prompts */
  promptsDir: string;
  /** ~/.codex/skills */
  skillsDir: string;
  /** ~/.codex/memories (only frozen when includeMemories) */
  memoriesDir: string;
  /** ~/.codex/vendor_imports */
  vendorImportsDir: string;
}

/**
 * Build the absolute Codex path set.
 * @param overrideHome optional home dir (tests point this at a fixture); when
 *                     omitted, the live ~/.codex is used.
 */
export function paths(overrideHome?: string): CodexPaths {
  const base = overrideHome ?? home();
  return {
    home: base,
    configToml: path.join(base, "config.toml"),
    agentsMd: path.join(base, "AGENTS.md"),
    agentsDir: path.join(base, "agents"),
    hooksDir: path.join(base, "hooks"),
    hooksJson: path.join(base, "hooks.json"),
    rulesDir: path.join(base, "rules"),
    promptsDir: path.join(base, "prompts"),
    skillsDir: path.join(base, "skills"),
    memoriesDir: path.join(base, "memories"),
    vendorImportsDir: path.join(base, "vendor_imports"),
  };
}

/**
 * Files/dirs to FREEZE (copy into the repo), relative to the tool home, in
 * capture order. Directories are walked recursively by capture.ts. Anything
 * matching the denylist is skipped during that walk.
 *
 * NOTE: config.toml is included here but capture routes it through
 * configToml.ts (sanitize + template + strip) rather than the generic file
 * walk. AGENTS.md is included but capture may skip it when R9 shared
 * instructions are active (the backup command passes skipInstructions).
 * "memories" is appended dynamically by capture.ts only when includeMemories.
 */
export const FROZEN_PATHS: readonly string[] = [
  "config.toml",
  "AGENTS.md",
  "agents",
  "hooks",
  "hooks.json",
  "rules",
  "prompts",
  "skills",
  "vendor_imports",
] as const;

/** Basename of the Codex global instructions file (R9). */
export const INSTRUCTIONS_FILE = "AGENTS.md";

/** Basename of the Codex config file routed through configToml.ts. */
export const CONFIG_FILE = "config.toml";

/** Relative dir name for memories (gated by includeMemories). */
export const MEMORIES_DIR = "memories";
