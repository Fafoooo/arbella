/**
 * All Kilo Code CLI path knowledge for the arbella kilo adapter.
 *
 * Kilo Code's CLI (npm `@kilocode/cli`, binary `kilo`) reads its global config
 * from the XDG config dir (~/.config/kilo by default, $XDG_CONFIG_HOME/kilo when
 * set): kilo.jsonc (the config — rules live in its `instructions` array, plus MCP
 * servers), and the user's custom agents/ and rules/. The plugin-install
 * artifacts Kilo drops here (node_modules/, package.json, bun.lock,
 * package-lock.json) and the skills/ dir are excluded by the denylist — they are
 * regenerated from the config on first run. The CLI's machine-local runtime state
 * lives in a separate ~/.kilocode/cli tree, which arbella never touches.
 *
 * This adapter intentionally covers the Kilo CLI only, not the Kilo Code VS Code
 * extension (whose state is machine-bound binary globalStorage, out of scope just
 * as Cursor's extension state is).
 *
 * The tool home is resolved via src/platform/os.ts (toolHomeDir); the repoPath
 * prefix is a POSIX literal used inside the backup repo.
 */

import { toolHomeDir } from "../../platform/os.js";

/** Absolute path to Kilo's config dir on this machine. */
export function home(): string {
  return toolHomeDir("kilo");
}

/** A file at `<home>/X` is stored at `kilo/files/X` in the backup repo. */
export const REPO_PREFIX = "kilo/files";

/**
 * Files/dirs to FREEZE (copy into the repo), relative to the config home, in
 * capture order. Anything matching the denylist is skipped during capture
 * regardless of its presence here.
 */
export const FROZEN_PATHS: readonly string[] = [
  "kilo.jsonc",
  "kilo.json",
  "agents",
  "rules",
] as const;

/** Fully-resolved set of Kilo paths, all absolute. */
export interface KiloPaths {
  /** ~/.config/kilo */
  home: string;
}

/**
 * Build the absolute Kilo path set.
 * @param overrideHome optional home dir (tests point this at a fixture); when
 *                     omitted, the live config dir is used.
 */
export function paths(overrideHome?: string): KiloPaths {
  return { home: overrideHome ?? home() };
}
