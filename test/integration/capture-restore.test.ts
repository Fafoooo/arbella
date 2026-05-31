/**
 * Integration test: capture a fake $HOME (~/.claude + ~/.codex) into an in-repo
 * tree, then restore it into a FRESH fake $HOME.
 *
 * What this proves end-to-end:
 *   - SECRET SAFETY: a fake ~/.claude/.credentials.json and ~/.codex/auth.json
 *     (and an API key inside settings.json / config.toml) are NEVER present in
 *     the captured output. The whole-file secrets are excluded; the inline key is
 *     redacted to {{REDACTED}}.
 *   - PLACEHOLDERS: machine paths in settings.json / config.toml are folded to
 *     {{HOME}} on capture.
 *   - SHARED INSTRUCTIONS (R9): byte-identical CLAUDE.md / AGENTS.md are stored
 *     ONCE under shared/instructions.md; the per-tool copies are NOT emitted.
 *   - RESTORE: into a clean home, every frozen file reappears with {{HOME}}
 *     expanded back to the target machine's home, and the shared instructions
 *     deploy to BOTH ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md. No secret files
 *     are recreated (they were never captured).
 *
 * npm/CLI shell-outs are mocked away so the test is hermetic, fast, and offline.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

// Hermetic: no real `npm` / `which` / install shell-outs from the adapters.
vi.mock("../../src/platform/install.js", () => ({
  listNpmGlobals: async () => [],
  which: async () => false,
  npmInstallGlobal: async () => undefined,
  isCliInstalled: async () => false,
  installCli: async () => undefined,
  ensureCli: async () => undefined,
  runInstall: async () => undefined,
}));

import { capture as captureClaude } from "../../src/adapters/claude/capture.js";
import { restore as restoreClaude } from "../../src/adapters/claude/restore.js";
import { capture as captureCodex } from "../../src/adapters/codex/capture.js";
import { restore as restoreCodex } from "../../src/adapters/codex/restore.js";
import {
  capture as captureCursor,
  restore as restoreCursor,
  planActions as planCursorActions,
} from "../../src/adapters/cursor/index.js";

import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { loadRestoreData } from "../../src/commands/restore.js";
import {
  shouldShareInstructions,
  buildSharedInstructionsFile,
  SHARED_INSTRUCTIONS_REPO_PATH,
} from "../../src/core/manifest/index.js";
import type {
  CaptureResult,
  CapturedFile,
  EnvVars,
  TemplateVariables,
} from "../../src/types.js";
import type {
  CaptureContext,
  RestoreContext,
  RestoreData,
} from "../../src/adapters/adapter.interface.js";

/* -------------------------------------------------------------------------- */
/* Secret sentinels — these strings must NEVER appear in captured output.      */
/* -------------------------------------------------------------------------- */

const CLAUDE_CRED_SECRET = "sk-ant-cred-DO-NOT-LEAK-AAAAAAAAAAAAAAAAAAAAAA";
const CODEX_AUTH_SECRET = "OPENAI_AUTH_TOKEN_DO_NOT_LEAK_BBBBBBBBBBBBBBB";
const SETTINGS_API_KEY = "sk-ant-api03-INLINE-KEY-CCCCCCCCCCCCCCCCCCCCCCCC";
const CONFIG_MCP_SECRET = "glpat-CONFIG-MCP-SECRET-DDDDDDDDDDDDD";
const CURSOR_MCP_SECRET = "sk-ant-api03-CURSOR-MCP-SECRET-HHHHHHHHHHHHH";
// OPAQUE value under a secret KEY NAME — matches NO known token pattern. Proves
// the STRUCTURAL key-name-aware capture path (sanitizeFile) redacts it; the old
// value-only sanitizeText path would have leaked it verbatim into the repo.
const SETTINGS_OPAQUE_SECRET = "corp-gateway-OPAQUE-EEEEEEEE-no-known-prefix";

/** Shared instructions content (identical in CLAUDE.md and AGENTS.md). */
const SHARED_MD = "# Global AI instructions\n\n- Be concise.\n- Prefer absolute paths.\n";

/* -------------------------------------------------------------------------- */
/* Logger / context helpers                                                     */
/* -------------------------------------------------------------------------- */

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

function makeRestoreCtx(
  toolHome: string,
  repoToolDir: string,
  repoRoot: string,
  vars: TemplateVariables,
  env: EnvVars = {},
): RestoreContext {
  return {
    fs: realFs,
    log: silentLog,
    sanitizer,
    templater,
    vars,
    os: "linux",
    env,
    toolHome,
    repoToolDir,
    repoRoot,
    sourceOfTruth: "repo", // repo wins -> allowed to write into the fresh home
    dryRun: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Fixture construction                                                         */
/* -------------------------------------------------------------------------- */

let tmpRoot: string;
let srcHome: string; // the fake source $HOME
let dstHome: string; // the fresh target $HOME
let repoRoot: string; // the backup repo working tree

let claudeCapture: CaptureResult;
let codexCapture: CaptureResult;
let cursorCapture: CaptureResult;
let sharedFile: CapturedFile;

/** Absolute, OS-correct path under a tool home from a POSIX-ish rel path. */
function under(home: string, rel: string): string {
  return path.join(home, ...rel.split("/"));
}

async function writeFile(home: string, rel: string, content: string, mode?: number) {
  const abs = under(home, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, mode !== undefined ? { mode } : undefined);
}

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-it-"));
  srcHome = path.join(tmpRoot, "src-home");
  dstHome = path.join(tmpRoot, "dst-home");
  repoRoot = path.join(tmpRoot, "repo");

	  const claudeSrc = path.join(srcHome, ".claude");
	  const codexSrc = path.join(srcHome, ".codex");
	  const cursorSrc = path.join(srcHome, ".cursor");

  // ---- ~/.claude ----
  // settings.json: an inline API key (redact) + two machine paths to template:
  //   - statusLine.command lives UNDER the tool home  -> folds to {{TOOL_HOME}}
  //   - sharedDir lives under HOME but OUTSIDE the tool -> folds to {{HOME}}
  const settings = {
    model: "claude-sonnet",
    statusLine: { command: `${srcHome}/.claude/statusline/run.sh` },
    sharedDir: `${srcHome}/.agents/skills`,
    mcpServers: {
      weather: {
        command: "npx",
        env: {
          // A pattern-matchable key (redacted by value pattern + key name)...
          ANTHROPIC_API_KEY: SETTINGS_API_KEY,
          // ...and an OPAQUE value whose KEY NAME is the only secret signal. Only
          // the structural sanitizeFile path catches this.
          ANTHROPIC_AUTH_TOKEN: SETTINGS_OPAQUE_SECRET,
        },
      },
    },
  };
  await writeFile(claudeSrc, "settings.json", JSON.stringify(settings, null, 2));
  // Identical instructions in both tools (R9 shared).
  await writeFile(claudeSrc, "CLAUDE.md", SHARED_MD);
  // A real agent file referencing BOTH a tool-home path and a plain-home path.
  await writeFile(
    claudeSrc,
    "agents/reviewer.md",
    `Reviewer agent. Logs to ${srcHome}/.claude/agents/reviewer.log ` +
      `and reads ${srcHome}/.agents/shared.md\n`,
  );
  // FAKE SECRET FILE — must be excluded wholesale; content must never surface.
  await writeFile(
    claudeSrc,
    ".credentials.json",
    JSON.stringify({ token: CLAUDE_CRED_SECRET }),
    0o600,
  );
  // A denylisted DB sidecar to prove COMMON_DENY exclusion too.
  await writeFile(claudeSrc, "telemetry.sqlite", "binary-ish-db-bytes");

  // ---- ~/.codex ----
  const configToml = [
    "model = \"o4\"",
    // A path under HOME but outside the tool home -> {{HOME}}.
    `notify = \"${srcHome}/.agents/notify.sh\"`,
    "",
    "[mcp_servers.search]",
    "command = \"node\"",
    // A path under the tool home -> {{TOOL_HOME}}.
    `args = [\"${srcHome}/.codex/mcp/search.js\"]`,
    "",
    "[mcp_servers.search.env]",
    `API_KEY = \"${CONFIG_MCP_SECRET}\"`,
    "",
  ].join("\n");
  await writeFile(codexSrc, "config.toml", configToml);
  // Byte-identical to CLAUDE.md.
  await writeFile(codexSrc, "AGENTS.md", SHARED_MD);
	  await writeFile(codexSrc, "prompts/review.md", "Review prompt body.\n");
	  // FAKE SECRET FILE — excluded wholesale.
	  await writeFile(codexSrc, "auth.json", `{"token":"${CODEX_AUTH_SECRET}"}`, 0o600);

	  // ---- ~/.cursor + Cursor app user data ----
	  await writeFile(
	    cursorSrc,
	    "mcp.json",
	    JSON.stringify(
	      {
	        mcpServers: {
	          figma: {
	            command: "node",
	            args: [`${srcHome}/.cursor/mcp/figma.js`],
	            env: {
	              ANTHROPIC_API_KEY: CURSOR_MCP_SECRET,
	            },
	          },
	        },
	      },
	      null,
	      2,
	    ),
	  );
	  await writeFile(
	    cursorSrc,
	    "skills/local/SKILL.md",
	    `# Local Cursor skill\n\nReads ${srcHome}/.cursor/skills/local/data.json\n`,
	  );
	  await writeFile(cursorSrc, "extensions/extensions.json", JSON.stringify([
	    {
	      identifier: { id: "anysphere.cursorpyright" },
	      version: "1.2.3",
	    },
	  ]));
	  const cursorSkillLink = under(cursorSrc, "skills/humanizer");
	  await fsp.mkdir(path.dirname(cursorSkillLink), { recursive: true });
	  await fsp.symlink("../../.agents/skills/humanizer", cursorSkillLink);
	  const cursorUserDir = path.join(srcHome, ".config", "Cursor", "User");
	  await writeFile(
	    cursorUserDir,
	    "settings.json",
	    JSON.stringify({ "terminal.integrated.cwd": `${srcHome}/programming` }, null, 2),
	  );
	  await writeFile(
	    cursorUserDir,
	    "keybindings.json",
	    JSON.stringify([{ key: "cmd+k", command: "cursorai.action.generate" }], null, 2),
	  );
	  await writeFile(
	    cursorUserDir,
	    "snippets/typescript.json",
	    JSON.stringify({ log: { prefix: "cl", body: [`console.log('${srcHome}')`] } }, null, 2),
	  );
	  await writeFile(cursorUserDir, "snippets/cache.sqlite", "sqlite cache should be ignored\n");

  // ---- Capture orchestration (mirrors the backup command's R9 wiring) ----
	  const claudeVars = makeVariables(srcHome, "fab", "linux", claudeSrc);
	  const codexVars = makeVariables(srcHome, "fab", "linux", codexSrc);
	  const cursorVars = makeVariables(srcHome, "fab", "linux", cursorSrc);

  const claudeMd = SHARED_MD;
  const agentsMd = SHARED_MD;
  const share = shouldShareInstructions(claudeMd, agentsMd);
  expect(share).toBe(true); // identical -> dedupe path is exercised

  claudeCapture = await captureClaude(makeCaptureCtx(claudeSrc, claudeVars), {
    skipInstructions: share,
  });
	  codexCapture = await captureCodex(makeCaptureCtx(codexSrc, codexVars), {
	    skipInstructions: share,
	  });
	  cursorCapture = await captureCursor(makeCaptureCtx(cursorSrc, cursorVars), {
	    skipInstructions: share,
	  });
	  sharedFile = buildSharedInstructionsFile(SHARED_MD);
});

afterAll(async () => {
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Helpers over the captured output                                             */
/* -------------------------------------------------------------------------- */

/** Concatenate every captured file's content + repoPath across all tools + shared. */
function allCapturedText(): string {
  const parts: string[] = [];
  for (const f of [...claudeCapture.files, ...codexCapture.files, ...cursorCapture.files, sharedFile]) {
    parts.push(f.repoPath, f.content);
  }
  return parts.join("\n");
}

function findFile(files: CapturedFile[], repoPath: string): CapturedFile | undefined {
  return files.find((f) => f.repoPath === repoPath);
}

/**
 * A few assertions below check machine paths INSIDE captured/restored file
 * content (settings.json / config.toml / agent files). The fixtures pin the
 * templater to POSIX (os: "linux") and embed "/"-style paths, so on a Windows
 * runner the native "\" separators — and config.toml paths that are only valid
 * TOML with "/" — make exactly these checks fail. They are skipped on Windows.
 * The win32 separator fold/rehydrate logic is covered host-agnostically by the
 * "capture+restore with win32 vars" suite below and by the templater unit tests,
 * which DO run on Windows. Everything else here runs on every OS.
 */
const itPosixHost = process.platform === "win32" ? it.skip : it;

/* -------------------------------------------------------------------------- */
/* CAPTURE assertions                                                           */
/* -------------------------------------------------------------------------- */

describe("capture: secrets never leave the machine", () => {
  it("excludes the whole-file secrets (.credentials.json, auth.json)", () => {
    const blob = allCapturedText();
    expect(blob).not.toContain(CLAUDE_CRED_SECRET);
    expect(blob).not.toContain(CODEX_AUTH_SECRET);
    // No CapturedFile should even reference the secret-file paths.
    expect(findFile(claudeCapture.files, "claude/files/.credentials.json")).toBeUndefined();
    expect(findFile(codexCapture.files, "codex/files/auth.json")).toBeUndefined();
  });

  it("records Claude's excluded secret files as metadata-only SecretRefs", () => {
    // Claude capture runs an explicit top-level secret-file scan, so the
    // excluded .credentials.json surfaces as a kind:"file" reminder (metadata
    // only — the VALUE is never read). The Codex auth.json reminder comes from
    // the canonical gatherSecretRefs() path, exercised in the secrets block below.
    const claudeRef = claudeCapture.secrets.find((s) => s.source === ".credentials.json");
    expect(claudeRef).toBeDefined();
    expect(claudeRef!.kind).toBe("file");
    // Every recorded ref is metadata only: it must not carry the secret value.
    for (const ref of [...claudeCapture.secrets, ...codexCapture.secrets]) {
      expect(JSON.stringify(ref)).not.toContain(CLAUDE_CRED_SECRET);
      expect(JSON.stringify(ref)).not.toContain(CODEX_AUTH_SECRET);
    }
  });

  itPosixHost("redacts inline secret VALUES in settings.json and config.toml", () => {
    const blob = allCapturedText();
	    expect(blob).not.toContain(SETTINGS_API_KEY);
	    expect(blob).not.toContain(CONFIG_MCP_SECRET);
	    expect(blob).not.toContain(CURSOR_MCP_SECRET);

    const settings = findFile(claudeCapture.files, "claude/files/settings.json");
    expect(settings).toBeDefined();
    expect(settings!.content).toContain("{{REDACTED}}");

    const config = findFile(codexCapture.files, "codex/files/config.toml");
    expect(config).toBeDefined();
    expect(config!.content).toContain("{{REDACTED}}");
  });

  it("redacts an OPAQUE value under a secret KEY NAME via the real capture path (§0.6)", () => {
    // Drives the ACTUAL claude capture (not sanitizeJson directly): an opaque
    // value whose only secret signal is its KEY NAME must be gone from the stored
    // settings.json. This is the structural-sanitizer regression guard.
    const blob = allCapturedText();
    expect(blob).not.toContain(SETTINGS_OPAQUE_SECRET);

    const settings = findFile(claudeCapture.files, "claude/files/settings.json")!;
    expect(settings.content).not.toContain(SETTINGS_OPAQUE_SECRET);
    expect(settings.content).toContain("{{REDACTED}}");
  });

  it("excludes denylisted junk (the .sqlite sidecar)", () => {
    expect(findFile(claudeCapture.files, "claude/files/telemetry.sqlite")).toBeUndefined();
  });
});

describe("capture: machine paths become placeholders", () => {
  it("folds tool-home and plain-home paths in settings.json", () => {
    const settings = findFile(claudeCapture.files, "claude/files/settings.json")!;
    // The raw machine home appears NOWHERE.
    expect(settings.content).not.toContain(srcHome);
    // Path under the tool home -> {{TOOL_HOME}}; path outside it -> {{HOME}}.
    expect(settings.content).toContain("{{TOOL_HOME}}/statusline/run.sh");
    expect(settings.content).toContain("{{HOME}}/.agents/skills");
  });

	  itPosixHost("folds tool-home and plain-home paths in config.toml (value side)", () => {
    const config = findFile(codexCapture.files, "codex/files/config.toml")!;
    expect(config.content).not.toContain(srcHome);
    expect(config.content).toContain("{{HOME}}/.agents/notify.sh");
    expect(config.content).toContain("{{TOOL_HOME}}/mcp/search.js");
  });

  it("folds both path kinds in a captured agent file", () => {
    const agent = findFile(claudeCapture.files, "claude/files/agents/reviewer.md")!;
    expect(agent.content).not.toContain(srcHome);
    expect(agent.content).toContain("{{TOOL_HOME}}/agents/reviewer.log");
    expect(agent.content).toContain("{{HOME}}/.agents/shared.md");
	  });

	  itPosixHost("folds Cursor MCP, user settings, snippets, and skill paths", () => {
	    const mcp = findFile(cursorCapture.files, "cursor/files/mcp.json")!;
	    expect(mcp.content).not.toContain(srcHome);
	    expect(mcp.content).toContain("{{TOOL_HOME}}/mcp/figma.js");
	    expect(mcp.content).toContain("{{REDACTED}}");

	    const settings = findFile(cursorCapture.files, "cursor/user/settings.json")!;
	    expect(settings.content).not.toContain(srcHome);
	    expect(settings.content).toContain("{{HOME}}/programming");

	    const snippet = findFile(cursorCapture.files, "cursor/user/snippets/typescript.json")!;
	    expect(snippet.content).not.toContain(srcHome);
	    expect(snippet.content).toContain("{{HOME}}");

	    const skill = findFile(cursorCapture.files, "cursor/files/skills/local/SKILL.md")!;
	    expect(skill.content).not.toContain(srcHome);
	    expect(skill.content).toContain("{{TOOL_HOME}}/skills/local/data.json");
	  });
	});

	describe("capture: Cursor portable state", () => {
	  it("captures global MCP, user data, local skills, skills.sh symlinks, and extension metadata", () => {
	    expect(findFile(cursorCapture.files, "cursor/files/mcp.json")).toBeDefined();
	    expect(findFile(cursorCapture.files, "cursor/user/settings.json")).toBeDefined();
	    expect(findFile(cursorCapture.files, "cursor/user/keybindings.json")).toBeDefined();
	    expect(findFile(cursorCapture.files, "cursor/user/snippets/typescript.json")).toBeDefined();
	    expect(findFile(cursorCapture.files, "cursor/user/snippets/cache.sqlite")).toBeUndefined();
	    expect(findFile(cursorCapture.files, "cursor/files/skills/local/SKILL.md")).toBeDefined();

	    expect(cursorCapture.symlinks).toContainEqual({
	      repoPath: "cursor/files/skills/humanizer",
	      target: "../../.agents/skills/humanizer",
	    });
	    expect(cursorCapture.manifest.skills).toEqual(
	      expect.arrayContaining([
	        expect.objectContaining({ name: "local", source: "frozen", symlinked: false }),
	        expect.objectContaining({ name: "humanizer", source: "skills.sh", symlinked: true }),
	      ]),
	    );
	    expect(cursorCapture.manifest.plugins).toContainEqual(
	      expect.objectContaining({
	        id: "anysphere.cursorpyright",
	        name: "anysphere.cursorpyright",
	        version: "1.2.3",
	        scope: "user",
	      }),
	    );
	    expect(findFile(cursorCapture.files, "cursor/files/extensions/extensions.json")).toBeUndefined();
	  });
	});

describe("capture: shared instructions are deduped (R9)", () => {
  it("does NOT emit per-tool CLAUDE.md / AGENTS.md when sharing", () => {
    expect(findFile(claudeCapture.files, "claude/files/CLAUDE.md")).toBeUndefined();
    expect(findFile(codexCapture.files, "codex/files/AGENTS.md")).toBeUndefined();
  });

  it("stores the instructions exactly once under shared/instructions.md", () => {
    expect(sharedFile.repoPath).toBe(SHARED_INSTRUCTIONS_REPO_PATH);
    expect(sharedFile.content).toBe(SHARED_MD);
  });
});

/* -------------------------------------------------------------------------- */
/* RESTORE into a fresh home                                                    */
/* -------------------------------------------------------------------------- */

describe("restore: files reappear correctly in a fresh $HOME", () => {
  let restoredVars: TemplateVariables;

  beforeAll(async () => {
    // Materialize the captured repo tree on disk under repoRoot.
	    for (const f of [...claudeCapture.files, ...codexCapture.files, ...cursorCapture.files]) {
	      const abs = path.join(repoRoot, ...f.repoPath.split("/"));
	      await fsp.mkdir(path.dirname(abs), { recursive: true });
	      if (f.binary) {
	        await fsp.writeFile(abs, Buffer.from(f.content, "base64"));
	      } else {
	        await fsp.writeFile(abs, f.content);
	      }
	    }
	    for (const link of [...claudeCapture.symlinks, ...codexCapture.symlinks, ...cursorCapture.symlinks]) {
	      const abs = path.join(repoRoot, ...link.repoPath.split("/"));
	      await fsp.mkdir(path.dirname(abs), { recursive: true });
	      await fsp.symlink(link.target, abs);
	    }
    // Write the single shared instructions file into the repo.
    const sharedAbs = path.join(repoRoot, ...sharedFile.repoPath.split("/"));
    await fsp.mkdir(path.dirname(sharedAbs), { recursive: true });
    await fsp.writeFile(sharedAbs, sharedFile.content);

    // Restore target: a DIFFERENT home, so {{HOME}} must expand to dstHome.
	    const claudeDst = path.join(dstHome, ".claude");
	    const codexDst = path.join(dstHome, ".codex");
	    const cursorDst = path.join(dstHome, ".cursor");
	    restoredVars = makeVariables(dstHome, "newuser", "linux");
	    const claudeVars = makeVariables(dstHome, "newuser", "linux", claudeDst);
	    const codexVars = makeVariables(dstHome, "newuser", "linux", codexDst);
	    const cursorVars = makeVariables(dstHome, "newuser", "linux", cursorDst);

    // Restore Claude frozen files + the shared instructions (-> CLAUDE.md).
    const claudeData: RestoreData = {
      manifest: claudeCapture.manifest,
      files: [
        ...claudeCapture.files,
        { repoPath: "claude/files/CLAUDE.md", content: sharedFile.content },
      ],
      symlinks: claudeCapture.symlinks,
    };
    await restoreClaude(
      makeRestoreCtx(claudeDst, path.join(repoRoot, "claude"), repoRoot, claudeVars),
      claudeData,
    );

    // Restore Codex frozen files + the shared instructions (-> AGENTS.md).
    const codexData: RestoreData = {
      manifest: codexCapture.manifest,
      files: [
        ...codexCapture.files,
        { repoPath: "codex/files/AGENTS.md", content: sharedFile.content },
      ],
      symlinks: codexCapture.symlinks,
    };
	    await restoreCodex(
	      makeRestoreCtx(codexDst, path.join(repoRoot, "codex"), repoRoot, codexVars),
	      codexData,
	    );

	    const cursorData = await loadRestoreData(repoRoot, "cursor");
	    await restoreCursor(
	      makeRestoreCtx(cursorDst, path.join(repoRoot, "cursor"), repoRoot, cursorVars),
	      cursorData,
	    );
  });

  itPosixHost("re-creates settings.json with placeholders expanded to the TARGET home", async () => {
    const abs = under(path.join(dstHome, ".claude"), "settings.json");
    const content = await fsp.readFile(abs, "utf8");
    // Every placeholder is gone, replaced by the NEW machine's paths...
    expect(content).not.toContain("{{HOME}}");
    expect(content).not.toContain("{{TOOL_HOME}}");
    expect(content).toContain(`${dstHome}/.claude/statusline/run.sh`); // was {{TOOL_HOME}}
    expect(content).toContain(`${dstHome}/.agents/skills`); // was {{HOME}}
    // ...and the redacted marker survived (the secret was never restored as-is).
    expect(content).toContain("{{REDACTED}}");
    expect(content).not.toContain(SETTINGS_API_KEY);
  });

  itPosixHost("re-creates the agent file with both paths expanded to the target home", async () => {
    const abs = under(path.join(dstHome, ".claude"), "agents/reviewer.md");
    const content = await fsp.readFile(abs, "utf8");
    expect(content).toContain(`${dstHome}/.claude/agents/reviewer.log`);
    expect(content).toContain(`${dstHome}/.agents/shared.md`);
    expect(content).not.toContain("{{HOME}}");
    expect(content).not.toContain("{{TOOL_HOME}}");
  });

  itPosixHost("re-creates config.toml with placeholders expanded and the secret still redacted", async () => {
    const abs = under(path.join(dstHome, ".codex"), "config.toml");
    const content = await fsp.readFile(abs, "utf8");
    expect(content).not.toContain("{{HOME}}");
    expect(content).not.toContain("{{TOOL_HOME}}");
    expect(content).toContain(`${dstHome}/.codex/mcp/search.js`); // was {{TOOL_HOME}}
    expect(content).toContain(`${dstHome}/.agents/notify.sh`); // was {{HOME}}
    expect(content).toContain("{{REDACTED}}");
    expect(content).not.toContain(CONFIG_MCP_SECRET);
  });

	  it("deploys the single shared instructions file to BOTH tools", async () => {
    const claudeMd = await fsp.readFile(
      under(path.join(dstHome, ".claude"), "CLAUDE.md"),
      "utf8",
    );
    const agentsMd = await fsp.readFile(
      under(path.join(dstHome, ".codex"), "AGENTS.md"),
      "utf8",
    );
    expect(claudeMd).toBe(SHARED_MD);
    expect(agentsMd).toBe(SHARED_MD);
	  });

	  itPosixHost("restores Cursor tool-home and app User files to the correct locations", async () => {
	    const mcp = await fsp.readFile(under(path.join(dstHome, ".cursor"), "mcp.json"), "utf8");
	    expect(mcp).toContain(`${dstHome}/.cursor/mcp/figma.js`);
	    expect(mcp).toContain("{{REDACTED}}");
	    expect(mcp).not.toContain(CURSOR_MCP_SECRET);

	    const settings = await fsp.readFile(
	      path.join(dstHome, ".config", "Cursor", "User", "settings.json"),
	      "utf8",
	    );
	    expect(settings).toContain(`${dstHome}/programming`);
	    expect(settings).not.toContain("{{HOME}}");

	    const snippet = await fsp.readFile(
	      path.join(dstHome, ".config", "Cursor", "User", "snippets", "typescript.json"),
	      "utf8",
	    );
	    expect(snippet).toContain(dstHome);
	    expect(snippet).not.toContain("{{HOME}}");

	    const skill = await fsp.readFile(
	      under(path.join(dstHome, ".cursor"), "skills/local/SKILL.md"),
	      "utf8",
	    );
	    expect(skill).toContain(`${dstHome}/.cursor/skills/local/data.json`);
	    const linkTarget = await fsp.readlink(under(path.join(dstHome, ".cursor"), "skills/humanizer"));
	    expect(linkTarget).toBe("../../.agents/skills/humanizer");

	    const sharedRuleExists = await realFs.exists(
	      under(path.join(dstHome, ".cursor"), "rules/arbella-shared-instructions.mdc"),
	    );
	    expect(sharedRuleExists).toBe(false);
	  });

  it("does NOT recreate any secret file in the fresh home", async () => {
    const credExists = await realFs.exists(
      under(path.join(dstHome, ".claude"), ".credentials.json"),
    );
    const authExists = await realFs.exists(
      under(path.join(dstHome, ".codex"), "auth.json"),
    );
    expect(credExists).toBe(false);
    expect(authExists).toBe(false);
  });
});

describe("restore: Cursor plan actions", () => {
  it("plans Cursor User files outside ~/.cursor and extension installs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-cursor-plan-"));
    try {
      const home = path.join(root, "home");
      const cursorHome = path.join(home, ".cursor");
      const repo = path.join(root, "repo");
      const ctx = makeRestoreCtx(
        cursorHome,
        path.join(repo, "cursor"),
        repo,
        makeVariables(home, "newuser", "linux", cursorHome),
      );
      const actions = await planCursorActions(ctx, {
        manifest: {
          tool: "cursor",
          plugins: [
            {
              id: "anysphere.cursorpyright",
              name: "anysphere.cursorpyright",
              version: "1.2.3",
              enabled: true,
              scope: "user",
            },
          ],
          marketplaces: [],
          skills: [],
          npmGlobals: [],
          enabledPlugins: {},
        },
        files: [
          {
            repoPath: "cursor/user/settings.json",
            content: "{}",
          },
        ],
        symlinks: [],
      });

      expect(actions).toContainEqual(
        expect.objectContaining({
          type: "write-file",
          tool: "cursor",
          targetPath: path.join(home, ".config", "Cursor", "User", "settings.json"),
        }),
      );
      expect(actions).toContainEqual(
        expect.objectContaining({
          type: "install-plugin",
          tool: "cursor",
          description: "cursor --install-extension anysphere.cursorpyright",
        }),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* includeSecrets flag is actually CONSUMED by capture (not dead config)        */
/* -------------------------------------------------------------------------- */

describe("capture: includeSecrets flips redaction of inline secret values", () => {
  it("OFF redacts inline values; ON carries them verbatim into the repo", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-inc-"));
    const home = path.join(root, "home");
    const claudeHome = path.join(home, ".claude");
    await fsp.mkdir(claudeHome, { recursive: true });

    const SECRET = "sk-ant-api03-INCLUDE-TEST-FFFFFFFFFFFFFFFFFFFF";
    const OPAQUE = "corp-opaque-include-GGGGGGGG-no-prefix";
    await fsp.writeFile(
      path.join(claudeHome, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: OPAQUE } }, null, 2),
    );

    const vars = makeVariables(home, "fab", "linux", claudeHome);
    const ctxFor = (includeSecrets: boolean): CaptureContext => ({
      ...makeCaptureCtx(claudeHome, vars),
      includeSecrets,
    });

    const off = await captureClaude(ctxFor(false));
    const on = await captureClaude(ctxFor(true));
    const offC = off.files.find((f) => f.repoPath === "claude/files/settings.json")!.content;
    const onC = on.files.find((f) => f.repoPath === "claude/files/settings.json")!.content;

    // OFF: both values redacted (pattern + opaque-key), repo carries no secret.
    expect(offC).not.toContain(SECRET);
    expect(offC).not.toContain(OPAQUE);
    expect(offC).toContain("{{REDACTED}}");

    // ON: the documented opt-in carries the REAL values (the "risk"), no redaction.
    expect(onC).toContain(SECRET);
    expect(onC).toContain(OPAQUE);
    expect(onC).not.toContain("{{REDACTED}}");

    await fsp.rm(root, { recursive: true, force: true });
  });
});

/* -------------------------------------------------------------------------- */
/* win32-vars capture + restore: paths must round-trip to VALID JSON            */
/* -------------------------------------------------------------------------- */

describe("capture+restore with win32 vars (cross-OS path round-trip)", () => {
  it("captures a JSON-doubled-backslash settings.json and restores VALID JSON", async () => {
    // A Windows-style home + a settings.json whose hook path is written with the
    // JSON-doubled backslashes a real Windows tool emits. The capture/restore must
    // fold {{HOME}}/{{TOOL_HOME}} and rehydrate so the file PARSES (the bug was an
    // invalid mixed single/doubled-backslash path on restore).
    const winRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-win-"));
    const winSrcHome = "C:\\Users\\fab";
    const winDstHome = "C:\\Users\\newuser";

    // The on-disk fixture still lives under a real POSIX temp dir (this test host
    // is macOS); only the TEMPLATE VARS are win32, which is what drives the
    // separator-aware fold/rehydrate. Source/target tool homes on disk:
    const claudeSrcDisk = path.join(winRoot, "src", ".claude");
    const claudeDstDisk = path.join(winRoot, "dst", ".claude");
    await fsp.mkdir(claudeSrcDisk, { recursive: true });

    // settings.json with a doubled-backslash hook path under the win32 tool home.
    const winSettings =
      '{"hooks":{"PreToolUse":"C:\\\\Users\\\\fab\\\\.claude\\\\hooks\\\\run.py"}}';
    await fsp.writeFile(path.join(claudeSrcDisk, "settings.json"), winSettings);

    // Capture with win32 vars (tool home = the win32 ~/.claude).
    const capVars = makeVariables(winSrcHome, "fab", "win32", `${winSrcHome}\\.claude`);
    const cap = await captureClaude(makeCaptureCtx(claudeSrcDisk, capVars));
    const captured = cap.files.find((f) => f.repoPath === "claude/files/settings.json")!;
    // The machine home is gone; a token took its place.
    expect(captured.content).not.toContain("C:\\\\Users\\\\fab");
    expect(captured.content).toMatch(/\{\{(HOME|TOOL_HOME)\}\}/);

    // Materialize the captured repo file, then restore into a fresh win32 home.
    const repoDir = path.join(winRoot, "repo");
    const repoFileAbs = path.join(repoDir, ...captured.repoPath.split("/"));
    await fsp.mkdir(path.dirname(repoFileAbs), { recursive: true });
    await fsp.writeFile(repoFileAbs, captured.content);

    const restVars = makeVariables(winDstHome, "newuser", "win32", `${winDstHome}\\.claude`);
    await restoreClaude(
      makeRestoreCtx(claudeDstDisk, path.join(repoDir, "claude"), repoDir, restVars),
      { manifest: cap.manifest, files: [captured], symlinks: [] },
    );

    const restored = await fsp.readFile(path.join(claudeDstDisk, "settings.json"), "utf8");
    // Must be VALID JSON (the original bug produced invalid escapes here).
    expect(() => JSON.parse(restored)).not.toThrow();
    // And the path rehydrated to the TARGET win32 home, doubled-backslash style.
    expect(JSON.parse(restored).hooks.PreToolUse).toBe(
      "C:\\Users\\newuser\\.claude\\hooks\\run.py",
    );

    await fsp.rm(winRoot, { recursive: true, force: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Secrets on-disk round-trip (collect -> encrypt -> decrypt -> apply)          */
/* -------------------------------------------------------------------------- */

describe("secrets: file collect/apply round-trip via a redirected HOME", () => {
  it("bundles the source secret files and restores them into a fresh home", async () => {
    // These functions resolve tool homes from os.homedir(); redirect HOME so they
    // read our fixture and write into a clean target — all inside the temp root.
    const secMod = await import("../../src/core/secrets/index.js");
    const origHome = os.homedir();
    const origEnvHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;

    const secSrcHome = path.join(tmpRoot, "sec-src");
    const secDstHome = path.join(tmpRoot, "sec-dst");
    await fsp.mkdir(path.join(secSrcHome, ".claude"), { recursive: true });
    await fsp.mkdir(path.join(secSrcHome, ".codex"), { recursive: true });
    await fsp.writeFile(
      path.join(secSrcHome, ".claude", ".credentials.json"),
      JSON.stringify({ token: CLAUDE_CRED_SECRET }),
      { mode: 0o600 },
    );
    await fsp.writeFile(
      path.join(secSrcHome, ".codex", "auth.json"),
      `{"token":"${CODEX_AUTH_SECRET}"}`,
      { mode: 0o600 },
    );

    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(secSrcHome);
    process.env.HOME = secSrcHome;
    process.env.USERPROFILE = secSrcHome;

    try {
      // Discover -> the two known secret files exist.
      const claudeRefs = await secMod.gatherSecretRefs("claude");
      const codexRefs = await secMod.gatherSecretRefs("codex");
      const refs = [...claudeRefs, ...codexRefs];
      expect(refs.some((r) => r.source === ".credentials.json")).toBe(true);
      expect(refs.some((r) => r.source === "auth.json")).toBe(true);

      // Export (collect + encrypt). The blob carries NO plaintext secret.
      const blob = await secMod.exportSecrets(refs, "trip-pass", "2026-05-30T00:00:00Z");
      expect(blob).not.toContain(CLAUDE_CRED_SECRET);
      expect(blob).not.toContain(CODEX_AUTH_SECRET);

      // Wrong passphrase fails before any write.
      await expect(secMod.importSecrets(blob, "wrong-pass")).rejects.toThrow();

      // Import into a fresh home: redirect HOME to the destination.
      homeSpy.mockReturnValue(secDstHome);
      process.env.HOME = secDstHome;
      process.env.USERPROFILE = secDstHome;
      await secMod.importSecrets(blob, "trip-pass");

      // The secret files reappear, byte-identical, under the new home.
      const cred = await fsp.readFile(
        path.join(secDstHome, ".claude", ".credentials.json"),
        "utf8",
      );
      const auth = await fsp.readFile(
        path.join(secDstHome, ".codex", "auth.json"),
        "utf8",
      );
      expect(JSON.parse(cred).token).toBe(CLAUDE_CRED_SECRET);
      expect(auth).toContain(CODEX_AUTH_SECRET);
    } finally {
      homeSpy.mockRestore();
      if (origEnvHome === undefined) delete process.env.HOME;
      else process.env.HOME = origEnvHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
      // Sanity: homedir restored.
      expect(os.homedir()).toBe(origHome);
    }
  });
});
