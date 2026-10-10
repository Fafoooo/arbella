/**
 * `arbella status` names this machine's role and the secrets the last pull
 * could not fill in, re-checked against the files so a key the user has since
 * filled in drops out. A follower is never told to push.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/repo/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/repo/index.js")>()),
  ensureLocalClone: async () => undefined,
}));

import { run } from "../../src/commands/status.js";
import { followerConfig, saveConfig } from "../../src/core/config/index.js";
import { saveLedger } from "../../src/core/placement/ledger.js";
import { fs as realFs } from "../../src/utils/fs.js";

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let home: string;
let stderr: string[];

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-status-role-")));
  home = path.join(root, "home");
  await fsp.mkdir(home, { recursive: true });
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
  });
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fsp.rm(root, { recursive: true, force: true });
});

describe("arbella status on a follower", () => {
  it("prints role and secret missing from the ledger, drops entries now filled in", async () => {
    const repoPath = path.join(root, "clone");
    await fsp.mkdir(repoPath, { recursive: true });
    await saveConfig(
      followerConfig(
        { provider: "generic", url: "https://example.test/me/cfg.git", localPath: repoPath },
        { tools: [], includeMemories: false },
        "machine-1",
      ),
    );

    const codexConfig = path.join(home, ".codex", "config.toml");
    const settings = path.join(home, ".claude", "settings.json");
    await realFs.write(codexConfig, '[mcp_servers.unifi]\ncommand = "uvx"\n\n[mcp_servers.unifi.env]\n');
    await realFs.write(settings, JSON.stringify({ env: { API_TOKEN: "filled-in-here" } }));
    await saveLedger(realFs, {
      version: 1,
      files: {},
      missingSecrets: [
        { tool: "codex", file: codexConfig, keyPath: ["mcp_servers", "unifi", "env", "UNIFI_PASSWORD"] },
        { tool: "claude", file: settings, keyPath: ["env", "API_TOKEN"] },
      ],
    });

    await run({});

    const out = stderr.join("").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("Role: follower");
    expect(out).toContain("secret missing: codex mcp unifi → UNIFI_PASSWORD");
    expect(out).not.toContain("API_TOKEN");
    expect(out).not.toContain("filled-in-here");
    expect(out).not.toContain("arbella push");
  });
});
