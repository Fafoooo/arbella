/**
 * Unit tests for the follower role + machine id primitives (src/core/config).
 * Config lives under XDG_CONFIG_HOME, which each test points at a fresh tmp dir.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureMachineId,
  followerConfig,
  loadConfig,
} from "../../src/core/config/index.js";
import { arbellaConfigSchema, DEFAULT_CONFIG } from "../../src/core/config/schema.js";

const repo = { provider: "github", url: "git@github.com:me/cfg.git", localPath: "/data/repo" } as const;

let tmp: string;
const saved = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA };

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "arbella-role-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.APPDATA = tmp;
});

afterEach(async () => {
  if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.xdg;
  if (saved.appdata === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = saved.appdata;
  await rm(tmp, { recursive: true, force: true });
});

describe("config role + machineId", () => {
  it("config without role parses as source with no machineId", () => {
    const { role: _role, ...legacy } = DEFAULT_CONFIG;
    const parsed = arbellaConfigSchema.parse(legacy);
    expect(parsed.role).toBe("source");
    expect(parsed.machineId).toBeUndefined();
  });

  it("rejects an unknown role and an empty machineId", () => {
    expect(() => arbellaConfigSchema.parse({ ...DEFAULT_CONFIG, role: "x" })).toThrow();
    expect(() => arbellaConfigSchema.parse({ ...DEFAULT_CONFIG, machineId: "" })).toThrow();
  });

  it("ensureMachineId generates once and persists", async () => {
    const cfg = arbellaConfigSchema.parse({ ...DEFAULT_CONFIG, repo });
    const first = await ensureMachineId(cfg);
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.config.machineId).toBe(first.machineId);
    expect((await loadConfig()).machineId).toBe(first.machineId);

    const second = await ensureMachineId(await loadConfig());
    expect(second.machineId).toBe(first.machineId);
  });

  it("ensureMachineId returns an existing id untouched without saving", async () => {
    const cfg = arbellaConfigSchema.parse({ ...DEFAULT_CONFIG, repo, machineId: "m-1" });
    const out = await ensureMachineId(cfg);
    expect(out).toEqual({ config: cfg, machineId: "m-1" });
    // nothing was written
    await expect(loadConfig()).rejects.toThrow(/No arbella config/);
  });

  it("followerConfig ignores meta includeSecrets=true", () => {
    const cfg = followerConfig(
      repo,
      { tools: ["claude"], includeMemories: true },
      "m-2",
    );
    expect(cfg).toEqual({
      repo,
      role: "follower",
      machineId: "m-2",
      sourceOfTruth: "repo",
      autoBackup: "off",
      includeSecrets: false,
      includeMemories: true,
      tools: ["claude"],
      extraPaths: [],
    });
    expect(arbellaConfigSchema.parse(cfg)).toEqual(cfg);
  });
});
