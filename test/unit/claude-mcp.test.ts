/**
 * Unit tests for the Claude MCP-server bridge (src/adapters/claude/mcp.ts).
 *
 * ~/.claude.json is the file arbella most wants to keep OUT of the repo (OAuth
 * account, telemetry, full project history) and simultaneously the only place
 * user-scope MCP servers live. These tests pin both halves of that deal:
 *
 *   CAPTURE  — only mcpServers + projects.*.mcpServers ever leave the file; the
 *              fixture's oauthAccount/accessToken/userID must appear NOWHERE in
 *              the manifest, and env values are redacted to {{REDACTED}} with a
 *              SecretRef each. Absolute paths fold to {{HOME}}.
 *   RESTORE  — a key-wise merge into ~/.claude.json: other keys survive
 *              untouched, sourceOfTruth decides who wins, the file is created
 *              0600 when absent, invalid JSON is never clobbered, project entries
 *              apply only when the project dir exists, and every redacted env key
 *              produces a warning.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  captureMcpServers,
  describeServerLaunch,
  findProjectKey,
  MAX_LAUNCH_SUMMARY,
  planMcpMerge,
  restoreMcpServers,
} from "../../src/adapters/claude/mcp.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import type { ToolManifest } from "../../src/types.js";
import type { CaptureContext, RestoreContext } from "../../src/adapters/adapter.interface.js";
import { isPosixHost, toPosix, toPosixAll } from "../helpers/platform.js";

/* -------------------------------------------------------------------------- */
/* Sentinels that must never reach the repo                                    */
/* -------------------------------------------------------------------------- */

const OAUTH_TOKEN = "sk-ant-oat01-DO-NOT-LEAK-ZZZZZZZZZZZZZZZZZZZZZZZZ";
const USER_ID = "acct_1234567890abcdefUSERID";
const MCP_ENV_SECRET = "glpat-MCP-ENV-SECRET-YYYYYYYYYYYYY";

const sanitizer = createSanitizer();
const templater = createTemplater();

let tmpRoot: string;
let home: string;
let toolHome: string;
let warnings: string[];
let debugs: string[];

function makeLog() {
  return {
    info() {},
    success() {},
    warn(msg: string) {
      warnings.push(msg);
    },
    error() {},
    step() {},
    debug(msg: string) {
      debugs.push(msg);
    },
  };
}

function captureCtx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  return {
    fs: realFs,
    log: makeLog(),
    sanitizer,
    templater,
    vars: makeVariables(home, "fab", "linux", toolHome),
    os: "linux",
    env: {},
    toolHome,
    includeSecrets: false,
    includeMemories: false,
    dryRun: false,
    ...overrides,
  };
}

function restoreCtx(overrides: Partial<RestoreContext> = {}): RestoreContext {
  return {
    fs: realFs,
    log: makeLog(),
    sanitizer,
    templater,
    vars: makeVariables(home, "fab", "linux", toolHome),
    os: "linux",
    env: {},
    toolHome,
    repoToolDir: path.join(tmpRoot, "repo", "claude"),
    repoRoot: path.join(tmpRoot, "repo"),
    sourceOfTruth: "repo",
    dryRun: false,
    ...overrides,
  };
}

/** Stands in for the fixture $HOME, which is only known at runtime. */
const HOME_PLACEHOLDER = "__HOME__";

/** The fixture ~/.claude.json: MCP servers surrounded by things that must stay. */
function globalStateFixture() {
  return {
    numStartups: 412,
    userID: USER_ID,
    oauthAccount: {
      accountUuid: "9a1c-uuid",
      emailAddress: "fab@example.com",
      accessToken: OAUTH_TOKEN,
    },
    tipsHistory: { "memory-command": 7 },
    mcpServers: {
      serena: {
        command: "/bin/sh",
        args: [`${HOME_PLACEHOLDER}/.agents/bin/serena.sh`, "--stdio"],
        env: { SERENA_TOKEN: MCP_ENV_SECRET },
      },
      playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
    },
    projects: {
      "/tmp/does-not-exist-here": {
        mcpServers: { ghost: { command: "ghost-mcp" } },
      },
      // filled in per-test with the real project dir
    } as Record<string, unknown>,
  };
}

/**
 * Write the fixture with the real home substituted into its paths.
 *
 * The splice happens INSIDE a JSON document, so the home has to be inserted in
 * its JSON-ESCAPED form: on Windows the raw value is `C:\Users\…`, and every
 * backslash spliced in verbatim becomes an invalid escape ("Bad escaped
 * character in JSON") the moment JSON.parse reads it back. `JSON.stringify(home)
 * .slice(1, -1)` is the same string with its backslashes doubled and its quotes
 * left off — a valid JSON string BODY.
 */
async function writeGlobalState(extraProjects: Record<string, unknown> = {}) {
  const homeInJson = JSON.stringify(home).slice(1, -1);
  const raw = JSON.stringify(globalStateFixture()).split(HOME_PLACEHOLDER).join(homeInJson);
  const obj = JSON.parse(raw) as Record<string, unknown>;
  obj.projects = { ...(obj.projects as Record<string, unknown>), ...extraProjects };
  await fsp.writeFile(path.join(home, ".claude.json"), JSON.stringify(obj, null, 2), {
    mode: 0o600,
  });
}

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-mcp-"));
  home = path.join(tmpRoot, "home");
  toolHome = path.join(home, ".claude");
  await fsp.mkdir(toolHome, { recursive: true });
  warnings = [];
  debugs = [];
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* CAPTURE                                                                     */
/* -------------------------------------------------------------------------- */

describe("claude mcp capture: nothing but mcpServers leaves ~/.claude.json", () => {
  it("lifts user-scope servers and NOTHING else", async () => {
    await writeGlobalState();
    const result = await captureMcpServers(captureCtx());

    expect(Object.keys(result.mcpServers).sort()).toEqual(["playwright", "serena"]);

    // The security invariant: serialize everything we produced and prove the
    // account/telemetry payload is absent — value AND key name.
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(OAUTH_TOKEN);
    expect(blob).not.toContain(USER_ID);
    expect(blob).not.toContain("oauthAccount");
    expect(blob).not.toContain("emailAddress");
    expect(blob).not.toContain("numStartups");
    expect(blob).not.toContain("tipsHistory");
  });

  it("redacts env values and reports them as SecretRefs", async () => {
    await writeGlobalState();
    const result = await captureMcpServers(captureCtx());

    const serena = result.mcpServers.serena as Record<string, unknown>;
    expect((serena.env as Record<string, unknown>).SERENA_TOKEN).toBe("{{REDACTED}}");
    expect(JSON.stringify(result)).not.toContain(MCP_ENV_SECRET);

    expect(result.secrets.length).toBeGreaterThan(0);
    const ref = result.secrets.find((s) => s.source.includes("SERENA_TOKEN"));
    expect(ref).toBeDefined();
    expect(ref!.tool).toBe("claude");
    expect(ref!.kind).toBe("value");
    // Metadata only: a SecretRef never carries the value.
    expect(JSON.stringify(result.secrets)).not.toContain(MCP_ENV_SECRET);
  });

  it("folds absolute paths in command/args to placeholders", async () => {
    await writeGlobalState();
    const result = await captureMcpServers(captureCtx());

    const serena = result.mcpServers.serena as Record<string, unknown>;
    const args = serena.args as string[];
    expect(args[0]).toBe("{{HOME}}/.agents/bin/serena.sh");
    // Nothing that is STORED (manifest fields + secret metadata + warnings) may
    // carry the machine home.
    const { commandRefs, ...stored } = result;
    expect(JSON.stringify(stored)).not.toContain(home);
    // `commandRefs` is the ONE deliberately raw field: WP-B follows those paths
    // on THIS machine to capture the linked scripts, so it must keep the real
    // absolute path — it is never serialized into the repo. Asserted on the
    // PARSED structure, not `JSON.stringify`: on Windows the serialized JSON
    // escapes the path's backslashes (`C:\\Users\\…`), so a raw `home` string
    // (single backslashes) would never be found by `toContain` even though the
    // ref legitimately carries it.
    expect(
      commandRefs.some((r) => [r.command, ...(r.args ?? [])].some((v) => v.startsWith(home))),
    ).toBe(true);
  });

  it("carries env values verbatim when includeSecrets is ON", async () => {
    await writeGlobalState();
    const result = await captureMcpServers(captureCtx({ includeSecrets: true }));
    const serena = result.mcpServers.serena as Record<string, unknown>;
    expect((serena.env as Record<string, unknown>).SERENA_TOKEN).toBe(MCP_ENV_SECRET);
    // Templating still applies — portability is not a secrets decision.
    expect((serena.args as string[])[0]).toBe("{{HOME}}/.agents/bin/serena.sh");
  });

  it("keeps project-scope servers with a templated project path", async () => {
    const projectDir = path.join(home, "programming", "arbella");
    await fsp.mkdir(projectDir, { recursive: true });
    await writeGlobalState({ [projectDir]: { mcpServers: { local: { command: "x" } } } });

    const result = await captureMcpServers(captureCtx());
    // The project key came from `path.join`, so the templated tail keeps the
    // host's separators ("{{HOME}}\programming\arbella" on Windows). The FOLD is
    // what is under test, not the separator flavor — compare POSIX-normalized.
    const entry = result.projectMcpServers.find((e) =>
      toPosix(e.projectPath).endsWith("programming/arbella"),
    );
    expect(entry).toBeDefined();
    expect(toPosix(entry!.projectPath)).toBe("{{HOME}}/programming/arbella");
    expect(Object.keys(entry!.servers)).toEqual(["local"]);
    // A project with no servers at all is not carried; the fixture's ghost entry
    // HAS one, so it survives capture (restore is where existence is checked).
    expect(result.projectMcpServers.length).toBe(2);
  });

  it("returns empty (no throw) when ~/.claude.json is absent", async () => {
    const result = await captureMcpServers(captureCtx());
    expect(result.mcpServers).toEqual({});
    expect(result.projectMcpServers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("warns (and carries nothing) when ~/.claude.json is not valid JSON", async () => {
    await fsp.writeFile(path.join(home, ".claude.json"), "{ this is not json ");
    const result = await captureMcpServers(captureCtx());
    expect(result.mcpServers).toEqual({});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("could not parse");
  });
});

/* -------------------------------------------------------------------------- */
/* RESTORE                                                                     */
/* -------------------------------------------------------------------------- */

/** A manifest carrying one user server (with a redacted env) for restore tests. */
function manifestWith(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    ...emptyManifest("claude"),
    mcpServers: {
      serena: {
        command: "{{HOME}}/.agents/bin/serena.sh",
        env: { SERENA_TOKEN: "{{REDACTED}}" },
      },
    },
    ...overrides,
  };
}

async function readGlobalState(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(home, ".claude.json"), "utf8"));
}

describe("claude mcp restore: key-wise merge into ~/.claude.json", () => {
  it("creates the file with mode 0600 when it does not exist", async () => {
    await restoreMcpServers(restoreCtx(), manifestWith());

    // Windows has no POSIX mode bits (every file reads back 0o666), so only the
    // 0600 claim is host-specific; the creation itself is asserted everywhere.
    if (isPosixHost) {
      const stat = await fsp.stat(path.join(home, ".claude.json"));
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const obj = await readGlobalState();
    expect(Object.keys(obj)).toEqual(["mcpServers"]);
  });

  it("hydrates placeholders back to THIS machine's paths", async () => {
    await restoreMcpServers(restoreCtx(), manifestWith());
    const obj = await readGlobalState();
    const serena = (obj.mcpServers as Record<string, any>).serena;
    expect(serena.command).toBe(`${home}/.agents/bin/serena.sh`);
    expect(serena.command).not.toContain("{{HOME}}");
  });

  it("never touches the other keys of an existing file", async () => {
    await writeGlobalState();
    const before = await readGlobalState();

    await restoreMcpServers(restoreCtx(), manifestWith());

    const after = await readGlobalState();
    expect(after.userID).toBe(before.userID);
    expect(after.oauthAccount).toEqual(before.oauthAccount);
    expect(after.numStartups).toBe(before.numStartups);
    expect(after.tipsHistory).toEqual(before.tipsHistory);
  });

  it("keeps the local definition when sourceOfTruth is local", async () => {
    await writeGlobalState();
    await restoreMcpServers(restoreCtx({ sourceOfTruth: "local" }), manifestWith());

    const obj = await readGlobalState();
    // The fixture's serena has args + a redacted-on-capture env; the local entry
    // wins wholesale, so its args survive.
    expect((obj.mcpServers as Record<string, any>).serena.args).toBeDefined();
    // ...while a server that only exists in the repo IS added.
    expect((obj.mcpServers as Record<string, any>).playwright).toBeDefined();
  });

  it("overwrites the local definition when sourceOfTruth is repo", async () => {
    await writeGlobalState();
    await restoreMcpServers(restoreCtx({ sourceOfTruth: "repo" }), manifestWith());

    const obj = await readGlobalState();
    const serena = (obj.mcpServers as Record<string, any>).serena;
    expect(serena.args).toBeUndefined();
    expect(serena.command).toBe(`${home}/.agents/bin/serena.sh`);
  });

  it("refuses to overwrite a ~/.claude.json that is not valid JSON", async () => {
    const broken = "{ half a file";
    await fsp.writeFile(path.join(home, ".claude.json"), broken);

    await restoreMcpServers(restoreCtx(), manifestWith());

    expect(await fsp.readFile(path.join(home, ".claude.json"), "utf8")).toBe(broken);
    expect(warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
  });

  it("applies project servers only when the project dir exists here", async () => {
    const present = path.join(home, "programming", "arbella");
    await fsp.mkdir(present, { recursive: true });

    const manifest = manifestWith({
      projectMcpServers: [
        { projectPath: "{{HOME}}/programming/arbella", servers: { here: { command: "a" } } },
        { projectPath: "{{HOME}}/programming/gone", servers: { nope: { command: "b" } } },
      ],
    });
    await restoreMcpServers(restoreCtx(), manifest);

    const projects = (await readGlobalState()).projects as Record<string, any>;
    // The written key is the HYDRATED manifest path (`<home>/programming/…`,
    // "/"-separated because the stored template is), while `present` comes from
    // `path.join`. They name the same directory; compare separator-blind.
    expect(toPosixAll(Object.keys(projects))).toEqual([toPosix(present)]);
    const key = Object.keys(projects)[0]!;
    expect(projects[key].mcpServers.here).toEqual({ command: "a" });
    expect(debugs.some((d) => d.includes("does not exist here"))).toBe(true);
  });

  it("reuses the existing project key instead of duplicating it (path.join key vs '/' manifest path)", async () => {
    // The regression this guards: a pre-existing `projects` key written with
    // native separators (Claude Code's own `path.join`) must be REUSED, not
    // shadowed by a second, differently-spelled key for the same directory
    // once the manifest's "/"-joined path is hydrated onto this machine.
    const present = path.join(home, "programming", "arbella");
    await fsp.mkdir(present, { recursive: true });
    await writeGlobalState({ [present]: { mcpServers: { here: { command: "local-here" } } } });

    const manifest = manifestWith({
      projectMcpServers: [
        { projectPath: "{{HOME}}/programming/arbella", servers: { here: { command: "a" } } },
      ],
    });
    await restoreMcpServers(restoreCtx({ sourceOfTruth: "repo" }), manifest);

    const projects = (await readGlobalState()).projects as Record<string, any>;
    // The fixture's untouched "/tmp/does-not-exist-here" ghost project survives
    // alongside it; what matters is that `present` was never ALSO written under
    // a second, differently-spelled key for the same directory.
    expect(Object.keys(projects).sort()).toEqual(["/tmp/does-not-exist-here", present].sort());
    expect(projects[present].mcpServers.here).toEqual({ command: "a" });
  });

  it("warns once per redacted env key the user must re-supply", async () => {
    await restoreMcpServers(restoreCtx(), manifestWith());
    const line = warnings.find((w) => w.includes("SERENA_TOKEN"));
    expect(line).toBeDefined();
    expect(line).toContain("MCP server serena needs env SERENA_TOKEN re-supplied");
    expect(warnings.filter((w) => w.includes("SERENA_TOKEN"))).toHaveLength(1);
  });

  it("does NOT warn about a server whose local definition was kept", async () => {
    // The local entry still holds the real value; telling the user to re-supply
    // it would be wrong.
    await writeGlobalState();
    await restoreMcpServers(restoreCtx({ sourceOfTruth: "local" }), manifestWith());
    expect(warnings.filter((w) => w.includes("SERENA_TOKEN"))).toHaveLength(0);
  });

  it("does nothing at all when the manifest carries no MCP servers", async () => {
    await restoreMcpServers(restoreCtx(), emptyManifest("claude"));
    expect(await realFs.exists(path.join(home, ".claude.json"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Launch summaries (what a dry run actually tells you)                        */
/* -------------------------------------------------------------------------- */

describe("describeServerLaunch", () => {
  it("shows the command and its arguments for a spawned server", () => {
    expect(
      describeServerLaunch({ command: "/opt/bin/serena", args: ["start", "--stdio"] }),
    ).toBe("/opt/bin/serena start --stdio");
  });

  it("shows the URL for an http/sse server", () => {
    expect(describeServerLaunch({ type: "sse", url: "https://mcp.example.com/sse" })).toBe(
      "https://mcp.example.com/sse",
    );
    expect(describeServerLaunch({ type: "http", url: "https://mcp.example.com/x" })).toBe(
      "https://mcp.example.com/x",
    );
  });

  it("truncates a command line that would swamp the plan", () => {
    const summary = describeServerLaunch({ command: "x", args: ["y".repeat(400)] });
    expect(summary.length).toBe(MAX_LAUNCH_SUMMARY);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("returns nothing to show for a definition that names neither", () => {
    expect(describeServerLaunch({ type: "sse" })).toBe("");
  });
});

describe("claude mcp: reserved keys and atomic writes", () => {
  it("does not carry a server named __proto__ out of ~/.claude.json", async () => {
    // JSON.parse produces a real own "__proto__" property, and `out[name] = def`
    // on a plain object would then rewrite that object's PROTOTYPE instead of
    // adding a server. A written literal is required: an object literal in this
    // test file would set the prototype instead of creating the key.
    await fsp.writeFile(
      path.join(home, ".claude.json"),
      '{"mcpServers":{"__proto__":{"command":"evil","env":{"EVIL_TOKEN":"x"}},' +
        '"serena":{"command":"ok"}}}',
    );

    const captured = await captureMcpServers(captureCtx());

    expect(Object.keys(captured.mcpServers)).toEqual(["serena"]);
    expect(Object.getPrototypeOf(captured.mcpServers)).toBe(Object.prototype);
    // Nothing STORED carries it. (`commandRefs` is the deliberately raw field —
    // see the templating test above — and only ever names paths on THIS machine.)
    const { commandRefs, ...stored } = captured;
    void commandRefs;
    expect(JSON.stringify(stored)).not.toContain("evil");
    // The reserved key is not merely invisible in the output — it is never
    // PROCESSED. (Assigning it would silently rewrite the map's prototype, so
    // the missing key alone proves nothing; the missing SecretRef does.)
    expect(captured.secrets.map((ref) => ref.source)).toEqual([]);
  });

  it("does not register a server named __proto__ from a manifest", async () => {
    // The repo side of the same key: a hand-edited manifest must not be able to
    // put a reserved key into ~/.claude.json, nor pollute anything on the way.
    const manifest = {
      ...emptyManifest("claude"),
      ...(JSON.parse(
        '{"mcpServers":{"__proto__":{"command":"evil"},"ok":{"command":"c"}}}',
      ) as Partial<ToolManifest>),
    } as ToolManifest;

    const plan = await planMcpMerge(restoreCtx(), manifest);
    expect(plan.userServers.map((s) => s.name)).toEqual(["ok"]);

    await restoreMcpServers(restoreCtx(), manifest);

    const written = await readGlobalState();
    expect(Object.keys(written.mcpServers as object)).toEqual(["ok"]);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it("replaces ~/.claude.json atomically, leaving no temp sibling behind", async () => {
    // Claude Code reads this file continuously: a truncate-then-write exposes an
    // empty ~/.claude.json for the duration, and forever if the write dies. The
    // fs here REFUSES the truncating write, so this test fails the moment the
    // merge stops going through writeAtomic.
    await writeGlobalState();

    const noTruncate = {
      ...realFs,
      async write(): Promise<void> {
        throw new Error("~/.claude.json must be replaced atomically, not truncated");
      },
    };

    await restoreMcpServers(
      restoreCtx({ sourceOfTruth: "repo", fs: noTruncate }),
      manifestWith(),
    );

    const siblings = await fsp.readdir(home);
    expect(siblings.filter((n) => n.includes(".tmp"))).toEqual([]);

    // The content is exactly what a merge should produce — no truncation, no
    // partial JSON, other keys intact.
    const after = await readGlobalState();
    expect(after.numStartups).toBe(412);
    expect((after.mcpServers as Record<string, unknown>).serena).toEqual({
      command: `${home}/.agents/bin/serena.sh`,
      env: { SERENA_TOKEN: "{{REDACTED}}" },
    });
    const onDisk = await fsp.readFile(path.join(home, ".claude.json"), "utf8");
    expect(onDisk).toBe(JSON.stringify(after, null, 2) + "\n");
    // An existing file keeps its mode across the rename. (POSIX only: Windows
    // does not implement the bits, so there is nothing to carry.)
    if (isPosixHost) {
      expect((await fsp.stat(path.join(home, ".claude.json"))).mode & 0o777).toBe(0o600);
    }
  });
});

describe("claude mcp: dry-run planning", () => {
  /** The manifest used by every planning test: one user + two project servers. */
  function planningManifest() {
    return manifestWith({
      projectMcpServers: [
        { projectPath: "{{HOME}}/programming/arbella", servers: { here: { command: "a" } } },
        { projectPath: "{{HOME}}/programming/gone", servers: { nope: { command: "b" } } },
      ],
    });
  }

  it("plans one action per server, skipping absent project dirs", async () => {
    const present = path.join(home, "programming", "arbella");
    await fsp.mkdir(present, { recursive: true });

    const { actions } = await planMcpMerge(restoreCtx(), planningManifest());

    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.type === "register-mcp-server")).toBe(true);
    // The description names WHAT will be launched: a dry run whose only line is
    // "Register MCP server serena" hides the command a repo just talked this
    // machine into running.
    //
    // Descriptions embed HYDRATED paths, whose separator flavor follows the
    // stored template ("/") while `present` follows `path.join` — so both sides
    // are POSIX-normalized before comparing.
    expect(toPosix(actions[0]!.description)).toBe(
      `Register MCP server serena (user scope): ${toPosix(home)}/.agents/bin/serena.sh`,
    );
    expect(toPosix(actions[0]!.targetPath!)).toBe(toPosix(path.join(home, ".claude.json")));
    expect(toPosix(actions[1]!.description)).toBe(
      `Register MCP server here for ${toPosix(present)}: a`,
    );
    // Planning is side-effect free: no file was created.
    expect(await realFs.exists(path.join(home, ".claude.json"))).toBe(false);
  });

  // THE regression this function exists for: the plan used to list every server
  // in the manifest while the merge kept the local one whenever sourceOfTruth
  // said so — a dry run promising registrations that never happened, and a
  // post-restore reminder pointing at warnings that were never printed.
  it("plans NOTHING for servers the merge would keep local", async () => {
    const present = path.join(home, "programming", "arbella");
    await fsp.mkdir(present, { recursive: true });
    // Both scopes already hold the same server names locally.
    await writeGlobalState({
      [present]: { mcpServers: { here: { command: "local-here" } } },
    });

    const ctx = restoreCtx({ sourceOfTruth: "local" });
    const plan = await planMcpMerge(ctx, planningManifest());

    expect(plan.actions).toEqual([]);
    expect(plan.needsEnv).toEqual([]);
    expect(plan.userServers).toEqual([]);
    expect(plan.projectServers).toEqual([]);

    // ...and the merge that follows agrees: the file is left byte-for-byte alone.
    const before = await fsp.readFile(path.join(home, ".claude.json"), "utf8");
    await restoreMcpServers(ctx, planningManifest());
    expect(await fsp.readFile(path.join(home, ".claude.json"), "utf8")).toBe(before);
    expect(warnings.filter((w) => w.includes("SERENA_TOKEN"))).toHaveLength(0);
  });

  it("plans the registration AND the redacted env keys when the repo wins", async () => {
    const present = path.join(home, "programming", "arbella");
    await fsp.mkdir(present, { recursive: true });
    await writeGlobalState({
      [present]: { mcpServers: { here: { command: "local-here" } } },
    });

    const plan = await planMcpMerge(restoreCtx({ sourceOfTruth: "repo" }), planningManifest());

    expect(plan.actions.map((a) => toPosix(a.description))).toEqual([
      `Register MCP server serena (user scope): ${toPosix(home)}/.agents/bin/serena.sh`,
      `Register MCP server here for ${toPosix(present)}: a`,
      // playwright lives in the fixture only, not in the manifest.
    ]);
    expect(plan.needsEnv).toEqual([{ name: "serena", key: "SERENA_TOKEN" }]);
    expect(plan.existed).toBe(true);
    expect(plan.invalid).toBe(false);
  });

  it("plans a fresh registration for a server only the repo has (sourceOfTruth=local)", async () => {
    // local wins only where a LOCAL definition exists; an unknown server is new.
    await writeGlobalState();
    const manifest = manifestWith({
      mcpServers: { brandnew: { command: "{{HOME}}/.local/bin/new-mcp" } },
    });

    const plan = await planMcpMerge(restoreCtx({ sourceOfTruth: "local" }), manifest);

    expect(plan.actions.map((a) => a.description)).toEqual([
      `Register MCP server brandnew (user scope): ${home}/.local/bin/new-mcp`,
    ]);
    expect(plan.needsEnv).toEqual([]);
  });

  it("plans nothing at all when ~/.claude.json is not valid JSON", async () => {
    // The merge refuses to touch the file, so the dry run must not advertise
    // registrations either.
    await fsp.writeFile(path.join(home, ".claude.json"), "{ half a file");

    const plan = await planMcpMerge(restoreCtx(), planningManifest());

    expect(plan.invalid).toBe(true);
    expect(plan.actions).toEqual([]);
    expect(plan.needsEnv).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Visibility: project MCP servers skipped for a directory that doesn't exist  */
/* -------------------------------------------------------------------------- */

describe("claude mcp: skipped project MCP servers are reported, not silently dropped", () => {
  /** One project whose dir will be created per-test, one that never is. */
  function planningManifest() {
    return manifestWith({
      projectMcpServers: [
        { projectPath: "{{HOME}}/programming/arbella", servers: { here: { command: "a" } } },
        { projectPath: "{{HOME}}/programming/gone", servers: { nope: { command: "b" } } },
      ],
    });
  }

  it("plan.skippedProjectDirs names only the directory that does not exist here", async () => {
    const present = path.join(home, "programming", "arbella");
    await fsp.mkdir(present, { recursive: true });
    const gone = path.join(home, "programming", "gone");

    const plan = await planMcpMerge(restoreCtx(), planningManifest());

    expect(toPosixAll(plan.skippedProjectDirs)).toEqual([toPosix(gone)]);
    // The existing project is still planned normally.
    expect(plan.projectServers.map((p) => toPosix(p.dir))).toEqual([toPosix(present)]);
  });

  it("plan.skippedProjectDirs is empty when every project directory exists here", async () => {
    await fsp.mkdir(path.join(home, "programming", "arbella"), { recursive: true });
    await fsp.mkdir(path.join(home, "programming", "gone"), { recursive: true });

    const plan = await planMcpMerge(restoreCtx(), planningManifest());

    expect(plan.skippedProjectDirs).toEqual([]);
  });

  it("planMcpMerge emits no warning for a skipped project (the command owns the message now)", async () => {
    // planMcpMerge is a pure decision function now — the one-line "clone the
    // project and pull again" warning is printed by src/commands/restore.ts
    // from plan.skippedProjectDirs, not from here.
    const present = path.join(home, "programming", "arbella");
    await fsp.mkdir(present, { recursive: true });

    const plan = await planMcpMerge(restoreCtx(), planningManifest());

    expect(plan.skippedProjectDirs.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* findProjectKey (pure — the fix for cross-platform project-key drift)        */
/* -------------------------------------------------------------------------- */

describe("findProjectKey: matches an existing project key regardless of separator flavor", () => {
  it("finds a path.join-built key from a '/'-joined hydrated path (default normalizer)", () => {
    // The stored template is always "/"-joined; on POSIX this is byte-identical
    // to a path.join key, and on an actual Windows host the default normalizer
    // (path.normalize) folds both to the same native form — this is exactly the
    // comparison planProjectScope performs.
    const dir = path.join("tmp-root", "home", "programming", "arbella");
    const hydrated = "tmp-root/home/programming/arbella";
    expect(findProjectKey({ [dir]: {} }, hydrated)).toBe(dir);
  });

  it("returns undefined when no key names the same directory", () => {
    expect(findProjectKey({ "/tmp/other": {} }, "/tmp/programming/arbella")).toBeUndefined();
  });

  // THE regression this helper exists for: on Windows, hydrating
  // "{{HOME}}/programming/arbella" by splicing a native-backslash $HOME into a
  // "/"-joined template tail produces a MIXED-separator string that never
  // `===`s the native-backslash key Claude Code wrote via `path.join` — even
  // though both name the same directory. Exercised with `path.win32.normalize`
  // (an injected normalizer) so this proves the fix on every host, including
  // this POSIX CI runner.
  it("matches a native win32 key against a mixed-separator hydrated path", () => {
    const projects = { "C:\\Users\\runner\\programming\\arbella": {} };
    const hydrated = "C:\\Users\\runner/programming/arbella";
    expect(findProjectKey(projects, hydrated, path.win32.normalize)).toBe(
      "C:\\Users\\runner\\programming\\arbella",
    );
  });

  it("does not fold two genuinely different win32 directories together", () => {
    const projects = { "C:\\Users\\runner\\programming\\arbella": {} };
    const hydrated = "C:\\Users\\runner\\programming\\other-repo";
    expect(findProjectKey(projects, hydrated, path.win32.normalize)).toBeUndefined();
  });
});
