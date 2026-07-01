/**
 * Unit tests for the config-dir adapters (opencode, copilot, kilo) and their
 * shared capture/restore engine.
 *
 * What these prove against a real temp dir (hermetic, offline):
 *   - SECRET SAFETY: an MCP env API key inside the config file is redacted; the
 *     secret value never reaches the captured output, and a SecretRef is reported.
 *   - DENYLIST: plugin-install artifacts (node_modules/, package.json, bun.lock)
 *     and the reinstallable skills/ tree are excluded wholesale.
 *   - PLACEHOLDERS: a machine path under the config home folds to {{HOME}} on
 *     capture and expands back on restore into a FRESH home.
 *   - GRACEFUL ABSENCE: capturing a missing config home yields an empty result
 *     with a single warning, never a throw.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { capture as captureOpencode, restore as restoreOpencode } from "../../src/adapters/opencode/index.js";
import { capture as captureCopilot } from "../../src/adapters/copilot/index.js";
import { capture as captureKilo } from "../../src/adapters/kilo/index.js";

import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import type { CaptureResult, EnvVars, TemplateVariables } from "../../src/types.js";
import type { CaptureContext, RestoreContext, RestoreData } from "../../src/adapters/adapter.interface.js";

const OPENCODE_MCP_SECRET = "sk-ant-api03-OPENCODE-MCP-SECRET-AAAAAAAAAAAA";

const silentLog = {
  info() {},
  success() {},
  warn() {},
  error() {},
  step() {},
  debug() {},
};

const sanitizer = createSanitizer();
const templater = createTemplater();

function makeCaptureCtx(toolHome: string, vars: TemplateVariables, env: EnvVars = {}): CaptureContext {
  return {
    fs: realFs,
    log: silentLog,
    sanitizer,
    templater,
    vars,
    os: "linux",
    env,
    toolHome,
    includeSecrets: false,
    includeMemories: false,
    dryRun: false,
  };
}

function makeRestoreCtx(toolHome: string, vars: TemplateVariables): RestoreContext {
  return {
    fs: realFs,
    log: silentLog,
    sanitizer,
    templater,
    vars,
    os: "linux",
    env: {},
    toolHome,
    repoToolDir: "",
    repoRoot: "",
    sourceOfTruth: "repo",
    dryRun: false,
  };
}

function under(home: string, rel: string): string {
  return path.join(home, ...rel.split("/"));
}

async function writeFile(home: string, rel: string, content: string) {
  const abs = under(home, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

let tmpRoot: string;
let srcHome: string;
let dstHome: string;
let opencodeCapture: CaptureResult;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-cfgdir-"));
  srcHome = path.join(tmpRoot, "src-home");
  dstHome = path.join(tmpRoot, "dst-home");

  const opencodeSrc = path.join(srcHome, ".config", "opencode");

  // opencode.json: declares a plugin (portable) and an MCP server with a secret
  // env value (must be redacted), plus a machine path (must be templated).
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: ["superpowers@git+https://github.com/obra/superpowers.git"],
    // One path UNDER the tool home (folds to {{TOOL_HOME}}) and one under HOME but
    // OUTSIDE the tool home (folds to {{HOME}}).
    instructions: [`${srcHome}/.config/opencode/AGENTS.md`, `${srcHome}/.agents/shared.md`],
    mcp: {
      weather: {
        type: "local",
        command: ["npx", "weather"],
        environment: { ANTHROPIC_API_KEY: OPENCODE_MCP_SECRET },
      },
    },
  };
  await writeFile(opencodeSrc, "opencode.json", JSON.stringify(config, null, 2));
  await writeFile(opencodeSrc, "agents/reviewer.md", "# Reviewer\nA custom agent.\n");

  // Denylisted plugin-install artifacts + skills tree — must NOT be captured.
  await writeFile(opencodeSrc, "package.json", '{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}');
  await writeFile(opencodeSrc, "bun.lock", "lockfile");
  await writeFile(opencodeSrc, "node_modules/dep/index.js", "module.exports = 1;");
  await writeFile(opencodeSrc, "skills/humanizer/SKILL.md", "# skill");

  const vars = makeVariables(srcHome, "fab", "linux", opencodeSrc);
  opencodeCapture = await captureOpencode(makeCaptureCtx(opencodeSrc, vars));
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("opencode adapter capture", () => {
  it("captures the config + agents but excludes plugin artifacts and skills", () => {
    const repoPaths = opencodeCapture.files.map((f) => f.repoPath).sort();
    expect(repoPaths).toContain("opencode/files/opencode.json");
    expect(repoPaths).toContain("opencode/files/agents/reviewer.md");
    expect(repoPaths.some((p) => p.includes("package.json"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("bun.lock"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("skills/"))).toBe(false);
  });

  it("redacts the MCP env secret and reports a SecretRef", () => {
    const cfg = opencodeCapture.files.find((f) => f.repoPath === "opencode/files/opencode.json");
    expect(cfg).toBeDefined();
    expect(cfg!.content).not.toContain(OPENCODE_MCP_SECRET);
    expect(opencodeCapture.secrets.length).toBeGreaterThan(0);
  });

  it("folds machine paths to {{HOME}} / {{TOOL_HOME}} placeholders", () => {
    const cfg = opencodeCapture.files.find((f) => f.repoPath === "opencode/files/opencode.json");
    expect(cfg!.content).not.toContain(srcHome);
    expect(cfg!.content).toContain("{{HOME}}");
    expect(cfg!.content).toContain("{{TOOL_HOME}}");
  });

  it("preserves the portable plugin declaration", () => {
    const cfg = opencodeCapture.files.find((f) => f.repoPath === "opencode/files/opencode.json");
    expect(cfg!.content).toContain("superpowers@git+https://github.com/obra/superpowers.git");
  });
});

describe("opencode adapter restore (round-trip into a fresh home)", () => {
  it("writes the frozen files back with {{HOME}} expanded to the target", async () => {
    const dstTool = path.join(dstHome, ".config", "opencode");
    const vars = makeVariables(dstHome, "newuser", "linux", dstTool);
    const data: RestoreData = {
      manifest: opencodeCapture.manifest,
      files: opencodeCapture.files,
      symlinks: opencodeCapture.symlinks,
    };
    await restoreOpencode(makeRestoreCtx(dstTool, vars), data);

    const restored = await fsp.readFile(under(dstTool, "opencode.json"), "utf8");
    // Compare separator-agnostically: on Windows the rehydrated machine path uses
    // native backslashes, so normalize both sides to POSIX before asserting.
    const toPosix = (s: string) => s.replace(/\\/g, "/");
    expect(toPosix(restored)).toContain(`${toPosix(dstHome)}/.config/opencode/AGENTS.md`);
    expect(toPosix(restored)).not.toContain(toPosix(srcHome));
    // The redacted secret stays redacted after restore (it was never captured).
    expect(restored).not.toContain(OPENCODE_MCP_SECRET);

    const agent = await fsp.readFile(under(dstTool, "agents/reviewer.md"), "utf8");
    expect(agent).toContain("A custom agent.");
  });
});

describe("config-dir adapters: graceful absence", () => {
  it("copilot capture of a missing home returns an empty result with a warning", async () => {
    const missing = path.join(tmpRoot, "nope", ".copilot");
    const vars = makeVariables(tmpRoot, "fab", "linux", missing);
    const result = await captureCopilot(makeCaptureCtx(missing, vars));
    expect(result.tool).toBe("copilot");
    expect(result.files).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("kilo capture of a missing home returns an empty result with a warning", async () => {
    const missing = path.join(tmpRoot, "nope", ".config", "kilo");
    const vars = makeVariables(tmpRoot, "fab", "linux", missing);
    const result = await captureKilo(makeCaptureCtx(missing, vars));
    expect(result.tool).toBe("kilo");
    expect(result.files).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("copilot adapter capture: user config in, auth state out", () => {
  // GitHub's config-dir reference: user prefs live in settings.json; config.json is
  // auto-managed state holding authentication data + plugin metadata. Regression
  // guard for the P1 fix — config.json (and its token) must never be captured.
  let cpTmp: string;
  let cpHome: string;
  let cpCapture: CaptureResult;
  // Built at runtime so the token-shaped fixture never trips secret scanners.
  const COPILOT_TOKEN = ["ghu", "COPILOTinternalStateAuthToken000000000000"].join("_");

  beforeAll(async () => {
    cpTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-copilot-"));
    cpHome = path.join(cpTmp, ".copilot");

    // Portable, user-authored config (must be captured).
    await writeFile(cpHome, "settings.json", JSON.stringify({ theme: "dark", model: "gpt-5" }, null, 2));
    await writeFile(cpHome, "mcp-config.json", JSON.stringify({ mcpServers: {} }, null, 2));
    await writeFile(cpHome, "lsp-config.json", JSON.stringify({ servers: {} }, null, 2));
    await writeFile(cpHome, "copilot-instructions.md", "# My instructions\n");
    await writeFile(cpHome, "instructions/style.instructions.md", "Be terse.\n");
    await writeFile(cpHome, "agents/reviewer.md", "# Reviewer\n");

    // Auto-managed internal state holding AUTH DATA — must NEVER be captured.
    await writeFile(
      cpHome,
      "config.json",
      JSON.stringify({ loggedInUsers: [{ token: COPILOT_TOKEN }] }, null, 2),
    );
    // Other machine-local state (denylisted).
    await writeFile(cpHome, "session-state/abc/events.jsonl", "{}\n");
    await writeFile(cpHome, "logs/process.log", "log line\n");

    const vars = makeVariables(cpTmp, "fab", "linux", cpHome);
    cpCapture = await captureCopilot(makeCaptureCtx(cpHome, vars));
  });

  afterAll(async () => {
    await fsp.rm(cpTmp, { recursive: true, force: true });
  });

  it("captures the user-authored config files", () => {
    const repoPaths = cpCapture.files.map((f) => f.repoPath);
    expect(repoPaths).toContain("copilot/files/settings.json");
    expect(repoPaths).toContain("copilot/files/mcp-config.json");
    expect(repoPaths).toContain("copilot/files/lsp-config.json");
    expect(repoPaths).toContain("copilot/files/copilot-instructions.md");
    expect(repoPaths).toContain("copilot/files/instructions/style.instructions.md");
    expect(repoPaths).toContain("copilot/files/agents/reviewer.md");
  });

  it("never captures config.json (auth/internal state) nor its token", () => {
    const repoPaths = cpCapture.files.map((f) => f.repoPath);
    expect(repoPaths).not.toContain("copilot/files/config.json");
    for (const f of cpCapture.files) {
      const content = f.binary ? Buffer.from(f.content, "base64").toString("utf8") : f.content;
      expect(content).not.toContain(COPILOT_TOKEN);
    }
  });

  it("excludes machine-local session/log state", () => {
    const repoPaths = cpCapture.files.map((f) => f.repoPath);
    expect(repoPaths.some((p) => p.includes("session-state"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("logs/"))).toBe(false);
  });
});

describe("kilo adapter capture: includes TUI config", () => {
  // Regression guard for the P2 fix — Kilo stores terminal attention/notification/
  // sound behavior in tui.json(c); it must round-trip alongside kilo.jsonc.
  let kTmp: string;
  let kHome: string;
  let kCapture: CaptureResult;

  beforeAll(async () => {
    kTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-kilo-"));
    kHome = path.join(kTmp, ".config", "kilo");
    await writeFile(kHome, "kilo.jsonc", '{ "model": "sonnet" }\n');
    await writeFile(kHome, "tui.json", JSON.stringify({ notifications: true, sound: false }, null, 2));
    await writeFile(kHome, "rules/global.md", "Be careful.\n");

    const vars = makeVariables(kTmp, "fab", "linux", kHome);
    kCapture = await captureKilo(makeCaptureCtx(kHome, vars));
  });

  afterAll(async () => {
    await fsp.rm(kTmp, { recursive: true, force: true });
  });

  it("captures tui.json (terminal UI settings) alongside the config", () => {
    const repoPaths = kCapture.files.map((f) => f.repoPath);
    expect(repoPaths).toContain("kilo/files/tui.json");
    expect(repoPaths).toContain("kilo/files/kilo.jsonc");
    expect(repoPaths).toContain("kilo/files/rules/global.md");
  });
});

describe("config-dir capture: UTF-16 configs are sanitized, not shipped raw", () => {
  // A NUL byte must NOT route a secret-bearing config around the sanitizer.
  // UTF-16LE (the default of PowerShell's Out-File / Set-Content on Windows) puts
  // a 0x00 after every ASCII char, which the old "contains NUL => binary"
  // heuristic misread as binary and base64'd verbatim. Regression guard for the
  // security review's HIGH finding.
  let u16Tmp: string;
  let u16Capture: CaptureResult;
  const U16_SECRET = "sk-ant-api03-UTF16-CONFIG-MCP-SECRET-BBBBBBBBBBBB";

  beforeAll(async () => {
    u16Tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-u16-"));
    const u16Home = path.join(u16Tmp, ".config", "opencode");
    const cfg = JSON.stringify(
      { mcp: { weather: { environment: { ANTHROPIC_API_KEY: U16_SECRET } } } },
      null,
      2,
    );
    // Write as UTF-16LE with NO BOM — the NUL-interleave heuristic must still
    // catch it. This is the byte shape PowerShell's Out-File / Set-Content
    // produce on Windows, and the exact case the old heuristic misread as binary.
    const abs = under(u16Home, "opencode.json");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.from(cfg, "utf16le"));

    const vars = makeVariables(u16Tmp, "fab", "linux", u16Home);
    u16Capture = await captureOpencode(makeCaptureCtx(u16Home, vars));
  });

  afterAll(async () => {
    await fsp.rm(u16Tmp, { recursive: true, force: true });
  });

  it("captures the UTF-16 config as sanitized TEXT (not opaque base64)", () => {
    const cfg = u16Capture.files.find((f) => f.repoPath === "opencode/files/opencode.json");
    expect(cfg).toBeDefined();
    expect(cfg!.binary).toBeFalsy();
    expect(cfg!.content).not.toContain(U16_SECRET);
    expect(u16Capture.secrets.length).toBeGreaterThan(0);
  });

  it("leaks the secret into NO captured file (text or base64)", () => {
    for (const f of u16Capture.files) {
      if (f.binary) {
        // Check both decodings: a UTF-16LE secret inside a base64 payload would
        // be invisible to a UTF-8-only scan (s\0k\0-\0...).
        const bytes = Buffer.from(f.content, "base64");
        expect(bytes.toString("utf8")).not.toContain(U16_SECRET);
        expect(bytes.toString("utf16le")).not.toContain(U16_SECRET);
      } else {
        expect(f.content).not.toContain(U16_SECRET);
      }
    }
  });
});
