/**
 * syncBeforePush against a real local bare remote and two clones: a commit
 * pushed from another machine is integrated, and a conflict aborts cleanly
 * (no rebase left in progress) with a "Nothing was pushed" error.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { committedFiles, syncBeforePush } from "../../src/core/repo/index.js";
import { listTrackedFiles } from "../../src/core/repo/git.js";

const IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  // Windows autocrlf would turn "a\n" into "a\r\n" in the checked-out files.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.autocrlf",
  GIT_CONFIG_VALUE_0: "false",
};
const saved: Record<string, string | undefined> = {};
let tmp: string;
let remote: string;
let a: string;
let b: string;

const sh = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execa("git", args, { cwd })).stdout;

const cfg = (localPath: string) => ({ provider: "generic" as const, url: remote, localPath });

async function commitFile(dir: string, name: string, body: string): Promise<void> {
  await writeFile(path.join(dir, name), body);
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-m", `edit ${name}`);
}

beforeEach(async () => {
  for (const [k, v] of Object.entries(IDENT)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  tmp = await mkdtemp(path.join(os.tmpdir(), "arbella-sync-"));
  remote = path.join(tmp, "remote.git");
  a = path.join(tmp, "a");
  b = path.join(tmp, "b");
  await execa("git", ["init", "--bare", "-b", "main", remote]);
  await execa("git", ["init", "-b", "main", a]);
  await sh(a, "remote", "add", "origin", remote);
  await commitFile(a, "base.txt", "base\n");
  await sh(a, "push", "-u", "origin", "main");
  await execa("git", ["clone", remote, b]);
});

afterEach(async () => {
  for (const k of Object.keys(IDENT)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(tmp, { recursive: true, force: true });
});

describe("syncBeforePush", () => {
  it("integrates a commit pushed by another clone", async () => {
    await commitFile(a, "from-a.txt", "a\n");
    await sh(a, "push");
    await commitFile(b, "from-b.txt", "b\n");

    await syncBeforePush(cfg(b));

    expect(await readFile(path.join(b, "from-a.txt"), "utf8")).toBe("a\n");
    expect(await readFile(path.join(b, "from-b.txt"), "utf8")).toBe("b\n");
  });

  it("does nothing when the clone has no upstream", async () => {
    const lone = path.join(tmp, "lone");
    await execa("git", ["init", "-b", "main", lone]);
    await expect(syncBeforePush(cfg(lone))).resolves.toBeUndefined();
  });

  it("conflict throws 'Nothing was pushed' and leaves no rebase in progress", async () => {
    await commitFile(a, "base.txt", "from a\n");
    await sh(a, "push");
    await commitFile(b, "base.txt", "from b\n");

    await expect(syncBeforePush(cfg(b))).rejects.toThrow(/Nothing was pushed/);

    await expect(stat(path.join(b, ".git", "rebase-merge"))).rejects.toThrow();
    await expect(stat(path.join(b, ".git", "rebase-apply"))).rejects.toThrow();
  });
});

describe("committedFiles / listTrackedFiles", () => {
  it("lists the upstream tree, not unpushed local deletions", async () => {
    await sh(b, "rm", "base.txt");
    await sh(b, "commit", "-m", "drop base");
    expect(await committedFiles(b)).toEqual(["base.txt"]);
  });

  it("falls back to HEAD without an upstream, and to [] without commits", async () => {
    const lone = path.join(tmp, "lone");
    await execa("git", ["init", "-b", "main", lone]);
    expect(await committedFiles(lone)).toEqual([]);
    await commitFile(lone, "x.txt", "x");
    expect(await committedFiles(lone)).toEqual(["x.txt"]);
  });

  it("listTrackedFiles returns [] for a bad ref", async () => {
    expect(await listTrackedFiles(a, "no-such-ref")).toEqual([]);
  });
});
