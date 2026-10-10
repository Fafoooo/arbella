/**
 * `arbella pull <url>` end to end on a tmp HOME, with git mocked to copy a
 * fixture repo: a machine without a config adopts the follower role, a pull
 * session decides every placement (ledger, marker repair, kept files), the
 * summary replaces the old "restored" lines, and the autobackup hook never
 * reaches a follower.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({
  isGitRepo: vi.fn(),
  clone: vi.fn(),
  pull: vi.fn(),
  setRemote: vi.fn(),
}));
vi.mock("../../src/core/repo/git.js", () => gitMocks);
vi.mock("../../src/commands/setup.js", () => ({ ensureDeps: async () => ({ ok: true }) }));
vi.mock("../../src/platform/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/platform/install.js")>()),
  which: async () => false,
  ensureCli: async () => undefined,
}));
// Lets a test make the shared/home step (which runs after the adapters) throw.
const homeStep = vi.hoisted(() => ({ fail: false }));
vi.mock("../../src/core/homefiles/restore.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/homefiles/restore.js")>();
  return {
    ...real,
    restoreHomeFiles: async (...a: Parameters<typeof real.restoreHomeFiles>) => {
      if (homeStep.fail) throw new Error("interrupted");
      return real.restoreHomeFiles(...a);
    },
  };
});

import { run } from "../../src/commands/restore.js";
import { saveConfig, defaultConfig } from "../../src/core/config/index.js";
import { HOOK_TAG } from "../../src/core/autobackup/hook.js";
import { REDACTED as R } from "../../src/core/sanitizer/patterns.js";

const URL = "https://example.test/me/cfg.git";
const CREATED_AT = "2026-10-01T12:00:00.000Z";

let root: string;
let home: string;
let remote: string;
let xdgConfig: string;
let xdgData: string;
let stderr: string[];

// Set on the real process.env (never replace the object): os.homedir() reads
// the C-level environment, which only assignments to process.env reach.
const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const exists = (p: string): Promise<boolean> => fsp.access(p).then(() => true, () => false);

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-follower-")));
  home = path.join(root, "home");
  remote = path.join(root, "remote");
  xdgConfig = path.join(root, "xdg-config");
  xdgData = path.join(root, "xdg-data");
  await fsp.mkdir(home, { recursive: true });
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  });

  gitMocks.isGitRepo.mockReset().mockImplementation((p: string) => exists(path.join(p, "arbella.json")));
  gitMocks.clone.mockReset().mockImplementation(async (_url: string, dest: string) => {
    await fsp.cp(remote, dest, { recursive: true });
  });
  gitMocks.pull.mockReset().mockImplementation(async (dest: string) => {
    await fsp.cp(remote, dest, { recursive: true, force: true });
  });

  homeStep.fail = false;
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

/** Everything the pull logged, without colors. */
const output = (): string => stderr.join("").replace(/\x1b\[[0-9;]*m/g, "");

async function put(abs: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

/** Write the fake remote: repo-relative files plus arbella.json. */
async function writeRemote(
  files: Record<string, string>,
  createdAt = CREATED_AT,
  sharedInstructions = false,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) await put(path.join(remote, rel), content);
  await put(
    path.join(remote, "arbella.json"),
    JSON.stringify({
      schemaVersion: 1,
      arbellaVersion: "1.1.0",
      tools: ["claude", "codex"],
      options: { includeSecrets: false, includeMemories: true, sourceOfTruth: "local" },
      createdAt,
      sharedInstructions,
    }),
  );
}

const ledgerFile = (): string => path.join(xdgData, "arbella", "pull-ledger.json");

const configFile = (): string => path.join(xdgConfig, "arbella", "config.json");
const readConfig = async (): Promise<Record<string, any>> =>
  JSON.parse(await fsp.readFile(configFile(), "utf8"));
const claudeHome = (...p: string[]): string => path.join(home, ".claude", ...p);

const hookGroup = {
  hooks: [{ type: "command", command: `arbella push --auto >/dev/null 2>&1 & # ${HOOK_TAG}` }],
};
const userGroup = { hooks: [{ type: "command", command: "echo hello" }] };

async function saveSourceConfig(url: string, extra: Record<string, unknown> = {}): Promise<void> {
  await saveConfig({
    ...defaultConfig(),
    repo: { provider: "generic", url, localPath: path.join(root, "source-clone") },
    ...extra,
  });
}

describe("arbella pull as a follower", () => {
  it("pull <url> without config writes a follower config pointing at the restore clone", async () => {
    await writeRemote({ "claude/files/CLAUDE.md": "# hi\n" });

    await run(URL, {});

    const cfg = await readConfig();
    expect(cfg.role).toBe("follower");
    expect(cfg.sourceOfTruth).toBe("repo");
    expect(cfg.autoBackup).toBe("off");
    expect(cfg.repo.url).toBe(URL);
    expect(cfg.repo.localPath).toBe(path.join(xdgData, "arbella", "restore", "me-cfg"));
    expect(cfg.machineId).toEqual(expect.any(String));
    expect(cfg.tools).toEqual(["claude", "codex"]);
    expect(cfg.includeMemories).toBe(true);
    expect(await fsp.readFile(claudeHome("CLAUDE.md"), "utf8")).toBe("# hi\n");
    const adopted = `This machine now follows ${URL}: it pulls, never pushes. Run \`arbella init\` to make it a source.`;
    expect(output().split(adopted)).toHaveLength(2);
  });

  it("second pull overwrites ledger-unchanged files, keeps edited ones", async () => {
    await writeRemote({ "claude/files/a.md": "a1\n", "claude/files/b.md": "b1\n" });
    await run(URL, {});
    await fsp.writeFile(claudeHome("b.md"), "mine\n");

    await writeRemote({ "claude/files/a.md": "a2\n", "claude/files/b.md": "b2\n" });
    await run(URL, {});

    expect(await fsp.readFile(claudeHome("a.md"), "utf8")).toBe("a2\n");
    expect(await fsp.readFile(claudeHome("b.md"), "utf8")).toBe("mine\n");
    expect(output()).toContain("kept ~/.claude/b.md");
  });

  it("first pull without ledger replaces marker-broken files, keeps other differing files", async () => {
    await put(claudeHome("settings.json"), `{\n  "model": "${R}"\n}\n`);
    await put(claudeHome("notes.md"), "mine\n");
    await writeRemote({
      "claude/files/settings.json": '{\n  "model": "opus"\n}\n',
      "claude/files/notes.md": "repo\n",
    });

    await run(URL, {});

    expect(await fsp.readFile(claudeHome("settings.json"), "utf8")).toBe('{\n  "model": "opus"\n}\n');
    expect(await fsp.readFile(claudeHome("notes.md"), "utf8")).toBe("mine\n");
  });

  it("summary lists kept paths and never prints 'restored'", async () => {
    await put(claudeHome("notes.md"), "mine\n");
    await put(path.join(home, ".local", "bin", "tool.sh"), "mine\n");
    await writeRemote({
      "claude/files/notes.md": "repo\n",
      "claude/files/CLAUDE.md": "# hi\n",
      "shared/home/.local/bin/tool.sh": "repo\n",
    });

    await run(URL, {});

    const out = output();
    expect(out).toContain("claude: 1 written, 0 unchanged, 1 kept");
    expect(out).toContain("kept ~/.claude/notes.md");
    expect(out).toContain("kept ~/.local/bin/tool.sh");
    expect(out).toContain("Kept files are changed locally; `arbella pull --force` replaces them.");
    expect(out).not.toMatch(/\b(claude|codex): restored\b/);
    expect(out).not.toMatch(/Shared home files: \d+ of \d+ written/);
  });

  it("stale autobackup hook removed on follower", async () => {
    const stale = JSON.stringify({ model: "mine", hooks: { SessionStart: [userGroup, hookGroup] } }, null, 2);
    await put(claudeHome("settings.json"), stale);
    await put(path.join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [hookGroup] } }));
    await writeRemote({ "claude/files/settings.json": '{\n  "model": "repo"\n}\n' });

    await run(URL, {});

    const settings = await fsp.readFile(claudeHome("settings.json"), "utf8");
    expect(settings).not.toContain(HOOK_TAG);
    expect(JSON.parse(settings).hooks.SessionStart).toEqual([userGroup]);
    expect(await fsp.readFile(path.join(home, ".codex", "hooks.json"), "utf8")).not.toContain(HOOK_TAG);
  });

  it("repo settings.json carrying the hook does not restore it", async () => {
    // A source without autobackup: nothing re-installs or removes hooks here,
    // so only the repo read can keep the hook out.
    await saveSourceConfig(URL);
    await fsp.mkdir(claudeHome(), { recursive: true });
    await writeRemote({
      "claude/files/settings.json":
        JSON.stringify({ model: "repo", hooks: { SessionStart: [userGroup, hookGroup] } }, null, 2) + "\n",
    });

    await run(URL, {});

    const settings = await fsp.readFile(claudeHome("settings.json"), "utf8");
    expect(settings).not.toContain(HOOK_TAG);
    expect(JSON.parse(settings).hooks.SessionStart).toEqual([userGroup]);
  });

  it("pull records lastSyncedPush", async () => {
    await writeRemote({ "claude/files/CLAUDE.md": "# hi\n" });
    await run(URL, {});
    expect((await readConfig()).lastSyncedPush).toBe(CREATED_AT);

    // A source pulling its own repo records it too...
    await saveSourceConfig(URL, { lastSyncedPush: "older" });
    await run(URL, {});
    expect((await readConfig()).lastSyncedPush).toBe(CREATED_AT);

    // ...while an ad-hoc pull of another repo leaves the config alone.
    await saveSourceConfig(URL, { lastSyncedPush: "older" });
    const before = await fsp.readFile(configFile(), "utf8");
    await run("https://example.test/someone/else.git", {});
    expect(await fsp.readFile(configFile(), "utf8")).toBe(before);
  });

  it("a pull limited by --tools does not count as synced", async () => {
    await writeRemote({ "claude/files/CLAUDE.md": "# hi\n" });
    await saveSourceConfig(URL, { lastSyncedPush: "older" });

    await run(URL, { tools: "claude" });

    expect(await fsp.readFile(claudeHome("CLAUDE.md"), "utf8")).toBe("# hi\n");
    expect((await readConfig()).lastSyncedPush).toBe("older");
  });

  it("a pull that throws after placing files still saves the ledger, but not lastSyncedPush", async () => {
    await writeRemote({ "claude/files/CLAUDE.md": "# hi\n", "shared/home/.local/bin/t.sh": "x\n" });
    await saveSourceConfig(URL, { lastSyncedPush: "older" });
    homeStep.fail = true;

    await expect(run(URL, {})).rejects.toThrow("interrupted");

    const ledger = JSON.parse(await fsp.readFile(ledgerFile(), "utf8"));
    expect(ledger.files[claudeHome("CLAUDE.md")]).toEqual(expect.any(String));
    expect((await readConfig()).lastSyncedPush).toBe("older");
  });

  it("dry-run writes no config, no ledger, no files", async () => {
    await writeRemote({ "claude/files/CLAUDE.md": "# hi\n" });

    await run(URL, { dryRun: true });

    expect(await exists(configFile())).toBe(false);
    expect(await exists(ledgerFile())).toBe(false);
    expect(await exists(claudeHome("CLAUDE.md"))).toBe(false);
  });

  it("dry-run shows the shared-instructions step exactly as the real pull runs it", async () => {
    await put(path.join(home, ".codex", "AGENTS.md"), "mine\n");
    await writeRemote({ "shared/instructions.md": "# shared\n" }, CREATED_AT, true);

    await run(URL, { dryRun: true });

    const claudeMd = claudeHome("CLAUDE.md");
    const agentsMd = path.join(home, ".codex", "AGENTS.md");
    expect(output()).toContain(`Would deploy shared instructions -> ${claudeMd}`);
    expect(output()).not.toContain(`-> ${agentsMd}`);
    expect(await exists(claudeMd)).toBe(false);

    await run(URL, {});
    expect(output()).toContain(`Deployed shared instructions -> ${claudeMd}`);
    expect(output()).not.toContain(`Deployed shared instructions -> ${agentsMd}`);
    expect(await fsp.readFile(agentsMd, "utf8")).toBe("mine\n");
  });
});

/* -------------------------------------------------------------------------- */
/* Incident replay (acceptance)                                                */
/* -------------------------------------------------------------------------- */

/** Every .json/.toml file under `dir`, recursively. */
async function structuredFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await structuredFiles(abs)));
    else if (/\.(json|toml)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

describe("incident replay: a machine broken by the old sanitizer pulls as a follower", () => {
  it("repairs every marker in JSON/TOML, keeps the edited memory and reports what is missing", async () => {
    const settings = `{\n  "env": {\n    "API_TOKEN": "${R}",\n    "FEATURE_SWITCH": "1"\n  },\n  "model": "opus"\n}\n`;
    const configToml =
      'model = "o3"\n\n[mcp_servers.unifi]\ncommand = "uvx"\nargs = [ "unifi-mcp" ]\n\n' +
      `[mcp_servers.unifi.env]\nUNIFI_HOST = "192.0.2.1"\nUNIFI_PASSWORD = "${R}"\n`;
    const hook = '#!/bin/sh\nexec notify --config "$HOME/.notify.conf" done\n';
    const memoryRepoPath = "claude/memories/home/ROOT/note.md";
    await writeRemote({
      "claude/files/settings.json": settings,
      "claude/files/hooks/notify.sh": hook,
      [memoryRepoPath]: "repo memory\n",
      "claude/manifest.json": JSON.stringify({
        tool: "claude",
        mcpServers: { serena: { command: "serena", env: { SERENA_TOKEN: R } } },
      }),
      "codex/files/config.toml": configToml,
    });

    // The old pull wrote the markers verbatim, and the old sanitizer also
    // redacted values that were never secrets (a switch, a host, a path).
    await put(claudeHome("settings.json"), settings.replace('"1"', `"${R}"`));
    await put(path.join(home, ".codex", "config.toml"), configToml.replace('"192.0.2.1"', `"${R}"`));
    await put(claudeHome("hooks", "notify.sh"), hook.replace('"$HOME/.notify.conf"', R));
    const memory = claudeHome("projects", home.replace(/[^A-Za-z0-9]/g, "-"), "memory", "note.md");
    await put(memory, "my edited memory\n");

    await run(URL, {});

    for (const file of await structuredFiles(home)) {
      expect(await fsp.readFile(file, "utf8"), file).not.toContain(R);
    }
    expect(JSON.parse(await fsp.readFile(claudeHome("settings.json"), "utf8")).env).toEqual({
      FEATURE_SWITCH: "1",
    });
    expect(await fsp.readFile(claudeHome("hooks", "notify.sh"), "utf8")).toBe(hook);
    expect(await fsp.readFile(memory, "utf8")).toBe("my edited memory\n");
    expect((await readConfig()).role).toBe("follower");

    const out = output();
    expect(out).toContain(`kept ~${memory.slice(home.length)}`);
    expect(out).toContain("secret missing: codex mcp unifi → UNIFI_PASSWORD");
    expect(out).toContain("secret missing: claude mcp serena → SERENA_TOKEN");
    expect(out).toContain("secret missing: claude ~/.claude/settings.json → env.API_TOKEN");
  });
});
