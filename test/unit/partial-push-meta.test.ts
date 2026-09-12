/**
 * Regression tests for a push from a machine that is missing one configured tool.
 *
 * The bug these pin: such a push skipped the absent tool (correct — its repo
 * subtree is left untouched) but then rebuilt the repo's SELF-DESCRIPTION from
 * the tools that happened to run:
 *
 *   - `meta.tools` shrank to the present tools, and `selectToolsForRestore`
 *     constrains a pull to `meta.tools` — so the absent tool's still-committed
 *     `codex/files/` subtree was never restored again.
 *   - `shared/instructions.md` (the ONLY copy of CLAUDE.md/AGENTS.md when the two
 *     are identical) was deleted and `meta.sharedInstructions` set to false,
 *     because sharing needs both producers and one of them was not there.
 *
 * `status` had the same hole and reported the shared file as "removed", so it
 * agreed with the push — about the wrong answer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveMetaTools } from "../../src/commands/backup.js";
import { diffSharedInstructions } from "../../src/commands/status.js";
import {
  decideSharedInstructionsUpdate,
  SHARED_INSTRUCTIONS_REPO_PATH,
} from "../../src/core/manifest/index.js";
import type { ToolId } from "../../src/types.js";

let repoRoot: string;

const INSTRUCTIONS = "# shared instructions\n";

/** Commit `content` as <repoRoot>/shared/instructions.md. */
async function commitSharedInstructions(content = INSTRUCTIONS): Promise<void> {
  const abs = path.join(repoRoot, ...SHARED_INSTRUCTIONS_REPO_PATH.split("/"));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

/** Create <repoRoot>/<tool>/files so the tool has a committed subtree. */
async function commitToolSubtree(tool: ToolId): Promise<void> {
  await fsp.mkdir(path.join(repoRoot, tool, "files"), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, tool, "files", "settings.json"), "{}\n");
}

beforeEach(async () => {
  repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-partial-"));
});

afterEach(async () => {
  await fsp.rm(repoRoot, { recursive: true, force: true });
});

describe("resolveMetaTools: a partial push does not shrink meta.tools", () => {
  it("keeps a configured tool that is absent here but still committed", () => {
    expect(
      resolveMetaTools({
        capturedTools: ["claude"],
        previousTools: ["claude", "codex"],
        configuredTools: ["claude", "codex"],
        toolsWithRepoSubtree: ["claude", "codex"],
      }),
    ).toEqual(["claude", "codex"]);
  });

  it("drops a tool the user removed from config.tools", () => {
    expect(
      resolveMetaTools({
        capturedTools: ["claude"],
        previousTools: ["claude", "codex"],
        configuredTools: ["claude"],
        toolsWithRepoSubtree: ["claude", "codex"],
      }),
    ).toEqual(["claude"]);
  });

  it("drops a tool whose repo subtree is gone", () => {
    expect(
      resolveMetaTools({
        capturedTools: ["claude"],
        previousTools: ["claude", "codex"],
        configuredTools: ["claude", "codex"],
        toolsWithRepoSubtree: ["claude"],
      }),
    ).toEqual(["claude"]);
  });

  it("returns the union in canonical TOOL_IDS order, not capture order", () => {
    expect(
      resolveMetaTools({
        capturedTools: ["cursor", "codex"],
        previousTools: ["antigravity", "claude"],
        configuredTools: ["claude", "codex", "cursor", "antigravity"],
        toolsWithRepoSubtree: ["antigravity", "claude"],
      }),
    ).toEqual(["claude", "codex", "cursor", "antigravity"]);
  });

  it("is exactly the captured tools on a first push", () => {
    expect(
      resolveMetaTools({
        capturedTools: ["claude"],
        previousTools: [],
        configuredTools: ["claude", "codex"],
        toolsWithRepoSubtree: [],
      }),
    ).toEqual(["claude"]);
  });
});

describe("decideSharedInstructionsUpdate: only a run that saw every configured producer decides", () => {
  const both: ToolId[] = ["claude", "codex"];

  it("keeps the committed file when a configured producer is missing on this machine", () => {
    expect(
      decideSharedInstructionsUpdate({
        share: false,
        capturedTools: ["claude"],
        configuredTools: both,
      }),
    ).toBe("keep");
    // Even a run that WOULD share (a stale AGENTS.md left behind by an
    // uninstalled Codex) has no business rewriting the file it cannot verify.
    expect(
      decideSharedInstructionsUpdate({
        share: true,
        capturedTools: ["claude"],
        configuredTools: both,
      }),
    ).toBe("keep");
  });

  it("removes a stale file once the absent producer is no longer configured", () => {
    // The user dropped codex from config.tools: this repo no longer carries
    // codex instructions at all, so a leftover shared file must not outlive it.
    expect(
      decideSharedInstructionsUpdate({
        share: false,
        capturedTools: ["claude"],
        configuredTools: ["claude"],
      }),
    ).toBe("remove");
  });

  it("writes when both producers ran and their files are identical", () => {
    expect(
      decideSharedInstructionsUpdate({ share: true, capturedTools: both, configuredTools: both }),
    ).toBe("write");
  });

  it("removes only when both producers ran and their files differ", () => {
    expect(
      decideSharedInstructionsUpdate({ share: false, capturedTools: both, configuredTools: both }),
    ).toBe("remove");
  });
});

describe("status agrees with push about shared/instructions.md", () => {
  it("does not report the file as removed when a producer is absent", async () => {
    await commitSharedInstructions();
    await commitToolSubtree("claude");
    await commitToolSubtree("codex");

    // Machine without Codex: nothing to compare, so the push keeps the file —
    // and status must not announce a deletion that never happens.
    const changes = await diffSharedInstructions(repoRoot, {
      share: false,
      capturedTools: ["claude"],
      configuredTools: ["claude", "codex"],
    });

    expect(changes).toEqual([]);
  });

  it("reports the file as removed when both ran and they now differ", async () => {
    await commitSharedInstructions();

    const changes = await diffSharedInstructions(repoRoot, {
      share: false,
      capturedTools: ["claude", "codex"],
      configuredTools: ["claude", "codex"],
    });

    expect(changes).toEqual([
      { repoPath: SHARED_INSTRUCTIONS_REPO_PATH, kind: "removed" },
    ]);
  });

  it("stays silent when both ran, share, and the committed content matches", async () => {
    await commitSharedInstructions();

    const changes = await diffSharedInstructions(repoRoot, {
      share: true,
      content: INSTRUCTIONS,
      capturedTools: ["claude", "codex"],
      configuredTools: ["claude", "codex"],
    });

    expect(changes).toEqual([]);
  });

  it("reports a content change when both ran and the shared text moved on", async () => {
    await commitSharedInstructions("# old\n");

    const changes = await diffSharedInstructions(repoRoot, {
      share: true,
      content: INSTRUCTIONS,
      capturedTools: ["claude", "codex"],
      configuredTools: ["claude", "codex"],
    });

    expect(changes).toEqual([
      { repoPath: SHARED_INSTRUCTIONS_REPO_PATH, kind: "changed" },
    ]);
  });

  it("says nothing about a file that was never committed", async () => {
    const changes = await diffSharedInstructions(repoRoot, {
      share: false,
      capturedTools: ["claude", "codex"],
      configuredTools: ["claude", "codex"],
    });

    expect(changes).toEqual([]);
  });
});
