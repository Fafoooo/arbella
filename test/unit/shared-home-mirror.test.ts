/**
 * Regression tests for the `shared/home` mirror (S5) and the mode a restore
 * reads back out of the repo (LOW a), against a real temp "repo" working tree.
 *
 * The bug the mirror test pins: `shared/home` is fed by every adapter at once,
 * so wiping and rewriting it on a machine that lacks one of the tools deletes
 * that tool's carried scripts from the repo — a push from the laptop quietly
 * amputating the desktop's setup, with the loss only visible on the next pull.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeSharedHome } from "../../src/commands/backup.js";
import { loadHomeFiles } from "../../src/commands/restore.js";
import { diffSharedHome } from "../../src/commands/status.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import {
  HOME_INDEX_REPO_PATH,
  parseHomeIndex,
} from "../../src/core/homefiles/home-index.js";
import { SHARED_HOME_REPO_PREFIX } from "../../src/core/homefiles/capture.js";
import type { CapturedFile, ToolId } from "../../src/types.js";
import { itPosixHost } from "../helpers/platform.js";

let repoRoot: string;

const CLAUDE_REL = ".agents/hooks/claude-dispatch.sh";
const CODEX_REL = ".agents/hooks/codex-dispatch.sh";

/** A shared/home entry as the push assembles it: the file plus its origin. */
function entry(rel: string, origin: string, content = "#!/bin/sh\n") {
  return { file: { repoPath: `${SHARED_HOME_REPO_PREFIX}/${rel}`, content }, origin };
}

function abs(rel: string): string {
  return path.join(repoRoot, ...SHARED_HOME_REPO_PREFIX.split("/"), ...rel.split("/"));
}

async function readIndex(): Promise<Record<string, string[]>> {
  const raw = await fsp.readFile(path.join(repoRoot, ...HOME_INDEX_REPO_PATH.split("/")), "utf8");
  return parseHomeIndex(JSON.parse(raw)).files;
}

/** One push: capture `entries` on a machine where `tools` are installed. */
async function push(
  entries: ReturnType<typeof entry>[],
  tools: readonly ToolId[],
): Promise<void> {
  await writeSharedHome(repoRoot, entries, tools);
}

beforeEach(async () => {
  repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-mirror-"));
});

afterEach(async () => {
  await fsp.rm(repoRoot, { recursive: true, force: true });
});

describe("writeSharedHome: a partial push does not wipe the other machine's files", () => {
  it("keeps the files of a tool that is not installed on this machine", async () => {
    // Machine A has both tools.
    await push(
      [entry(CLAUDE_REL, "claude"), entry(CODEX_REL, "codex")],
      ["claude", "codex"],
    );
    expect(await readIndex()).toEqual({
      [`${SHARED_HOME_REPO_PREFIX}/${CLAUDE_REL}`]: ["claude"],
      [`${SHARED_HOME_REPO_PREFIX}/${CODEX_REL}`]: ["codex"],
    });

    // Machine B has only Claude. Codex's dispatcher must survive the push.
    await push([entry(CLAUDE_REL, "claude", "#!/bin/sh\nv2\n")], ["claude"]);

    expect(await fsp.readFile(abs(CODEX_REL), "utf8")).toBe("#!/bin/sh\n");
    expect(await fsp.readFile(abs(CLAUDE_REL), "utf8")).toBe("#!/bin/sh\nv2\n");
    expect(Object.keys(await readIndex()).sort()).toEqual(
      [
        `${SHARED_HOME_REPO_PREFIX}/${CLAUDE_REL}`,
        `${SHARED_HOME_REPO_PREFIX}/${CODEX_REL}`,
      ].sort(),
    );
  });

  it("still deletes a file the capturing tool no longer produces", async () => {
    await push(
      [entry(CLAUDE_REL, "claude"), entry(".agents/hooks/old.sh", "claude")],
      ["claude"],
    );

    await push([entry(CLAUDE_REL, "claude")], ["claude"]);

    expect(await fsp.readFile(abs(CLAUDE_REL), "utf8")).toBe("#!/bin/sh\n");
    await expect(fsp.readFile(abs(".agents/hooks/old.sh"), "utf8")).rejects.toThrow();
  });

  it("removes an untracked stray with no provenance at all", async () => {
    // A file committed before the index existed (or dropped in by hand) has no
    // origin to protect it: the mirror is still a mirror.
    await fsp.mkdir(path.dirname(abs("stray.sh")), { recursive: true });
    await fsp.writeFile(abs("stray.sh"), "stray\n");

    await push([entry(CLAUDE_REL, "claude")], ["claude"]);

    await expect(fsp.readFile(abs("stray.sh"), "utf8")).rejects.toThrow();
  });

  it("drops the index file entirely when nothing is carried any more", async () => {
    await push([entry(CLAUDE_REL, "claude")], ["claude"]);
    await push([], ["claude"]);

    await expect(fsp.readFile(abs(CLAUDE_REL), "utf8")).rejects.toThrow();
    await expect(
      fsp.readFile(path.join(repoRoot, ...HOME_INDEX_REPO_PATH.split("/")), "utf8"),
    ).rejects.toThrow();
  });

  it("keeps the index OUT of shared/home, so a pull never restores it into $HOME", async () => {
    await push([entry(CLAUDE_REL, "claude")], ["claude"]);

    const restored: CapturedFile[] = await loadHomeFiles(repoRoot);
    expect(restored.map((f) => f.repoPath)).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/${CLAUDE_REL}`,
    ]);
  });
});

describe("status agrees with push about what is removed", () => {
  it("does not report the absent tool's files as removed", async () => {
    // Same setup as the push test: both tools captured once, then a run on a
    // machine without Codex. `status` must not announce a deletion the push then
    // declines to make — that is what sends a user chasing a phantom.
    await push([entry(CLAUDE_REL, "claude"), entry(CODEX_REL, "codex")], ["claude", "codex"]);

    const changes = await diffSharedHome(
      repoRoot,
      [entry(CLAUDE_REL, "claude")],
      [],
      { includeSecrets: false },
      [
        {
          tool: "claude" as const,
          files: [],
          symlinks: [],
          manifest: emptyManifest("claude"),
          secrets: [],
          warnings: [],
        },
      ],
    );

    expect(changes).toEqual([]);
  });

  it("does report a file the capturing tool stopped producing", async () => {
    await push([entry(CLAUDE_REL, "claude"), entry(CODEX_REL, "codex")], ["claude", "codex"]);

    const changes = await diffSharedHome(
      repoRoot,
      [entry(CLAUDE_REL, "claude")],
      [],
      { includeSecrets: false },
      [
        {
          tool: "claude" as const,
          files: [],
          symlinks: [],
          manifest: emptyManifest("claude"),
          secrets: [],
          warnings: [],
        },
        {
          tool: "codex" as const,
          files: [],
          symlinks: [],
          manifest: emptyManifest("codex"),
          secrets: [],
          warnings: [],
        },
      ],
    );

    expect(changes).toEqual([
      { repoPath: `${SHARED_HOME_REPO_PREFIX}/${CODEX_REL}`, kind: "removed" },
    ]);
  });
});

describe("loadHomeFiles: the mode a restore reads back", () => {
  // POSIX-only by construction: Windows implements neither the setuid bit this
  // strips nor the 0o755 it must leave behind.
  itPosixHost("keeps the executable bit but never a setuid bit from the working tree", async () => {
    // git stores only +x, so anything above 0o777 in a checkout was put there by
    // something else — and a restore must not hand a $HOME script that mode.
    await push([entry(CLAUDE_REL, "claude")], ["claude"]);
    await fsp.chmod(abs(CLAUDE_REL), 0o4755);

    const [file] = await loadHomeFiles(repoRoot);

    expect(file!.mode).toBe(0o755);
  });

  it("reads a NUL-free binary back as binary, byte-for-byte", async () => {
    // The repo walker used a NUL-only heuristic while CAPTURE used
    // decodeForCapture, so the two disagreed on any invalid-UTF-8 blob with no
    // NUL in its first 8 KiB — a small icon or thumbnail under `extraPaths`.
    // The pull read it as "text", decoded it leniently (every bad byte becomes
    // U+FFFD) and wrote those replacement characters back to $HOME.
    const bytes = Buffer.from([0xff, 0xfe, 0x01, 0x80, 0x81]);
    await push([entry(CLAUDE_REL, "claude")], ["claude"]);
    await fsp.writeFile(abs("icon.bin"), bytes);

    const restored = await loadHomeFiles(repoRoot);
    const blob = restored.find((f) => f.repoPath.endsWith("/icon.bin"));

    expect(blob).toBeDefined();
    expect(blob!.binary).toBe(true);
    expect(Buffer.from(blob!.content, "base64")).toEqual(bytes);
  });

  it("still reads an ordinary UTF-8 script back as text", async () => {
    await push([entry(CLAUDE_REL, "claude", "#!/bin/sh\nexec \"$@\"\n")], ["claude"]);

    const [file] = await loadHomeFiles(repoRoot);

    expect(file!.binary).toBeUndefined();
    expect(file!.content).toBe('#!/bin/sh\nexec "$@"\n');
  });
});
