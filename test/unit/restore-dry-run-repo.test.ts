/**
 * A pull preview must never update or create the user's configured backup clone.
 * It reads an existing clone as-is, or uses a temporary clone that is removed on
 * both success and failure.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({ isGitRepo: vi.fn(), clone: vi.fn(), setRemote: vi.fn() }));
const authMocks = vi.hoisted(() => ({ ensureRepoAuth: vi.fn() }));
const { isGitRepo, clone, setRemote } = gitMocks;

vi.mock("../../src/core/repo/git.js", () => gitMocks);
vi.mock("../../src/core/auth/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/core/auth/index.js")>(),
  ensureRepoAuth: authMocks.ensureRepoAuth,
}));
vi.mock("../../src/core/config/index.js", () => ({
  loadConfigOrDefault: async () => ({
    repo: { provider: "generic", url: "", localPath: "" },
    tools: [],
    sourceOfTruth: "local",
    includeSecrets: false,
    includeMemories: false,
    extraPaths: [],
    autoBackup: "off",
  }),
}));

import { prepareDryRunRepo, run } from "../../src/commands/restore.js";
import type { RepoConfig } from "../../src/core/config/schema.js";

function repo(localPath: string): RepoConfig {
  return { provider: "generic", url: "https://example.test/backup.git", localPath };
}

beforeEach(() => {
  isGitRepo.mockReset();
  clone.mockReset();
  setRemote.mockReset();
  authMocks.ensureRepoAuth.mockReset();
});

describe("prepareDryRunRepo", () => {
  it("uses an existing clone without cloning or refreshing it", async () => {
    const existing = path.join(os.tmpdir(), "arbella-existing-preview");
    isGitRepo.mockResolvedValue(true);

    const preview = await prepareDryRunRepo(repo(existing));

    expect(preview.repoRoot).toBe(existing);
    expect(clone).not.toHaveBeenCalled();
    await expect(preview.cleanup()).resolves.toBeUndefined();
  });

  it("clones into a disposable directory and leaves the configured path untouched", async () => {
    const configured = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-configured-"));
    isGitRepo.mockResolvedValue(false);
    clone.mockImplementation(async (_url: string, dest: string) => {
      await fsp.mkdir(dest, { recursive: true });
    });

    try {
      const preview = await prepareDryRunRepo(repo(configured));
      const temporaryRoot = path.dirname(preview.repoRoot);

      expect(clone).toHaveBeenCalledWith("https://example.test/backup.git", preview.repoRoot);
      expect(preview.repoRoot).not.toBe(configured);
      expect(await fsp.stat(configured)).toBeDefined();

      await preview.cleanup();
      await expect(fsp.stat(temporaryRoot)).rejects.toThrow();
      expect(await fsp.stat(configured)).toBeDefined();
    } finally {
      await fsp.rm(configured, { recursive: true, force: true });
    }
  });

  it("removes a partially cloned preview directory when cloning fails", async () => {
    isGitRepo.mockResolvedValue(false);
    let cloneDest = "";
    clone.mockImplementation(async (_url: string, dest: string) => {
      cloneDest = dest;
      await fsp.mkdir(dest, { recursive: true });
      throw new Error("clone failed");
    });

    await expect(prepareDryRunRepo(repo(path.join(os.tmpdir(), "arbella-missing-preview"))))
      .rejects.toThrow("clone failed");

    expect(cloneDest).not.toBe("");
    await expect(fsp.stat(path.dirname(cloneDest))).rejects.toThrow();
  });

  it("reuses stored private-repo credentials without prompting or keeping the authenticated URL", async () => {
    isGitRepo.mockResolvedValue(false);
    const authenticated = "https://oauth2:PREVIEW_TEST_TOKEN@example.test/backup.git";
    clone.mockRejectedValueOnce(new Error("fatal: Authentication failed"));
    clone.mockImplementationOnce(async (_url: string, dest: string) => {
      await fsp.mkdir(dest, { recursive: true });
    });
    authMocks.ensureRepoAuth.mockResolvedValue({
      needsAuth: true,
      authUrl: authenticated,
      reason: "Reused a stored test token",
    });

    const preview = await prepareDryRunRepo(repo(path.join(os.tmpdir(), "arbella-private-preview")));
    try {
      expect(authMocks.ensureRepoAuth).toHaveBeenCalledWith(expect.objectContaining({
        interactive: false,
        requireAuth: true,
      }));
      expect(clone).toHaveBeenLastCalledWith(authenticated, preview.repoRoot);
      expect(setRemote).toHaveBeenCalledWith(preview.repoRoot, "origin", "https://example.test/backup.git");
    } finally {
      await preview.cleanup();
    }
    await expect(fsp.stat(path.dirname(preview.repoRoot))).rejects.toThrow();
  });

  it("cleans the temporary clone when dry-run planning fails", async () => {
    isGitRepo.mockResolvedValue(false);
    let cloneDest = "";
    clone.mockImplementation(async (_url: string, dest: string) => {
      cloneDest = dest;
      await fsp.mkdir(dest, { recursive: true });
      // No arbella.json: `run()` reaches the planner body and fails there.
    });

    await expect(run("https://example.test/backup.git", { dryRun: true }))
      .rejects.toThrow("arbella.json");

    expect(cloneDest).not.toBe("");
    await expect(fsp.stat(path.dirname(cloneDest))).rejects.toThrow();
  });
});
