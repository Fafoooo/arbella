/**
 * Every adapter and the shared/home step place files through the placement
 * engine: a marker-broken local file is repaired, a differing one is kept and
 * reported, a real local secret survives, and plan and write agree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

vi.mock("../../src/platform/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/platform/install.js")>()),
  which: async () => false,
}));

import * as claude from "../../src/adapters/claude/restore.js";
import * as codex from "../../src/adapters/codex/restore.js";
import * as cursor from "../../src/adapters/cursor/index.js";
import * as antigravity from "../../src/adapters/antigravity/index.js";
import { planConfigDirActions, restoreConfigDir } from "../../src/adapters/shared/configDir.js";
import { planHomeFileActions, restoreHomeFiles } from "../../src/core/homefiles/restore.js";
import type { HomeRestoreServices } from "../../src/core/homefiles/restore.js";
import { newPullSession, type PullSession } from "../../src/core/placement/index.js";
import { sha256 } from "../../src/core/placement/ledger.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import { REDACTED as R } from "../../src/core/sanitizer/patterns.js";
import { HOOK_TAG } from "../../src/core/autobackup/hook.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { fs as realFs } from "../../src/utils/fs.js";
import type { RestoreContext, RestoreData } from "../../src/adapters/adapter.interface.js";
import type { RestoreAction, SourceOfTruth, ToolId } from "../../src/types.js";

const silent = { info() {}, success() {}, warn() {}, error() {}, step() {}, debug() {} };

let root: string;
beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-wiring-")));
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const follower = (): PullSession =>
  newPullSession({ role: "follower", force: false, ledger: { version: 1, files: {}, missingSecrets: [] } });
const forcedSource = (): PullSession =>
  newPullSession({ role: "source", force: true, ledger: { version: 1, files: {}, missingSecrets: [] } });

function restoreCtx(tool: string, sourceOfTruth: SourceOfTruth, pull?: PullSession): RestoreContext {
  const home = path.join(root, "home");
  const toolHome = path.join(home, `.${tool}`);
  return {
    fs: realFs,
    log: silent,
    sanitizer: createSanitizer(),
    templater: createTemplater(),
    vars: makeVariables(home, "fab", "linux", toolHome),
    os: "linux",
    env: {},
    toolHome,
    repoToolDir: path.join(root, "repo", tool),
    repoRoot: path.join(root, "repo"),
    sourceOfTruth,
    dryRun: false,
    ...(pull ? { pull } : {}),
  };
}

async function put(abs: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

const data = (tool: ToolId, files: RestoreData["files"]): RestoreData => ({
  manifest: emptyManifest(tool),
  files,
  symlinks: [],
});

const opencodeSpec = { tool: "opencode" as const, frozenPaths: [] };

interface AdapterCase {
  id: ToolId;
  prefix: string;
  restore(ctx: RestoreContext, d: RestoreData): Promise<void>;
  plan(ctx: RestoreContext, d: RestoreData): Promise<RestoreAction[]>;
}

const adapters: AdapterCase[] = [
  { id: "claude", prefix: "claude/files", restore: claude.restore, plan: claude.planActions },
  { id: "codex", prefix: "codex/files", restore: codex.restore, plan: codex.planActions },
  { id: "cursor", prefix: "cursor/files", restore: cursor.restore, plan: cursor.planActions },
  {
    id: "opencode",
    prefix: "opencode/files",
    restore: (c, d) => restoreConfigDir(c, d, opencodeSpec),
    plan: (c, d) => planConfigDirActions(c, d, opencodeSpec),
  },
  { id: "antigravity", prefix: "antigravity/files", restore: antigravity.restore, plan: antigravity.planActions },
];

const repoJson = '{\n  "server": "https://example.test",\n  "mode": "fast"\n}';
const brokenJson = `{\n  "server": "https://example.test",\n  "mode": "${R}"\n}`;

describe.each(adapters)("$id restore through the placement engine", ({ id, prefix, restore, plan }) => {
  it("replaces a marker-broken local file under sourceOfTruth local, without a session", async () => {
    const ctx = restoreCtx(id, "local");
    const dest = path.join(ctx.toolHome, "conf.json");
    await put(dest, brokenJson);
    const d = data(id, [{ repoPath: `${prefix}/conf.json`, content: repoJson }]);

    const actions = (await plan(ctx, d)).filter((a) => a.type === "write-file");
    await restore(ctx, d);

    expect(await fsp.readFile(dest, "utf8")).toBe(repoJson);
    expect(actions).toEqual([expect.objectContaining({ targetPath: dest, overwrites: true })]);
  });

  it("keeps a differing local file and lists it in the session report", async () => {
    const session = follower();
    const ctx = restoreCtx(id, "repo", session);
    const dest = path.join(ctx.toolHome, "conf.json");
    const mine = '{\n  "mode": "mine"\n}';
    await put(dest, mine);
    const d = data(id, [{ repoPath: `${prefix}/conf.json`, content: repoJson }]);

    const actions = (await plan(ctx, d)).filter((a) => a.type === "write-file");
    await restore(ctx, d);

    expect(await fsp.readFile(dest, "utf8")).toBe(mine);
    expect(actions).toEqual([]);
    expect(session.report.tools[id]?.kept).toEqual([dest]);
  });
});

describe("codex config.toml", () => {
  it("keeps a real local secret under sourceOfTruth repo", async () => {
    const ctx = restoreCtx("codex", "repo");
    const dest = path.join(ctx.toolHome, "config.toml");
    await put(dest, `[mcp_servers.u]\ncommand = '${ctx.vars.HOME}/bin/run'\n\n[mcp_servers.u.env]\nP = "local-fixture-value"\n`);
    // Literal string: a Windows {{HOME}} in a basic string breaks TOML (rehydrateConfigToml limitation).
    const repo = `[mcp_servers.u]\ncommand = '{{HOME}}/bin/run'\n\n[mcp_servers.u.env]\nP = "${R}"\n`;

    await codex.restore(ctx, data("codex", [{ repoPath: "codex/files/config.toml", content: repo }]));

    const onDisk = parseToml(await fsp.readFile(dest, "utf8")) as {
      mcp_servers: { u: { command: string; env: { P: string } } };
    };
    expect(onDisk.mcp_servers.u.env.P).toBe("local-fixture-value");
    expect(onDisk.mcp_servers.u.command).toBe(`${ctx.vars.HOME}/bin/run`);
  });
});

describe("arbella's own autobackup hook", () => {
  const ours = { hooks: [{ type: "command", command: `arbella push --auto >/dev/null 2>&1 & # ${HOOK_TAG}` }] };
  const cases = [
    { id: "claude", restore: claude.restore, repoPath: "claude/files/settings.json", rel: "settings.json" },
    { id: "codex", restore: codex.restore, repoPath: "codex/files/hooks.json", rel: "hooks.json" },
  ] as const;

  it.each(cases)("$id: the reinstalled hook alone does not make $rel differ", async ({ id, restore, repoPath, rel }) => {
    const session = forcedSource();
    const ctx = restoreCtx(id, "repo", session);
    const dest = path.join(ctx.toolHome, rel);
    const local = JSON.stringify({ hooks: { SessionStart: [ours] }, x: 1 }, null, 2) + "\n";
    await put(dest, local);

    await restore(ctx, data(id, [{ repoPath, content: '{"hooks":{},"x":1}' }]));

    expect(await fsp.readFile(dest, "utf8")).toBe(local);
    expect(session.report.tools[id]).toEqual({ written: 0, identical: 1, kept: [] });
  });
});

describe("claude hooks and enabledPlugins", () => {
  it("a hook script equal to the repo text with real values survives force", async () => {
    const session = forcedSource();
    const ctx = restoreCtx("claude", "repo", session);
    const dest = path.join(ctx.toolHome, "hooks", "notify.sh");
    const local = '#!/bin/sh\nTOKEN="local-fixture-value"\ncurl -H "x: $TOKEN" https://example.test\n';
    await put(dest, local);
    const repo = `#!/bin/sh\nTOKEN="${R}"\ncurl -H "x: $TOKEN" https://example.test\n`;
    const d = data("claude", [{ repoPath: "claude/files/hooks/notify.sh", content: repo, mode: 0o755 }]);

    const actions = (await claude.planActions(ctx, d)).filter((a) => a.type === "write-file");
    await claude.restore(ctx, d);

    expect(await fsp.readFile(dest, "utf8")).toBe(local);
    expect(actions).toEqual([]);
    expect(session.report.tools.claude?.identical).toBe(1);
  });

  it("skips the enabledPlugins overlay when settings.json was kept", async () => {
    const session = follower();
    const ctx = restoreCtx("claude", "repo", session);
    const settings = path.join(ctx.toolHome, "settings.json");
    const mine = JSON.stringify({ enabledPlugins: { "a@m": false }, theme: "dark" }, null, 2);
    await put(settings, mine);
    const d: RestoreData = {
      manifest: { ...emptyManifest("claude"), enabledPlugins: { "a@m": true } },
      files: [{ repoPath: "claude/files/settings.json", content: JSON.stringify({ enabledPlugins: { "a@m": true } }) }],
      symlinks: [],
    };

    const actions = await claude.planActions(ctx, d);
    await claude.restore(ctx, d);

    expect(await fsp.readFile(settings, "utf8")).toBe(mine);
    expect(actions.filter((a) => a.type === "enable-plugin")).toEqual([]);
    expect(session.report.tools.claude?.kept).toEqual([settings]);
  });

  it("applies the overlay to a settings.json written this pass and records its hash", async () => {
    const session = follower();
    const ctx = restoreCtx("claude", "repo", session);
    const settings = path.join(ctx.toolHome, "settings.json");
    const d: RestoreData = {
      manifest: { ...emptyManifest("claude"), enabledPlugins: { "a@m": true } },
      files: [{ repoPath: "claude/files/settings.json", content: "{}" }],
      symlinks: [],
    };

    const actions = await claude.planActions(ctx, d);
    await claude.restore(ctx, d);

    const onDisk = await fsp.readFile(settings, "utf8");
    expect(JSON.parse(onDisk).enabledPlugins).toEqual({ "a@m": true });
    expect(actions.filter((a) => a.type === "enable-plugin")).toHaveLength(1);
    expect(session.ledger.files[settings]).toBe(sha256(onDisk));
  });

  it("an overlay-written settings.json with a secret filled in later still takes repo updates", async () => {
    const first = follower();
    const ctx = restoreCtx("claude", "repo", first);
    const settings = path.join(ctx.toolHome, "settings.json");
    const repoSettings = (model: string): RestoreData => ({
      manifest: { ...emptyManifest("claude"), enabledPlugins: { "a@m": true } },
      files: [
        {
          repoPath: "claude/files/settings.json",
          content: JSON.stringify({ env: { API_TOKEN: R }, model }, null, 2) + "\n",
        },
      ],
      symlinks: [],
    });
    await claude.restore(ctx, repoSettings("a"));

    // The user fills in the secret the pull reported as missing.
    const placed = JSON.parse(await fsp.readFile(settings, "utf8"));
    await fsp.writeFile(
      settings,
      JSON.stringify({ ...placed, env: { API_TOKEN: "filled-in-here" } }, null, 2) + "\n",
    );

    const second = newPullSession({ role: "follower", force: false, ledger: first.ledger });
    await claude.restore(restoreCtx("claude", "repo", second), repoSettings("b"));

    const after = JSON.parse(await fsp.readFile(settings, "utf8"));
    expect(after.model).toBe("b");
    expect(after.env.API_TOKEN).toBe("filled-in-here");
    expect(second.report.tools.claude?.kept).toEqual([]);
  });
});

describe("shared/home through the placement engine", () => {
  function homeCtx(sourceOfTruth: SourceOfTruth, pull?: PullSession): HomeRestoreServices {
    const home = path.join(root, "home");
    return {
      fs: realFs,
      log: silent,
      sanitizer: createSanitizer(),
      templater: createTemplater(),
      vars: makeVariables(home, "fab", "linux"),
      os: "linux",
      env: {},
      sourceOfTruth,
      dryRun: false,
      ...(pull ? { pull } : {}),
    };
  }
  const safetyDir = () => path.join(root, "safety");

  it("replaces a marker-broken local file under sourceOfTruth local and safety-copies it", async () => {
    const ctx = homeCtx("local");
    const dest = path.join(ctx.vars.HOME, ".config", "tool", "conf.json");
    await put(dest, brokenJson);
    const files = [{ repoPath: "shared/home/.config/tool/conf.json", content: repoJson }];

    const actions = await planHomeFileActions(ctx, files);
    const written = await restoreHomeFiles(ctx, files, { safetyDir: safetyDir() });

    expect(written).toBe(1);
    expect(await fsp.readFile(dest, "utf8")).toBe(repoJson);
    expect(await fsp.readFile(path.join(safetyDir(), ".config", "tool", "conf.json"), "utf8")).toBe(brokenJson);
    expect(actions).toEqual([expect.objectContaining({ targetPath: dest, overwrites: true })]);
  });

  it("keeps a differing local file, lists it in the report and makes no safety copy", async () => {
    const session = follower();
    const ctx = homeCtx("repo", session);
    const dest = path.join(ctx.vars.HOME, ".config", "tool", "conf.json");
    await put(dest, '{"mode":"mine"}');
    const files = [{ repoPath: "shared/home/.config/tool/conf.json", content: repoJson }];

    const actions = await planHomeFileActions(ctx, files);
    const written = await restoreHomeFiles(ctx, files, { safetyDir: safetyDir() });

    expect(written).toBe(0);
    expect(await fsp.readFile(dest, "utf8")).toBe('{"mode":"mine"}');
    expect(await realFs.exists(safetyDir())).toBe(false);
    expect(actions).toEqual([]);
    expect(session.report.tools.home?.kept).toEqual([dest]);
  });
});
