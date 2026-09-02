/**
 * Unit tests for the `shared/home` provenance index (S5).
 *
 * The scenario the index exists for: a push from a machine where one of the
 * tools is not installed. Without provenance, shared/home is a flat tree with no
 * per-tool structure, so the mirror wipes the absent tool's carried scripts out
 * of the repo — and the next pull on the other machine restores a setup with
 * holes in it. `mergeHomeIndex` is pure, so the whole rule is testable here.
 */

import { describe, it, expect } from "vitest";

import {
  EXTRA_PATHS_ORIGIN,
  HOME_INDEX_VERSION,
  emptyHomeIndex,
  mergeHomeIndex,
  parseHomeIndex,
} from "../../src/core/homefiles/home-index.js";
import type { HomeIndex } from "../../src/core/homefiles/home-index.js";

const CLAUDE_FILE = "shared/home/.agents/hooks/claude-dispatch.sh";
const CODEX_FILE = "shared/home/.agents/hooks/codex-dispatch.sh";
const EXTRA_FILE = "shared/home/.agents/memory/MEMORY.md";

/** A committed index recording one file per origin. */
function previousIndex(): HomeIndex {
  return parseHomeIndex({
    version: 1,
    files: {
      [CLAUDE_FILE]: ["claude"],
      [CODEX_FILE]: ["codex"],
      [EXTRA_FILE]: [EXTRA_PATHS_ORIGIN],
    },
  });
}

describe("mergeHomeIndex: a tool that did not run keeps its files", () => {
  it("keeps the absent tool's files and rewrites the present tool's", () => {
    // Claude captured here; Codex is not installed on this machine.
    const merged = mergeHomeIndex(
      previousIndex(),
      [{ repoPath: CLAUDE_FILE, origin: "claude" }],
      new Set(["claude", EXTRA_PATHS_ORIGIN]),
    );

    expect(merged.kept).toEqual([CODEX_FILE]);
    expect(merged.expected).toEqual([CLAUDE_FILE, CODEX_FILE].sort());
    expect(merged.index.files[CODEX_FILE]).toEqual(["codex"]);
  });

  it("drops a file the PRESENT tool no longer produces", () => {
    // Claude ran and did not emit its file this time: the user deleted the hook,
    // and a mirror has to reflect that.
    const merged = mergeHomeIndex(
      previousIndex(),
      [],
      new Set(["claude", "codex", EXTRA_PATHS_ORIGIN]),
    );

    expect(merged.kept).toEqual([]);
    expect(merged.expected).toEqual([]);
    expect(merged.index.files).toEqual({});
  });

  it("recomputes extraPaths on every push", () => {
    // extraPaths always counts as having run — its files come from the live
    // config — so an entry it no longer produces was removed on purpose.
    const merged = mergeHomeIndex(
      previousIndex(),
      [{ repoPath: CLAUDE_FILE, origin: "claude" }],
      new Set(["claude", "codex", EXTRA_PATHS_ORIGIN]),
    );

    expect(merged.kept).toEqual([]);
    expect(merged.expected).toEqual([CLAUDE_FILE]);
  });

  it("keeps a file only when EVERY origin was absent", () => {
    const shared = parseHomeIndex({
      version: 1,
      files: { [CLAUDE_FILE]: ["claude", "codex"] },
    });

    // Codex ran and no longer produces it, so the deletion is real even though
    // Claude (the other origin) was absent.
    const merged = mergeHomeIndex(shared, [], new Set(["codex"]));
    expect(merged.kept).toEqual([]);

    // Neither ran: the file survives untouched.
    const untouched = mergeHomeIndex(shared, [], new Set([EXTRA_PATHS_ORIGIN]));
    expect(untouched.kept).toEqual([CLAUDE_FILE]);
  });

  it("unions the origins of a file two tools both reference", () => {
    const merged = mergeHomeIndex(
      emptyHomeIndex(),
      [
        { repoPath: CLAUDE_FILE, origin: "codex" },
        { repoPath: CLAUDE_FILE, origin: "claude" },
      ],
      new Set(["claude", "codex", EXTRA_PATHS_ORIGIN]),
    );

    expect(merged.index.files[CLAUDE_FILE]).toEqual(["claude", "codex"]);
  });

  it("writes a diff-stable, key-sorted index", () => {
    const merged = mergeHomeIndex(
      emptyHomeIndex(),
      [
        { repoPath: CODEX_FILE, origin: "codex" },
        { repoPath: CLAUDE_FILE, origin: "claude" },
      ],
      new Set(["claude", "codex"]),
    );

    expect(Object.keys(merged.index.files)).toEqual([CLAUDE_FILE, CODEX_FILE].sort());
    expect(merged.index.version).toBe(HOME_INDEX_VERSION);
  });
});

describe("parseHomeIndex: tolerates anything on disk", () => {
  it("degrades a corrupt or foreign index to 'no provenance recorded'", () => {
    for (const junk of [
      undefined,
      null,
      "not json at all",
      42,
      [],
      { version: 1 },
      { version: 1, files: "nope" },
      { files: { [CLAUDE_FILE]: "claude" } }, // origins must be an array
      { files: { [CLAUDE_FILE]: [] } }, // no origins recorded -> no claim
      { files: { "": ["claude"] } },
    ]) {
      expect(parseHomeIndex(junk).files).toEqual({});
    }
  });

  it("a corrupt index means the mirror falls back to wipe-and-rewrite", () => {
    // Nothing is "kept" when there is no provenance to justify keeping it —
    // the pre-index behavior, which is the right failure mode: a push from the
    // machine that has everything repairs the index on the spot.
    const merged = mergeHomeIndex(
      parseHomeIndex({ garbage: true }),
      [{ repoPath: CLAUDE_FILE, origin: "claude" }],
      new Set(["claude"]),
    );

    expect(merged.kept).toEqual([]);
    expect(merged.expected).toEqual([CLAUDE_FILE]);
  });

  it("keeps only well-formed entries out of a partly-broken index", () => {
    const parsed = parseHomeIndex({
      files: { [CLAUDE_FILE]: ["claude", "", 7], [CODEX_FILE]: null },
    });

    expect(parsed.files).toEqual({ [CLAUDE_FILE]: ["claude"] });
  });
});
