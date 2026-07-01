/**
 * All GitHub Copilot CLI path knowledge for the arbella copilot adapter.
 *
 * GitHub Copilot CLI (npm `@github/copilot`, binary `copilot`) stores its setup
 * in ~/.copilot by default (override with the COPILOT_HOME env var, honored by
 * toolHomeDir) — the SAME dir on macOS, Linux, and Windows (%USERPROFILE%\.copilot;
 * it does NOT use %APPDATA% or XDG). The portable, user-authored parts are
 * settings.json (the primary config file), mcp-config.json (user MCP servers),
 * lsp-config.json (user LSP servers), copilot-instructions.md + instructions/
 * (personal custom instructions), agents/ (custom agents), and hooks/ (user hook
 * scripts). config.json is deliberately NOT frozen: per GitHub's config-dir
 * reference it is auto-managed internal state holding authentication data
 * (loggedInUsers) and installed-plugin metadata — machine-local + secret, and
 * user prefs that once lived there are migrated to settings.json at startup. That,
 * plus permission/session/log/ide state and the MCP secret stores, is excluded by
 * the denylist. Copilot signs in via /login (or a COPILOT_GITHUB_TOKEN / GH_TOKEN /
 * GITHUB_TOKEN env var), so there is no portable credential file to bundle; the
 * user re-authenticates after a restore.
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
  "settings.json",
  "mcp-config.json",
  "lsp-config.json",
  "copilot-instructions.md",
  "instructions",
  "agents",
  "hooks",
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
