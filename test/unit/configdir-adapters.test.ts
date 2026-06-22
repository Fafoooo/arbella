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
    expect(restored).toContain(`${dstHome}/.config/opencode/AGENTS.md`);
    expect(restored).not.toContain(srcHome);
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
