/**
 * Provenance for the cross-tool `shared/home` root: which tool's capture put
 * each carried file there.
 *
 * `shared/home` is a MIRROR — a push wipes it and rewrites it from what this
 * run produced — and that is exactly right for the machine that captured
 * everything. It is destructive for every other machine: push from a laptop
 * where Codex is not installed, and every `~/.agents/hooks/*` script that only
 * the Codex capture knows about is deleted from the repo. The next pull on the
 * desktop then silently restores a setup with holes in it.
 *
 * A per-tool root cannot have this problem (`replaceToolFiles` only wipes roots
 * belonging to tools it actually captured). shared/home has no per-tool
 * structure to key off — one flat tree fed by every adapter plus `extraPaths` —
 * so the provenance has to be recorded next to it:
 *
 *     shared/home-index.json
 *     { "version": 1, "files": { "shared/home/.agents/hooks/x.sh": ["codex"] } }
 *
 * The rule the index buys, implemented once in {@link mergeHomeIndex} and used
 * by BOTH `push` (what to delete) and `status` (what to report as removed):
 *
 *     a CLAIM is dropped only by the origin that made it. An origin that RAN
 *     this run and no longer produces the file loses its claim; an origin that
 *     was ABSENT keeps it. The file survives while any claim survives, and is
 *     deleted only when the last one is gone.
 *
 * That per-origin accounting is why a produced file also merges the ABSENT
 * origins of its previous entry back in. Rewriting the entry with only this
 * run's origins would silently forget the other tool's claim, and the NEXT push
 * — from a machine where this tool no longer produces the file — would then see
 * a single expired claim and delete a file the absent tool still needs.
 *
 * `extraPaths` counts as present on every push: its files are recomputed from
 * the live config each time, so a file it no longer produces is a file the user
 * removed on purpose.
 *
 * `mergeHomeIndex`'s `produced` argument must be fed CLAIMS — every
 * (repoPath, origin) pair a run produced, INCLUDING duplicates where two
 * origins claim the same repoPath — not the deduped FILE list a caller writes
 * to disk. `mergeHomeIndex` already unions duplicate claims for one repoPath
 * (see the "unions the origins" test below), so pre-dedupe input is exactly
 * what it expects; feeding it the first-wins-deduped file list instead would
 * silently drop every claim but the winning one, right when two origins
 * produce the same file in the same run — the case this module exists to get
 * right.
 *
 * Pure module: no fs, no clock. The command layer reads/writes the file.
 */

import { isPlainObject } from "../../utils/object.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

/** Repo path (POSIX) of the index. A SIBLING of shared/home, never inside it. */
export const HOME_INDEX_REPO_PATH = "shared/home-index.json";

/** Bump only for a shape change the reader cannot absorb. */
export const HOME_INDEX_VERSION = 1;

/** The origin label for files produced by `config.extraPaths`. */
export const EXTRA_PATHS_ORIGIN = "extraPaths";

/** repoPath -> the origins (tool ids / "extraPaths") that produced that file. */
export interface HomeIndex {
  version: number;
  files: Record<string, string[]>;
}

/** One produced file and what put it in the backup. */
export interface HomeIndexEntry {
  repoPath: string;
  origin: string;
}

/** An index recording nothing (a repo that has never carried home files). */
export function emptyHomeIndex(): HomeIndex {
  return { version: HOME_INDEX_VERSION, files: {} };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read an index that may be anything at all — absent, hand-edited, written by a
 * future version. Everything unrecognized degrades to "no provenance recorded",
 * which restores the old wipe-and-rewrite behavior for the affected entries
 * rather than failing a push. Never throws.
 */
export function parseHomeIndex(json: unknown): HomeIndex {
  if (!isPlainObject(json) || !isPlainObject(json.files)) return emptyHomeIndex();

  const files: Record<string, string[]> = {};
  for (const [repoPath, origins] of Object.entries(json.files)) {
    if (typeof repoPath !== "string" || repoPath === "") continue;
    if (!Array.isArray(origins)) continue;
    const clean = origins.filter((o): o is string => typeof o === "string" && o !== "");
    if (clean.length === 0) continue;
    files[repoPath] = uniqueSorted(clean);
  }
  return { version: HOME_INDEX_VERSION, files };
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                     */
/* -------------------------------------------------------------------------- */

/** What a merge decided: the index to write, and the files to leave on disk. */
export interface HomeIndexMerge {
  /** The index this push should commit. */
  index: HomeIndex;
  /**
   * Previously-committed repoPaths this run did not produce but must KEEP
   * untouched, because an origin that did not run here still claims them.
   */
  kept: string[];
  /** Every repoPath the merged tree should contain (produced ∪ kept), sorted. */
  expected: string[];
}

/**
 * Decide the shared/home tree for this run. See the module header for the rule.
 *
 * @param previous        the committed index (use {@link parseHomeIndex}).
 * @param produced        this run's home files with their origins.
 * @param capturedOrigins origins that RAN this run: every captured tool id, plus
 *                        {@link EXTRA_PATHS_ORIGIN} on a push (its files are
 *                        recomputed, so its absences are real).
 *
 * Pure: inputs are never mutated, and the output is deterministically ordered.
 */
export function mergeHomeIndex(
  previous: HomeIndex,
  produced: readonly HomeIndexEntry[],
  capturedOrigins: ReadonlySet<string>,
): HomeIndexMerge {
  const files: Record<string, string[]> = {};
  for (const entry of produced) {
    files[entry.repoPath] = uniqueSorted([...(files[entry.repoPath] ?? []), entry.origin]);
  }

  const kept: string[] = [];
  for (const [repoPath, origins] of Object.entries(previous.files)) {
    // Claims of origins that did NOT run this time. They cannot have been
    // withdrawn — the tool is not installed here, or its capture failed — so
    // they carry over verbatim whether or not this run produced the file.
    const absentClaims = origins.filter((origin) => !capturedOrigins.has(origin));

    if (repoPath in files) {
      // Produced here: this run's origins are authoritative for the tools that
      // ran, and the absent tools keep the claims they made earlier.
      files[repoPath] = uniqueSorted([...(files[repoPath] ?? []), ...absentClaims]);
      continue;
    }
    // Not produced here. Every origin that RAN has withdrawn its claim; the
    // file survives only while an absent origin still claims it.
    if (absentClaims.length === 0) continue;
    kept.push(repoPath);
    files[repoPath] = uniqueSorted(absentClaims);
  }

  return {
    index: { version: HOME_INDEX_VERSION, files: sortedByKey(files) },
    kept: kept.sort(),
    expected: Object.keys(files).sort(),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Unique, sorted copy. Never mutates the input. */
function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/** A copy of `obj` with its keys in lexicographic order (diff-stable output). */
function sortedByKey(obj: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key] as string[];
  return out;
}
