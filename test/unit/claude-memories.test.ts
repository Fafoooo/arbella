/**
 * Unit tests for Claude per-project memories (src/adapters/claude/memories.ts).
 *
 * The load-bearing property is the SLUG ROUND-TRIP: a memory captured on a
 * machine whose $HOME is /Users/fab must land under a machine whose $HOME is
 * /home/other, with Claude's own project-dir naming preserved. That is why only
 * the home PREFIX is re-slugged and the tail is stored verbatim.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

// Hermetic + fast: the adapter round-trip below drives the real capture(), which
// would otherwise shell out to `npm ls -g`. Only the shell-outs are replaced.
vi.mock("../../src/platform/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/platform/install.js")>()),
  listNpmGlobals: async () => [],
  which: async () => false,
}));

import {
  MEMORIES_REPO_PREFIX,
  captureMemories,
  memoryRepoPath,
  memoryTargetPath,
  slugifyPath,
} from "../../src/adapters/claude/memories.js";
import { capture as captureClaude } from "../../src/adapters/claude/capture.js";
import { restore as restoreClaude } from "../../src/adapters/claude/restore.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { COMMON_DENY, denylistFor } from "../../src/core/sanitizer/denylist.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import type { CaptureContext, RestoreContext } from "../../src/adapters/adapter.interface.js";

const sanitizer = createSanitizer();
const templater = createTemplater();

const silentLog = {
  info() {},
  success() {},
  warn() {},
  error() {},
  step() {},
  debug() {},
};

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-mem-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function captureCtx(
  toolHome: string,
  home: string,
  overrides: Partial<CaptureContext> = {},
): CaptureContext {
  return {
    fs: realFs,
    log: silentLog,
    sanitizer,
    templater,
    vars: makeVariables(home, "fab", "linux", toolHome),
    os: "linux",
    env: {},
    toolHome,
    includeSecrets: false,
    includeMemories: true,
    dryRun: false,
    ...overrides,
  };
}

function restoreCtx(
  toolHome: string,
  home: string,
  overrides: Partial<RestoreContext> = {},
): RestoreContext {
  return {
    fs: realFs,
    log: silentLog,
    sanitizer,
    templater,
    vars: makeVariables(home, "other", "linux", toolHome),
    os: "linux",
    env: {},
    toolHome,
    repoToolDir: path.join(tmpRoot, "repo", "claude"),
    repoRoot: path.join(tmpRoot, "repo"),
    sourceOfTruth: "repo",
    dryRun: false,
    ...overrides,
  };
}

async function writeFile(abs: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

/* -------------------------------------------------------------------------- */
/* Slugging                                                                    */
/* -------------------------------------------------------------------------- */

describe("memories: slugifyPath matches Claude's project-dir naming", () => {
  it("slugs POSIX and win32 homes", () => {
    expect(slugifyPath("/Users/fab")).toBe("-Users-fab");
    expect(slugifyPath("/home/fab")).toBe("-home-fab");
    expect(slugifyPath("C:\\Users\\fab")).toBe("C--Users-fab");
  });
});

describe("memories: repo path <-> target path round-trip", () => {
  const cases: Array<{ label: string; home: string; project: string }> = [
    { label: "macOS", home: "/Users/fab", project: "/Users/fab/programming/arbella" },
    { label: "linux", home: "/home/fab", project: "/home/fab/code/thing" },
    { label: "win32", home: "C:\\Users\\fab", project: "C:\\Users\\fab\\code\\thing" },
  ];

  for (const c of cases) {
    it(`round-trips a ${c.label} project into a different home`, () => {
      const srcHomeSlug = slugifyPath(c.home);
      const slug = slugifyPath(c.project);
      const repoPath = memoryRepoPath(slug, srcHomeSlug, "MEMORY.md");
      expect(repoPath.startsWith(`${MEMORIES_REPO_PREFIX}/home/`)).toBe(true);
      // The machine-specific home is gone from the stored path.
      expect(repoPath).not.toContain(srcHomeSlug);

      // Restoring under a DIFFERENT home re-slugs only the prefix.
      const dstHome = "/home/other";
      const dest = memoryTargetPath("/home/other/.claude", slugifyPath(dstHome), repoPath);
      const tailSlug = slug.slice(srcHomeSlug.length);
      expect(dest).toBe(
        path.join(
          "/home/other/.claude",
          "projects",
          `${slugifyPath(dstHome)}${tailSlug}`,
          "memory",
          "MEMORY.md",
        ),
      );
      expect(dest).toContain(dstHome.replace(/[^A-Za-z0-9]/g, "-"));
    });
  }

  it("uses the ROOT sentinel for the $HOME project itself", () => {
    const homeSlug = slugifyPath("/Users/fab");
    const repoPath = memoryRepoPath(homeSlug, homeSlug, "MEMORY.md");
    expect(repoPath).toBe(`${MEMORIES_REPO_PREFIX}/home/ROOT/MEMORY.md`);

    const dest = memoryTargetPath("/home/other/.claude", slugifyPath("/home/other"), repoPath);
    expect(dest).toBe(path.join("/home/other/.claude", "projects", "-home-other", "memory", "MEMORY.md"));
  });

  it("keeps the verbatim slug for a project outside $HOME", () => {
    const homeSlug = slugifyPath("/Users/fab");
    const slug = slugifyPath("/Volumes/work/repo");
    const repoPath = memoryRepoPath(slug, homeSlug, "notes/a.md");
    expect(repoPath).toBe(`${MEMORIES_REPO_PREFIX}/abs/-Volumes-work-repo/notes/a.md`);

    const dest = memoryTargetPath("/home/other/.claude", slugifyPath("/home/other"), repoPath);
    expect(dest).toBe(
      path.join("/home/other/.claude", "projects", "-Volumes-work-repo", "memory", "notes", "a.md"),
    );
  });

  it("preserves an underscore tail verbatim (Claude's slug rules have drifted)", () => {
    const homeSlug = slugifyPath("/Users/fab");
    // Claude wrote this dir with underscores kept; restoring it re-slugged would
    // point at a directory Claude does not use.
    const slug = `${homeSlug}-uni-aau_26S_Logik`;
    const repoPath = memoryRepoPath(slug, homeSlug, "MEMORY.md");
    expect(repoPath).toBe(`${MEMORIES_REPO_PREFIX}/home/-uni-aau_26S_Logik/MEMORY.md`);
    const dest = memoryTargetPath("/home/other/.claude", slugifyPath("/home/other"), repoPath);
    expect(dest).toContain(path.join("projects", "-home-other-uni-aau_26S_Logik", "memory"));
  });

  it("rejects paths that are not well-formed memory paths", () => {
    const homeSlug = slugifyPath("/Users/fab");
    expect(memoryTargetPath("/h/.claude", homeSlug, "claude/files/settings.json")).toBeNull();
    expect(memoryTargetPath("/h/.claude", homeSlug, "shared/home/.agents/x.sh")).toBeNull();
    expect(memoryTargetPath("/h/.claude", homeSlug, `${MEMORIES_REPO_PREFIX}/weird/x/y.md`)).toBeNull();
    // scope + project but no file
    expect(memoryTargetPath("/h/.claude", homeSlug, `${MEMORIES_REPO_PREFIX}/home/ROOT`)).toBeNull();
  });

  it("refuses a repo path that would climb out of the tool home", () => {
    // Both the project key and every file segment come straight from the repo
    // and are joined onto ~/.claude — one ".." is an arbitrary file write.
    const homeSlug = slugifyPath("/Users/fab");
    for (const repoPath of [
      `${MEMORIES_REPO_PREFIX}/abs/../../../etc/cron.d/x`,
      `${MEMORIES_REPO_PREFIX}/abs/proj/../../../../etc/x`,
      `${MEMORIES_REPO_PREFIX}/home/ROOT/../../../x.md`,
      `${MEMORIES_REPO_PREFIX}/abs/./x/y.md`,
      `${MEMORIES_REPO_PREFIX}/home/ROOT/sub/./y.md`,
    ]) {
      expect({ repoPath, dest: memoryTargetPath("/h/.claude", homeSlug, repoPath) }).toEqual({
        repoPath,
        dest: null,
      });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

describe("memories: capture walks projects/<slug>/memory only", () => {
  it("freezes memory files and skips everything else under projects/", async () => {
    const home = path.join(tmpRoot, "home");
    const toolHome = path.join(home, ".claude");
    const homeSlug = slugifyPath(home);

    await writeFile(
      path.join(toolHome, "projects", `${homeSlug}-code-thing`, "memory", "MEMORY.md"),
      "# notes\n",
    );
    await writeFile(
      path.join(toolHome, "projects", `${homeSlug}-code-thing`, "memory", "sub", "deep.md"),
      "deep\n",
    );
    // Session state next to the memory dir: must never be captured.
    await writeFile(
      path.join(toolHome, "projects", `${homeSlug}-code-thing`, "session.jsonl"),
      "{}\n",
    );
    // A denylisted dropping INSIDE the memory dir.
    await writeFile(
      path.join(toolHome, "projects", `${homeSlug}-code-thing`, "memory", "MEMORY.md.bak"),
      "old\n",
    );
    // A project with no memory dir at all.
    await writeFile(path.join(toolHome, "projects", "-other-proj", "history.jsonl"), "{}\n");

    const seen: string[] = [];
    await captureMemories(
      captureCtx(toolHome, home),
      path.join(toolHome, "projects"),
      homeSlug,
      denylistFor("claude"),
      async (_abs, repoPath) => {
        seen.push(repoPath);
      },
    );

    expect(seen.sort()).toEqual([
      `${MEMORIES_REPO_PREFIX}/home/-code-thing/MEMORY.md`,
      `${MEMORIES_REPO_PREFIX}/home/-code-thing/sub/deep.md`,
    ]);
  });

  it("captures a memory subdir whose name collides with a root-anchored Claude rule", async () => {
    // The paths handed to the denylist are relative to the memory/ DIR, so a
    // root-anchored pattern written for ~/.claude/feedback ("/feedback/") would
    // match "feedback/notes.md" here and silently drop the user's notes. Those
    // rules do not belong at this root: the walk gets COMMON_DENY.
    const home = path.join(tmpRoot, "home2");
    const toolHome = path.join(home, ".claude");
    const homeSlug = slugifyPath(home);
    const slug = `${homeSlug}-code-thing`;

    for (const rel of ["feedback/notes.md", "plugins/notes.md", "ecc/notes.md", "MEMORY.md"]) {
      await writeFile(path.join(toolHome, "projects", slug, "memory", ...rel.split("/")), "x\n");
    }
    // COMMON_DENY still applies at this root.
    await writeFile(path.join(toolHome, "projects", slug, "memory", "MEMORY.md.bak"), "old\n");

    const seen: string[] = [];
    await captureMemories(
      captureCtx(toolHome, home),
      path.join(toolHome, "projects"),
      homeSlug,
      [...COMMON_DENY],
      async (_abs, repoPath) => {
        seen.push(repoPath);
      },
    );

    expect(seen.sort()).toEqual([
      `${MEMORIES_REPO_PREFIX}/home/-code-thing/MEMORY.md`,
      `${MEMORIES_REPO_PREFIX}/home/-code-thing/ecc/notes.md`,
      `${MEMORIES_REPO_PREFIX}/home/-code-thing/feedback/notes.md`,
      `${MEMORIES_REPO_PREFIX}/home/-code-thing/plugins/notes.md`,
    ]);

    // ...and the adapter passes exactly that list, not the Claude one.
    const result = await captureClaude(captureCtx(toolHome, home));
    const memoryPaths = result.files
      .map((f) => f.repoPath)
      .filter((p) => p.startsWith(`${MEMORIES_REPO_PREFIX}/`))
      .sort();
    expect(memoryPaths).toContain(`${MEMORIES_REPO_PREFIX}/home/-code-thing/feedback/notes.md`);
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end through the adapter                                              */
/* -------------------------------------------------------------------------- */

describe("memories: adapter capture/restore round-trip", () => {
  /** Build a source home with one memory file; returns the capture result. */
  async function captureSourceHome(includeMemories: boolean) {
    const home = path.join(tmpRoot, "src");
    const toolHome = path.join(home, ".claude");
    await fsp.mkdir(toolHome, { recursive: true });
    const slug = `${slugifyPath(home)}-code-thing`;
    await writeFile(
      path.join(toolHome, "projects", slug, "memory", "MEMORY.md"),
      `Project notes. Logs live in ${home}/code/thing/log.txt\n`,
    );
    return {
      home,
      toolHome,
      result: await captureClaude(captureCtx(toolHome, home, { includeMemories })),
    };
  }

  it("captures nothing when includeMemories is off", async () => {
    const { result } = await captureSourceHome(false);
    expect(result.files.some((f) => f.repoPath.startsWith(MEMORIES_REPO_PREFIX))).toBe(false);
  });

  it("templates on capture and rehydrates into the TARGET home on restore", async () => {
    const { result } = await captureSourceHome(true);

    const mem = result.files.find((f) => f.repoPath.startsWith(MEMORIES_REPO_PREFIX));
    expect(mem).toBeDefined();
    expect(mem!.repoPath).toBe(`${MEMORIES_REPO_PREFIX}/home/-code-thing/MEMORY.md`);
    expect(mem!.content).toContain("{{HOME}}/code/thing/log.txt");

    const dstHome = path.join(tmpRoot, "dst");
    const dstTool = path.join(dstHome, ".claude");
    await restoreClaude(restoreCtx(dstTool, dstHome), {
      manifest: emptyManifest("claude"),
      files: [mem!],
      symlinks: [],
    });

    const dest = path.join(
      dstTool,
      "projects",
      `${slugifyPath(dstHome)}-code-thing`,
      "memory",
      "MEMORY.md",
    );
    const restored = await fsp.readFile(dest, "utf8");
    expect(restored).toContain(`${dstHome}/code/thing/log.txt`);
    expect(restored).not.toContain("{{HOME}}");
  });

  it("keeps an existing local memory when sourceOfTruth is local", async () => {
    const { result } = await captureSourceHome(true);
    const mem = result.files.find((f) => f.repoPath.startsWith(MEMORIES_REPO_PREFIX))!;

    const dstHome = path.join(tmpRoot, "dst-local");
    const dstTool = path.join(dstHome, ".claude");
    const dest = path.join(
      dstTool,
      "projects",
      `${slugifyPath(dstHome)}-code-thing`,
      "memory",
      "MEMORY.md",
    );
    await writeFile(dest, "LOCAL WINS\n");

    await restoreClaude(restoreCtx(dstTool, dstHome, { sourceOfTruth: "local" }), {
      manifest: emptyManifest("claude"),
      files: [mem],
      symlinks: [],
    });

    expect(await fsp.readFile(dest, "utf8")).toBe("LOCAL WINS\n");
  });

  it("refuses to write a memory through a symlinked project directory", async () => {
    // projects/<slug> is created on demand by the restore, so a link there
    // redirects the write out of ~/.claude entirely — with the repo choosing
    // both the path and the content.
    const { result } = await captureSourceHome(true);
    const mem = result.files.find((f) => f.repoPath.startsWith(MEMORIES_REPO_PREFIX))!;

    const dstHome = path.join(tmpRoot, "dst-link");
    const dstTool = path.join(dstHome, ".claude");
    const elsewhere = path.join(tmpRoot, "elsewhere");
    await fsp.mkdir(elsewhere, { recursive: true });
    await fsp.mkdir(path.join(dstTool, "projects"), { recursive: true });
    await fsp.symlink(
      elsewhere,
      path.join(dstTool, "projects", `${slugifyPath(dstHome)}-code-thing`),
    );

    await restoreClaude(restoreCtx(dstTool, dstHome), {
      manifest: emptyManifest("claude"),
      files: [mem],
      symlinks: [],
    });

    expect(await realFs.exists(path.join(elsewhere, "memory", "MEMORY.md"))).toBe(false);
  });

  it("ignores repo roots it does not own instead of dumping them in ~/.claude", async () => {
    const dstHome = path.join(tmpRoot, "dst-foreign");
    const dstTool = path.join(dstHome, ".claude");

    await restoreClaude(restoreCtx(dstTool, dstHome), {
      manifest: emptyManifest("claude"),
      files: [{ repoPath: "shared/home/.agents/hooks/dispatch.sh", content: "#!/bin/sh\n" }],
      symlinks: [],
    });

    expect(await realFs.exists(path.join(dstTool, "shared"))).toBe(false);
    expect(await realFs.exists(path.join(dstTool, "shared", "home"))).toBe(false);
  });
});
