/**
 * Regression test for `status`'s manifest diff (src/commands/status.ts).
 *
 * `status` is what a user consults before pushing, so a collection the diff does
 * not look at is worse than no diff at all: it reports "no drift" for a change
 * the very next push will write into the repo. Project-scope MCP servers were
 * exactly that hole — they live in their OWN manifest collection
 * (`projectMcpServers`), so the user-scope `mcpServers` diff never saw them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { diffManifest } from "../../src/commands/status.js";
import type { ManifestDrift } from "../../src/commands/status.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import type { ToolManifest } from "../../src/types.js";

let repoRoot: string;

/** Commit `manifest` as <repoRoot>/claude/manifest.json. */
async function commitManifest(manifest: ToolManifest): Promise<void> {
  const dir = path.join(repoRoot, "claude");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/** A manifest carrying exactly the given project-scope server groups. */
function withProjects(
  projectMcpServers: ToolManifest["projectMcpServers"],
): ToolManifest {
  return { ...emptyManifest("claude"), projectMcpServers };
}

function drift(drifts: ManifestDrift[], category: string): ManifestDrift | undefined {
  return drifts.find((d) => d.category === category);
}

beforeEach(async () => {
  repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-drift-"));
});

afterEach(async () => {
  await fsp.rm(repoRoot, { recursive: true, force: true });
});

describe("diffManifest: project-scope MCP servers are diffed too", () => {
  it("reports an added, a removed and a changed project group", async () => {
    await commitManifest(
      withProjects([
        { projectPath: "{{HOME}}/programming/arbella", servers: { local: { command: "a" } } },
        { projectPath: "{{HOME}}/programming/gone", servers: { old: { command: "b" } } },
      ]),
    );

    const drifts = await diffManifest(
      repoRoot,
      "claude",
      withProjects([
        // same key, different definition -> changed
        { projectPath: "{{HOME}}/programming/arbella", servers: { local: { command: "a2" } } },
        // brand-new project group -> added
        { projectPath: "{{HOME}}/code/new", servers: { fresh: { command: "c" } } },
        // "{{HOME}}/programming/gone" is absent locally -> removed
      ]),
    );

    expect(drift(drifts, "projectMcpServers")).toEqual({
      category: "projectMcpServers",
      added: ["{{HOME}}/code/new"],
      removed: ["{{HOME}}/programming/gone"],
      changed: ["{{HOME}}/programming/arbella"],
    });
    // The user-scope collection is untouched, and therefore silent.
    expect(drift(drifts, "mcpServers")).toBeUndefined();
  });

  it("stays silent when the project groups are identical", async () => {
    const groups: ToolManifest["projectMcpServers"] = [
      { projectPath: "{{HOME}}/programming/arbella", servers: { local: { command: "a" } } },
    ];
    await commitManifest(withProjects(groups));

    const drifts = await diffManifest(repoRoot, "claude", withProjects(groups));

    expect(drifts).toEqual([]);
  });

  it("treats every local project group as added when nothing is committed yet", async () => {
    const drifts = await diffManifest(
      repoRoot,
      "claude",
      withProjects([
        { projectPath: "{{HOME}}/programming/arbella", servers: { local: { command: "a" } } },
      ]),
    );

    expect(drift(drifts, "projectMcpServers")?.added).toEqual(["{{HOME}}/programming/arbella"]);
  });
});
