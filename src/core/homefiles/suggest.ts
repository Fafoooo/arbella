/**
 * `extraPaths` suggestions for `arbella init`.
 *
 * The point of the init prompt is that the user should not have to KNOW that
 * their hooks live in `~/.agents/hooks` — arbella already reads the configs that
 * point there. This module runs a deliberately LIGHTWEIGHT probe (four small
 * files, no capture, no npm, no shelling out), pulls the linked script paths out
 * of them with the pure scanner, and offers their parent DIRECTORIES as
 * `~/`-relative suggestions.
 *
 * Directories rather than files on purpose: a hook dispatcher rarely lives
 * alone, and carrying `~/.agents/hooks` keeps the sibling scripts it sources
 * working too. Individual linked scripts are captured regardless — these
 * suggestions only widen the net.
 *
 * Everything is best-effort: a missing or malformed file contributes nothing and
 * never throws. All I/O goes through the injected FsService.
 */

import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type { FsService } from "../../types.js";
import { isPlainObject } from "../../utils/object.js";

import type { CommandRef } from "./scan.js";
import {
  collectCommandRefs,
  extractHomePathCandidates,
  homeRelativePosix,
  isUnderHome,
} from "./scan.js";

/** What the probe needs to know about this machine. Injected for testability. */
export interface SuggestInputs {
  fs: FsService;
  /** Absolute $HOME. */
  home: string;
  /** Absolute ~/.claude (its settings + the sibling ~/.claude.json are read). */
  claudeHome: string;
  /** Absolute ~/.codex (hooks.json + config.toml are read). */
  codexHome: string;
  /** Tool homes whose contents are already captured and must not be suggested. */
  excludeRoots: readonly string[];
}

/**
 * Extra directories worth suggesting even when nothing links to them yet:
 * well-known homes for content the user authored but no tool config references.
 */
const WELL_KNOWN_EXTRAS = [".agents/memory"] as const;

/**
 * $HOME-relative directories that are never worth suggesting as `extraPaths`.
 *
 * These are BIN dirs: everything in them is an installed program or a shim, and
 * offering `~/.local/bin` would invite the user to carry a few hundred
 * machine-specific binaries into a git repo — where the size cap would drop most
 * of them anyway. The individual script a config actually points at is captured
 * on its own regardless, which is the part worth having.
 */
const BINARY_DIRS: ReadonlySet<string> = new Set([
  ".local/bin",
  "bin",
  ".cargo/bin",
  "go/bin",
  ".npm-global/bin",
]);

/** Read + JSON.parse a file, or undefined when it is absent/unreadable/invalid. */
async function readJson(fsSvc: FsService, abs: string): Promise<unknown | undefined> {
  if ((await fsSvc.statKind(abs)) !== "file") return undefined;
  try {
    return JSON.parse(await fsSvc.read(abs));
  } catch {
    return undefined;
  }
}

/**
 * Command refs from ~/.claude.json, restricted to its two MCP sub-objects.
 * Every other key of that file (OAuth account, telemetry, project history) is
 * left untouched, exactly as in the capture path.
 */
function claudeGlobalStateRefs(parsed: unknown): CommandRef[] {
  if (!isPlainObject(parsed)) return [];
  const scope: Record<string, unknown> = {};
  if (isPlainObject(parsed.mcpServers)) scope.mcpServers = parsed.mcpServers;
  if (isPlainObject(parsed.projects)) {
    const projects: Record<string, unknown> = {};
    for (const [absPath, project] of Object.entries(parsed.projects)) {
      if (isPlainObject(project) && isPlainObject(project.mcpServers)) {
        projects[absPath] = { mcpServers: project.mcpServers };
      }
    }
    if (Object.keys(projects).length > 0) scope.projects = projects;
  }
  return collectCommandRefs(scope, "claude:.claude.json");
}

/** Command refs from ~/.codex/config.toml's `[mcp_servers.*]` tables. */
async function codexConfigRefs(fsSvc: FsService, abs: string): Promise<CommandRef[]> {
  if ((await fsSvc.statKind(abs)) !== "file") return [];
  try {
    const parsed = parseToml(await fsSvc.read(abs)) as Record<string, unknown>;
    const servers = parsed["mcp_servers"];
    if (servers === undefined) return [];
    return collectCommandRefs({ mcp_servers: servers }, "codex:config.toml");
  } catch {
    return [];
  }
}

/**
 * `~/`-relative directories to offer as `extraPaths` defaults, sorted and
 * deduplicated. Never suggests anything inside a tool home (already captured),
 * $HOME itself, or a well-known binary directory ({@link BINARY_DIRS}).
 */
export async function suggestExtraPaths(inputs: SuggestInputs): Promise<string[]> {
  const { fs: fsSvc, home, claudeHome, codexHome, excludeRoots } = inputs;

  const refs: CommandRef[] = [
    ...collectCommandRefs(
      await readJson(fsSvc, path.join(claudeHome, "settings.json")),
      "claude:settings.json",
    ),
    ...collectCommandRefs(
      await readJson(fsSvc, path.join(claudeHome, "settings.local.json")),
      "claude:settings.local.json",
    ),
    ...claudeGlobalStateRefs(
      await readJson(fsSvc, path.join(path.dirname(claudeHome), ".claude.json")),
    ),
    ...collectCommandRefs(
      await readJson(fsSvc, path.join(codexHome, "hooks.json")),
      "codex:hooks.json",
    ),
    ...(await codexConfigRefs(fsSvc, path.join(codexHome, "config.toml"))),
  ];

  const suggestions = new Set<string>();

  for (const ref of refs) {
    for (const abs of extractHomePathCandidates(ref, home)) {
      if (excludeRoots.some((root) => abs === root || isUnderHome(abs, root))) continue;
      const parent = path.dirname(abs);
      const rel = homeRelativePosix(home, parent);
      // A script sitting directly in $HOME would suggest "~/" — far too wide.
      if (rel === null || rel === "") continue;
      if (BINARY_DIRS.has(rel)) continue;
      if (excludeRoots.some((root) => parent === root || isUnderHome(parent, root))) continue;
      suggestions.add(`~/${rel}`);
    }
  }

  for (const rel of WELL_KNOWN_EXTRAS) {
    const abs = path.join(home, ...rel.split("/"));
    if ((await fsSvc.statKind(abs)) === "dir") suggestions.add(`~/${rel}`);
  }

  return [...suggestions].sort();
}
