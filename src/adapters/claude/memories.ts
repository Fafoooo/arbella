/**
 * Claude per-project memory (R13): ~/.claude/projects/<slug>/memory/**.
 *
 * `projects/` as a whole is denylisted — it is session state, history and
 * machine-local bookkeeping. The `memory/` subdirectory is the exception: it is
 * user-authored knowledge about a project and the only part worth carrying. It is
 * gated on `ctx.includeMemories`, exactly like the codex adapter's memories/ dir.
 *
 * Storage layout (repo-relative, POSIX):
 *
 *   claude/memories/home/<rest>/…   project under $HOME; <rest> is the slug with
 *                                   the $HOME prefix stripped, so the same repo
 *                                   restores under a DIFFERENT home. The $HOME
 *                                   project itself (rest === "") uses the "ROOT"
 *                                   sentinel, since an empty path segment cannot
 *                                   be stored.
 *   claude/memories/abs/<slug>/…    everything else (a project on another volume),
 *                                   kept verbatim — there is nothing portable to
 *                                   fold, and inventing a mapping would be worse
 *                                   than an honest absolute slug.
 *
 * Slugging mirrors Claude Code's own project-dir naming: every non-alphanumeric
 * character becomes "-" ("/Users/fab" -> "-Users-fab", "C:\Users\fab" ->
 * "C--Users-fab"). Only the HOME PREFIX is re-slugged on restore; the tail is
 * stored and restored verbatim, because Claude's slug rules for "_" have changed
 * over time and both `aau_26S_Logik` and `aau-26S-Logik` dirs exist in the wild.
 * Preserving the tail keeps whichever spelling the local Claude actually uses.
 *
 * All fs access goes through the injected context; the path helpers are pure.
 */

import path from "node:path";

import type { CaptureContext } from "../adapter.interface.js";
import { matchesDeny } from "../../core/sanitizer/denylist.js";

/** Repo prefix (POSIX) for every memory file this adapter emits. */
export const MEMORIES_REPO_PREFIX = "claude/memories";

/** Sub-root for projects that live under $HOME (portable). */
export const HOME_SCOPE = "home";

/** Sub-root for projects outside $HOME (stored with their verbatim slug). */
export const ABS_SCOPE = "abs";

/** Stand-in for the empty tail when the project IS $HOME itself. */
export const ROOT_SENTINEL = "ROOT";

/** The per-project subdirectory that actually holds memories. */
export const MEMORY_DIR = "memory";

/**
 * Slugify an absolute path the way Claude Code names its project dirs: every
 * character outside [A-Za-z0-9] becomes "-". Pure.
 */
export function slugifyPath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The repo path for one memory file.
 * @param slug       the on-disk project dir name under ~/.claude/projects
 * @param homeSlug   slugifyPath(vars.HOME)
 * @param relPosix   path of the file relative to the project's memory/ dir
 */
export function memoryRepoPath(slug: string, homeSlug: string, relPosix: string): string {
  if (slug.startsWith(homeSlug)) {
    const rest = slug.slice(homeSlug.length);
    return `${MEMORIES_REPO_PREFIX}/${HOME_SCOPE}/${rest === "" ? ROOT_SENTINEL : rest}/${relPosix}`;
  }
  return `${MEMORIES_REPO_PREFIX}/${ABS_SCOPE}/${slug}/${relPosix}`;
}

/** Path segments that must never appear in a repo-supplied path component. */
function isTraversalSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === "..";
}

/**
 * Absolute destination for a stored memory file on THIS machine, or null when
 * the repo path is not a well-formed memory path (caller logs + skips).
 *
 * Every component that comes from the REPO — the project key and each file
 * segment — is rejected when it is "", "." or "..": the result is joined onto
 * the tool home, and a single `..` would walk a pull's write straight out of
 * ~/.claude. (A slug cannot legitimately contain a dot at all: slugifyPath maps
 * every non-alphanumeric character to "-".)
 *
 * Pure: everything it needs (the target tool home and the target machine's home
 * slug) is passed in.
 */
export function memoryTargetPath(
  toolHome: string,
  homeSlug: string,
  repoPath: string,
): string | null {
  const prefix = `${MEMORIES_REPO_PREFIX}/`;
  if (!repoPath.startsWith(prefix)) return null;

  const segs = repoPath.slice(prefix.length).split("/").filter((s) => s.length > 0);
  // [scope, slugOrRest, ...file] — a scope + project with no file is not a file.
  if (segs.length < 3) return null;
  const [scope, key, ...fileParts] = segs as [string, string, ...string[]];
  if (isTraversalSegment(key) || fileParts.some(isTraversalSegment)) return null;

  let projectDir: string;
  if (scope === HOME_SCOPE) {
    projectDir = key === ROOT_SENTINEL ? homeSlug : `${homeSlug}${key}`;
  } else if (scope === ABS_SCOPE) {
    projectDir = key;
  } else {
    return null;
  }

  return path.join(toolHome, "projects", projectDir, MEMORY_DIR, ...fileParts);
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How capture materializes one memory file. capture.ts owns the read/sanitize/
 * template/mode logic (shared with every other frozen file); this module only
 * decides WHICH files and WHERE they go.
 *
 * @param abs       absolute path on this machine
 * @param repoPath  repo-relative POSIX destination
 * @param source    label for sanitizer SecretRefs + warnings
 */
export type FreezeMemoryFile = (
  abs: string,
  repoPath: string,
  source: string,
) => Promise<void>;

/**
 * Walk ~/.claude/projects/<slug>/memory/** and freeze every file.
 *
 * Only the TOP level of projects/ is enumerated; a project without a memory/ dir
 * is skipped silently (that is the common case). The denylist is applied to each
 * file's path RELATIVE TO ITS memory/ DIR — the tool-home-relative path would
 * start with "projects/", which is denylisted wholesale and would exclude
 * everything.
 *
 * For the same reason `deny` must be COMMON_DENY, not the full Claude list: the
 * paths handed to it are memory-relative, so a ROOT-ANCHORED Claude pattern
 * ("/feedback/", "/plugins/", "/ecc/") — written to exclude ~/.claude/feedback —
 * would match a memory subdirectory that merely happens to share the name and
 * silently drop the user's notes. The caller passes the right list; this walk
 * only applies it.
 */
export async function captureMemories(
  ctx: CaptureContext,
  projectsDir: string,
  homeSlug: string,
  deny: string[],
  freeze: FreezeMemoryFile,
): Promise<void> {
  if ((await ctx.fs.statKind(projectsDir)) !== "dir") return;

  const slugs = await ctx.fs.list(projectsDir);
  slugs.sort();

  for (const slug of slugs) {
    const memoryDir = path.join(projectsDir, slug, MEMORY_DIR);
    if ((await ctx.fs.statKind(memoryDir)) !== "dir") continue;
    await walkMemory(ctx, memoryDir, [], slug, homeSlug, deny, freeze);
  }
}

/** Recurse one project's memory/ dir, freezing files as it goes. */
async function walkMemory(
  ctx: CaptureContext,
  absDir: string,
  relParts: string[],
  slug: string,
  homeSlug: string,
  deny: string[],
  freeze: FreezeMemoryFile,
): Promise<void> {
  const entries = await ctx.fs.list(absDir);
  entries.sort();

  for (const name of entries) {
    const abs = path.join(absDir, name);
    const nextRel = [...relParts, name];
    const relPosix = nextRel.join("/");

    if (matchesDeny(relPosix, deny)) {
      ctx.log.debug(`claude: skip memory (denylist) ${slug}/${MEMORY_DIR}/${relPosix}`);
      continue;
    }

    const kind = await ctx.fs.statKind(abs);
    if (kind === "dir") {
      await walkMemory(ctx, abs, nextRel, slug, homeSlug, deny, freeze);
      continue;
    }
    // Symlinked memories point at machine-specific targets; carrying the link
    // would restore a dangling path, so only real files are frozen.
    if (kind !== "file") continue;

    await freeze(
      abs,
      memoryRepoPath(slug, homeSlug, relPosix),
      `projects/${slug}/${MEMORY_DIR}/${relPosix}`,
    );
  }
}
