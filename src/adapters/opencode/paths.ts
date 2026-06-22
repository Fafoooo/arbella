/**
 * All opencode-specific path knowledge for the arbella opencode adapter.
 *
 * opencode (https://opencode.ai, npm `opencode-ai`, binary `opencode`) is a
 * terminal AI agent. Its portable global setup lives in the XDG config dir
 * (~/.config/opencode by default, $XDG_CONFIG_HOME/opencode when set): the
 * opencode.json/jsonc config (which itself declares plugins + MCP servers) and
 * the user's custom agents/ and commands/ markdown. Credentials live OUTSIDE this
 * dir at ~/.local/share/opencode/auth.json and are therefore never captured. The
 * plugin-install artifacts opencode drops here (node_modules/, package.json,
 * bun.lock, package-lock.json) and the skills/ dir are excluded by the denylist —
 * they are regenerated from the config's plugin list on first run.
 *
 * The tool home is resolved via src/platform/os.ts (toolHomeDir) so it is correct
 * on every OS; the repoPath prefix is a POSIX literal used inside the backup repo.
 */

import path from "node:path";

import { toolHomeDir } from "../../platform/os.js";

/** Absolute path to opencode's config dir on this machine. */
export function home(): string {
  return toolHomeDir("opencode");
}

/** A file at `<home>/X` is stored at `opencode/files/X` in the backup repo. */
export const REPO_PREFIX = "opencode/files";

/**
 * Files/dirs to FREEZE (copy into the repo), relative to the config home, in
 * capture order. Anything matching the denylist is skipped during capture
 * regardless of its presence here.
 */
export const FROZEN_PATHS: readonly string[] = [
  "opencode.json",
  "opencode.jsonc",
  "agents",
  "commands",
] as const;

/** Fully-resolved set of opencode paths, all absolute. */
export interface OpencodePaths {
  /** ~/.config/opencode */
  home: string;
}

/**
 * Build the absolute opencode path set.
 * @param overrideHome optional home dir (tests point this at a fixture); when
 *                     omitted, the live config dir is used.
 */
export function paths(overrideHome?: string): OpencodePaths {
  return { home: overrideHome ?? home() };
}
