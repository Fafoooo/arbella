/**
 * Re-running `arbella init` against the repo a follower already cloned must
 * reuse that clone instead of pointing the config at a fresh, empty path.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveLocalPath, sameRepoUrl } from "../../src/commands/init.js";
import { gitInit } from "../../src/core/repo/git.js";

describe("sameRepoUrl", () => {
  it("ignores a trailing .git and trailing slashes", () => {
    expect(sameRepoUrl("https://h.example/me/cfg.git", "https://h.example/me/cfg")).toBe(true);
    expect(sameRepoUrl("https://h.example/me/cfg/", "https://h.example/me/cfg.git")).toBe(true);
  });
  it("tells different repos apart and rejects empty input", () => {
    expect(sameRepoUrl("https://h.example/me/a", "https://h.example/me/b")).toBe(false);
    expect(sameRepoUrl("", "")).toBe(false);
  });
});

describe("resolveLocalPath", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "arbella-reuse-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const fallback = "/default/repo";
  const repo = (url: string, localPath: string) => ({ provider: "generic" as const, url, localPath });

  it("reuses the follower's restore clone for the same url", async () => {
    const clone = path.join(tmp, "restore-clone");
    await mkdir(clone, { recursive: true });
    await gitInit(clone);
    expect(
      await resolveLocalPath(repo("https://h.example/me/cfg.git", clone), "https://h.example/me/cfg", fallback),
    ).toBe(clone);
  });

  it("falls back for a different url or a non-git path", async () => {
    expect(
      await resolveLocalPath(repo("https://h.example/me/a", tmp), "https://h.example/me/b", fallback),
    ).toBe(fallback);
    expect(
      await resolveLocalPath(repo("https://h.example/me/a", path.join(tmp, "nope")), "https://h.example/me/a", fallback),
    ).toBe(fallback);
  });
});
