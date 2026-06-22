/**
 * All GitHub Copilot CLI path knowledge for the arbella copilot adapter.
 *
 * GitHub Copilot CLI (npm `@github/copilot`, binary `copilot`) stores its setup
 * in ~/.copilot by default (override with the COPILOT_HOME env var, honored by
 * toolHomeDir). The portable parts are config.json (core prefs), mcp-config.json
 * (user-level MCP servers), and agents/ (custom agents). The machine-local /
 * sensitive artifacts — session-state/, logs/, ide/, restart/, the skills/ dir,
 * and command-history-state.json — are excluded by the denylist. Copilot signs in
 * via gh/device flow, so there is no portable credential file to bundle.
 *
 * The tool home is resolved via src/platform/os.ts (toolHomeDir); the repoPath
 * prefix is a POSIX literal used inside the backup repo.
 */

import { toolHomeDir } from "../../platform/os.js";

/** Absolute path to Copilot CLI's config dir on this machine. */
export function home(): string {
  return toolHomeDir("copilot");
}

/** A file at `<home>/X` is stored at `copilot/files/X` in the backup repo. */
export const REPO_PREFIX = "copilot/files";

/**
 * Files/dirs to FREEZE (copy into the repo), relative to the config home, in
 * capture order. Anything matching the denylist is skipped during capture
 * regardless of its presence here.
 */
export const FROZEN_PATHS: readonly string[] = [
  "config.json",
  "mcp-config.json",
  "agents",
] as const;

/** Fully-resolved set of Copilot CLI paths, all absolute. */
export interface CopilotPaths {
  /** ~/.copilot (or $COPILOT_HOME) */
  home: string;
}

/**
 * Build the absolute Copilot path set.
 * @param overrideHome optional home dir (tests point this at a fixture); when
 *                     omitted, the live config dir is used.
 */
export function paths(overrideHome?: string): CopilotPaths {
  return { home: overrideHome ?? home() };
}
