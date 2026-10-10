/**
 * Push guards: the follower refusal, the gate table, the planned-deletion
 * count and the "another machine pushed last" check. All pure except the two
 * follower cases, which only need a config under a tmp XDG_CONFIG_HOME.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MASS_DELETE_MIN,
  MEMORY_DELETE_MIN,
  decidePushGate,
  plannedDeletions,
  plannedSharedDeletions,
  pushRisks,
  replaceToolFiles,
  run,
} from "../../src/commands/backup.js";
import { followerConfig, saveConfig } from "../../src/core/config/index.js";
import type { CaptureResult } from "../../src/types.js";

function result(tool: CaptureResult["tool"], repoPaths: string[], links: string[] = []): CaptureResult {
  return {
    tool,
    files: repoPaths.map((repoPath) => ({ repoPath, content: "x" })),
    symlinks: links.map((repoPath) => ({ repoPath, target: "t" })),
    manifest: {},
    secrets: [],
    warnings: [],
  } as unknown as CaptureResult;
}

const seq = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.md`);

describe("decidePushGate", () => {
  const base = { auto: false, yes: false, interactive: false };
  const risks = ["r"];

  it("goes when there are no risks, whatever the mode", () => {
    expect(decidePushGate({ ...base, risks: [] })).toBe("go");
    expect(decidePushGate({ ...base, risks: [], auto: true })).toBe("go");
  });
  it("--yes goes through risks", () => {
    expect(decidePushGate({ ...base, risks, yes: true })).toBe("go");
  });
  it("--auto skips", () => {
    expect(decidePushGate({ ...base, risks, auto: true, interactive: true })).toBe("skip");
  });
  it("asks on a TTY", () => {
    expect(decidePushGate({ ...base, risks, interactive: true })).toBe("ask");
  });
  it("refuses without a TTY", () => {
    expect(decidePushGate({ ...base, risks })).toBe("refuse");
  });
});

describe("plannedDeletions", () => {
  it("counts committed files under captured tools' roots that this run no longer writes", () => {
    const committed = [
      "claude/files/a.md",
      "claude/files/b.md",
      "claude/manifest.json",
      "codex/files/c.md",
      "arbella.json",
      "shared/home/x",
    ];
    const out = plannedDeletions(committed, [result("claude", ["claude/files/a.md"])], false);
    expect(out).toEqual(["claude/files/b.md"]);
  });

  it("does not count symlinks this run writes", () => {
    const out = plannedDeletions(
      ["claude/files/skills/s"],
      [result("claude", [], ["claude/files/skills/s"])],
      false,
    );
    expect(out).toEqual([]);
  });

  it("leaves the memory roots alone when memories are not managed (D3)", () => {
    const committed = ["claude/memories/m.md", "codex/files/memories/n.md", "codex/files/x.md"];
    const results = [result("claude", []), result("codex", [])];
    expect(plannedDeletions(committed, results, false)).toEqual(["codex/files/x.md"]);
    expect(plannedDeletions(committed, results, true).sort()).toEqual(committed.slice().sort());
  });
});

describe("plannedSharedDeletions", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "arbella-shared-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const put = async (rel: string, content = "x"): Promise<void> => {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), content);
  };

  it("a source with empty extraPaths against 30 committed shared/home files is a risk", async () => {
    const files = seq("shared/home/.config/x/f", 30);
    for (const f of files) await put(f);
    await put(
      "shared/home-index.json",
      JSON.stringify({ version: 1, files: Object.fromEntries(files.map((f) => [f, ["extraPaths"]])) }),
    );

    const deleted = await plannedSharedDeletions(repo, [], ["claude"], "keep");

    expect(deleted.sort()).toEqual(files.slice().sort());
    const risks = pushRisks({ machineId: "me", deleted });
    expect(risks).toHaveLength(1);
    expect(risks[0]).toContain("30");
  });

  it("counts exactly what the mirror removes: claimed files and absent origins stay", async () => {
    await put("shared/home/.a/claimed.sh");
    await put("shared/home/.a/codex-only.sh");
    await put("shared/home/.a/gone.sh");
    await put(
      "shared/home-index.json",
      JSON.stringify({
        version: 1,
        files: {
          "shared/home/.a/claimed.sh": ["claude"],
          "shared/home/.a/codex-only.sh": ["codex"],
          "shared/home/.a/gone.sh": ["claude"],
        },
      }),
    );
    const claims = [{ repoPath: "shared/home/.a/claimed.sh", origin: "claude" }];

    expect(await plannedSharedDeletions(repo, claims, ["claude"], "write")).toEqual(["shared/home/.a/gone.sh"]);
  });

  it("adds shared/instructions.md only when this run removes a committed one", async () => {
    expect(await plannedSharedDeletions(repo, [], ["claude"], "remove")).toEqual([]);
    await put("shared/instructions.md");
    expect(await plannedSharedDeletions(repo, [], ["claude"], "remove")).toEqual(["shared/instructions.md"]);
    expect(await plannedSharedDeletions(repo, [], ["claude"], "keep")).toEqual([]);
    expect(await plannedSharedDeletions(repo, [], ["claude"], "write")).toEqual([]);
  });
});

describe("pushRisks", () => {
  const ok = { machineId: "me-1", deleted: [] as string[] };

  it("is quiet for a pre-1.1 repo (no lastPushMachine)", () => {
    expect(pushRisks({ ...ok, metaCreatedAt: "t1" })).toEqual([]);
  });
  it("is quiet when this machine pushed last", () => {
    expect(pushRisks({ ...ok, lastPushMachine: "me-1", metaCreatedAt: "t1" })).toEqual([]);
  });
  it("flags another machine that pushed since this one last synced, by id prefix only", () => {
    const out = pushRisks({
      ...ok,
      lastPushMachine: "abcdef1234567890",
      metaCreatedAt: "t2",
      lastSyncedPush: "t1",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("abcdef12");
    expect(out[0]).not.toContain("abcdef1234567890");
  });
  it("is quiet once this machine has synced that push", () => {
    expect(
      pushRisks({ ...ok, lastPushMachine: "other", metaCreatedAt: "t2", lastSyncedPush: "t2" }),
    ).toEqual([]);
  });

  it("flags mass deletion at the threshold, naming the count", () => {
    const below = seq("claude/files/", MASS_DELETE_MIN - 1);
    expect(pushRisks({ ...ok, deleted: below })).toEqual([]);
    const out = pushRisks({ ...ok, deleted: seq("claude/files/", MASS_DELETE_MIN) });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(String(MASS_DELETE_MIN));
  });
  it("flags memory deletion at the threshold, with its own message", () => {
    const mem = seq("claude/memories/", MEMORY_DELETE_MIN);
    const out = pushRisks({ ...ok, deleted: mem });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/memor/i);
    expect(pushRisks({ ...ok, deleted: mem.slice(1) })).toEqual([]);
  });
});

describe("replaceToolFiles keeps what this run does not manage (D3)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "arbella-mirror-"));
    for (const p of ["codex/files/old.md", "codex/files/memories/m.md", "claude/memories/c.md"]) {
      await mkdir(path.dirname(path.join(repo, p)), { recursive: true });
      await writeFile(path.join(repo, p), "x");
    }
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const exists = (p: string) =>
    stat(path.join(repo, p)).then(
      () => true,
      () => false,
    );

  it("with memories off, wipes codex/files but not its memories, nor claude/memories", async () => {
    await replaceToolFiles(repo, result("codex", ["codex/files/new.md"]), false);
    await replaceToolFiles(repo, result("claude", []), false);
    expect(await exists("codex/files/old.md")).toBe(false);
    expect(await exists("codex/files/new.md")).toBe(true);
    expect(await exists("codex/files/memories/m.md")).toBe(true);
    expect(await exists("claude/memories/c.md")).toBe(true);
  });

  it("with memories on, mirrors them too", async () => {
    await replaceToolFiles(repo, result("codex", []), true);
    await replaceToolFiles(repo, result("claude", []), true);
    expect(await exists("codex/files/memories/m.md")).toBe(false);
    expect(await exists("claude/memories/c.md")).toBe(false);
  });
});

describe("follower machines never push", () => {
  let tmp: string;
  const saved = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA };

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "arbella-follower-"));
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.APPDATA = tmp;
    await saveConfig(
      followerConfig(
        { provider: "generic", url: "file:///nowhere.git", localPath: path.join(tmp, "clone") },
        { tools: ["claude"], includeMemories: false },
        "m-follower",
      ),
    );
  });
  afterEach(async () => {
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.xdg;
    if (saved.appdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = saved.appdata;
    await rm(tmp, { recursive: true, force: true });
  });

  it("push throws, and --yes does not override", async () => {
    await expect(run({})).rejects.toThrow(/follower/i);
    await expect(run({ yes: true })).rejects.toThrow(/arbella init/);
  });

  it("push --auto resolves quietly without cloning", async () => {
    await expect(run({ auto: true })).resolves.toBeUndefined();
    await expect(stat(path.join(tmp, "clone"))).rejects.toThrow();
  });
});

describe("pushRisks: terminal safety", () => {
  it("never prints a machine id that is not hex-shaped", () => {
    const out = pushRisks({
      machineId: "me-1",
      deleted: [],
      lastPushMachine: "\u001b[31mevil-machine",
      metaCreatedAt: "t2",
      lastSyncedPush: "t1",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\u001b");
    expect(out[0]).toContain("unknown machine");
  });
});
