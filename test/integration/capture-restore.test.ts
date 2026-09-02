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
 *   - WIDER CLAUDE SET (WP-A): rules/, scripts/ and keybindings.json round-trip,
 *     a settings.json.bak-* dropping is NOT captured, ~/.claude.json's MCP servers
 *     reach the manifest while its oauthAccount/userID reach nothing at all, and a
 *     per-project memory lands under claude/memories/ and restores into the fresh
 *     $HOME's own project slug.
 *   - SHARED HOME (WP-B): the scripts the configs POINT AT but that live outside
 *     every tool home (a hook dispatcher under ~/.agents, an MCP launcher under
 *     ~/.local/bin), the claude-mem companion config, and a configured
 *     `extraPaths` dir all land under shared/home/… with their secrets redacted
 *     and their exec bits intact — while a hook script that lives INSIDE
 *     ~/.claude is never duplicated there.
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
  // WP-C: a deterministic stand-in for the PATH probe. An absolute path still
  // has to EXIST (matching the real resolveBinaryPath), and exactly one bare
  // name is "installed" on this fake machine — via `uv tool install`.
  resolveBinaryPath: async (name: string) => {
    if (name.startsWith("/")) {
      try {
        const { promises: fsp } = await import("node:fs");
        await fsp.access(name);
        return name;
      } catch {
        return null;
      }
    }
    return name === "codegraph" ? UV_TOOL_BIN : null;
  },
  realPathOrSelf: async (binaryPath: string) => binaryPath,
}));

/** Where the mocked resolver claims the `codegraph` MCP binary lives (uv layout). */
const UV_TOOL_BIN = "/opt/fake-uv/uv/tools/codegraph/bin/codegraph";

import { capture as captureClaude } from "../../src/adapters/claude/capture.js";
import { restore as restoreClaude } from "../../src/adapters/claude/restore.js";
import {
  MEMORIES_REPO_PREFIX,
  slugifyPath,
} from "../../src/adapters/claude/memories.js";
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
import { loadRestoreData, loadHomeFiles } from "../../src/commands/restore.js";
import type {
  HomeCaptureContext,
  HomeCaptureOut,
} from "../../src/core/homefiles/capture.js";
import {
  SHARED_HOME_REPO_PREFIX,
  captureExtraPaths,
  dedupeByRepoPath,
  isSharedHomePath,
} from "../../src/core/homefiles/capture.js";
import { restoreHomeFiles } from "../../src/core/homefiles/restore.js";
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
// ~/.claude.json: the OAuth payload that must never reach the repo, plus an MCP
// env value that must come back redacted.
const GLOBAL_STATE_OAUTH_TOKEN = "sk-ant-oat01-GLOBAL-STATE-IIIIIIIIIIIIIIIIIIII";
const GLOBAL_STATE_USER_ID = "acct_GLOBAL_STATE_USERID_JJJJJJJJ";
const GLOBAL_MCP_ENV_SECRET = "glpat-GLOBAL-MCP-ENV-KKKKKKKKKKKKK";
// WP-B: secrets that live in $HOME files OUTSIDE every tool home.
const HOME_SCRIPT_TOKEN = "sk-ant-api03-HOME-SCRIPT-LLLLLLLLLLLLLLLLLLLL";
const CLAUDE_MEM_API_KEY = "sk-ant-api03-CLAUDE-MEM-MMMMMMMMMMMMMMMMMMMM";
const HOME_DOTENV_SECRET = "sk-ant-api03-HOME-DOTENV-NNNNNNNNNNNNNNNNNNNN";

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
/** The `extraPaths` pass the backup command runs after the adapters (WP-B). */
let extraHomeCapture: HomeCaptureOut;
/** Adapter shared/home files + extraPaths, merged first-wins like backup.ts. */
let mergedHomeFiles: CapturedFile[];

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
    // WP-B: a hook chain that reaches OUT of ~/.claude (the dispatcher), one that
    // stays INSIDE it (send_event.py, already covered by claude/files), and one
    // that points at a credential file which must never be carried.
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "bash ~/.agents/hooks/dispatch.sh --json" },
            { type: "command", command: `python3 ${srcHome}/.claude/hooks/send_event.py` },
            { type: "command", command: "cat ~/.env" },
          ],
        },
      ],
    },
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

  // ---- WP-A: the wider frozen set ----
  // rules/ is referenced by CLAUDE.md; scripts/ holds the hook dispatchers that
  // settings.json points at; keybindings.json is plain user config whose "key"
  // entries must survive the secret-key heuristics.
  await writeFile(
    claudeSrc,
    "rules/ecc/common/coding-style.md",
    `Style rules. See ${srcHome}/.claude/rules/ecc/README.md\n`,
  );
  await writeFile(claudeSrc, "scripts/dispatch.sh", "#!/bin/sh\nexec \"$@\"\n", 0o755);
  await writeFile(
    claudeSrc,
    "keybindings.json",
    JSON.stringify([{ key: "cmd+k", command: "arbella.push" }], null, 2),
  );
  // Editor/tool droppings that must NEVER be captured.
  await writeFile(claudeSrc, "settings.json.bak-routing-20260829", "{\"stale\":true}");
  await writeFile(claudeSrc, "scripts/dispatch.sh.bak", "#!/bin/sh\n# old\n");
  // A hook script INSIDE the tool home: captured under claude/files, and it must
  // NOT be duplicated into shared/home just because a hook references it.
  await writeFile(claudeSrc, "hooks/send_event.py", "print('event')\n", 0o755);

  // ---- WP-B: files in $HOME but OUTSIDE every tool home ----
  // The hook dispatcher settings.json points at: executable, references other
  // $HOME paths (must template) and carries an inline token (must redact).
  await writeFile(
    srcHome,
    ".agents/hooks/dispatch.sh",
    "#!/bin/sh\n" +
      `. ${srcHome}/.agents/lib/common.sh\n` +
      `export API_TOKEN=${HOME_SCRIPT_TOKEN}\n` +
      `exec ${srcHome}/.agents/hooks/handoff-offer.sh "$@"\n`,
    0o755,
  );
  // The MCP launcher ~/.claude.json points at.
  await writeFile(
    srcHome,
    ".local/bin/serena-mcp-start",
    "#!/bin/sh\nexec uv tool run serena-agent \"$@\"\n",
    0o755,
  );
  // A credential file a (misguided) hook references: NEVER carried.
  await writeFile(srcHome, ".env", `ANTHROPIC_API_KEY=${HOME_DOTENV_SECRET}\n`);
  // The claude-mem plugin's companion config (reinstalled from the manifest, but
  // its own settings live outside ~/.claude).
  await writeFile(
    srcHome,
    ".claude-mem/settings.json",
    JSON.stringify(
      { archiveMode: "full", ANTHROPIC_API_KEY: CLAUDE_MEM_API_KEY },
      null,
      2,
    ),
  );
  // An extraPaths directory (user-authored content nothing links to).
  await writeFile(
    srcHome,
    ".agents/memory/PROJECTS.md",
    `Memory notes. Repos live in ${srcHome}/programming.\n`,
  );
  await writeFile(srcHome, ".agents/memory/scratch.log", "noise that must not travel\n");

  // ---- WP-A: ~/.claude.json (SIBLING of the tool home) ----
  // Only mcpServers / projects.*.mcpServers may be lifted out of it.
  const claudeProjectDir = path.join(srcHome, "programming", "arbella");
  await fsp.mkdir(claudeProjectDir, { recursive: true });
  await writeFile(
    srcHome,
    ".claude.json",
    JSON.stringify(
      {
        numStartups: 91,
        userID: GLOBAL_STATE_USER_ID,
        oauthAccount: {
          emailAddress: "fab@example.com",
          accessToken: GLOBAL_STATE_OAUTH_TOKEN,
        },
        mcpServers: {
          serena: {
            command: `${srcHome}/.local/bin/serena-mcp-start`,
            args: ["--stdio"],
            env: { SERENA_TOKEN: GLOBAL_MCP_ENV_SECRET },
          },
          // WP-C: a bare command name whose binary a package manager installed —
          // the launcher above is carried as a FILE, this one must be recorded as
          // an external tool to reinstall.
          codegraph: { command: "codegraph", args: ["mcp"] },
        },
        projects: {
          [claudeProjectDir]: { mcpServers: { local: { command: "local-mcp" } } },
        },
      },
      null,
      2,
    ),
    0o600,
  );

  // ---- WP-A: a per-project memory (includeMemories) ----
  await writeFile(
    claudeSrc,
    `projects/${slugifyPath(srcHome)}-programming-arbella/memory/MEMORY.md`,
    `Arbella notes. Code at ${srcHome}/programming/arbella\n`,
  );
  // Session state alongside it must stay behind.
  await writeFile(
    claudeSrc,
    `projects/${slugifyPath(srcHome)}-programming-arbella/history.jsonl`,
    "{}\n",
  );

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
	  // WP-B: a codex hook pointing at a script outside ~/.codex.
	  await writeFile(
	    codexSrc,
	    "hooks.json",
	    JSON.stringify(
	      {
	        hooks: {
	          SessionStart: [
	            { hooks: [{ type: "command", command: "~/.local/bin/graphify update ." }] },
	          ],
	        },
	      },
	      null,
	      2,
	    ),
	  );
	  await writeFile(srcHome, ".local/bin/graphify", "#!/bin/sh\necho graphify\n", 0o755);
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

  claudeCapture = await captureClaude(
    { ...makeCaptureCtx(claudeSrc, claudeVars), includeMemories: true },
    { skipInstructions: share },
  );
	  codexCapture = await captureCodex(makeCaptureCtx(codexSrc, codexVars), {
	    skipInstructions: share,
	  });
	  cursorCapture = await captureCursor(makeCaptureCtx(cursorSrc, cursorVars), {
	    skipInstructions: share,
	  });
	  sharedFile = buildSharedInstructionsFile(SHARED_MD);

	  // ---- WP-B: the extraPaths pass + the cross-tool shared/home merge -------
	  // Mirrors src/commands/backup.ts: adapters first (in capture order), then
	  // extraPaths, deduped by repoPath.
	  const homeCtx: HomeCaptureContext = {
	    ...makeCaptureCtx(srcHome, makeVariables(srcHome, "fab", "linux")),
	    includeSecrets: false,
	  };
	  extraHomeCapture = { files: [], secrets: [], warnings: [] };
	  await captureExtraPaths(
	    homeCtx,
	    ["~/.agents/memory", "/etc/hosts"],
	    "claude",
	    extraHomeCapture,
	    { excludeRoots: [claudeSrc, codexSrc, cursorSrc] },
	  );
	  mergedHomeFiles = dedupeByRepoPath([
	    ...claudeCapture.files.filter((f) => isSharedHomePath(f.repoPath)),
	    ...codexCapture.files.filter((f) => isSharedHomePath(f.repoPath)),
	    ...extraHomeCapture.files,
	  ]);
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

  it("excludes denylisted junk (the .sqlite sidecar and the .bak droppings)", () => {
    expect(findFile(claudeCapture.files, "claude/files/telemetry.sqlite")).toBeUndefined();
    expect(
      findFile(claudeCapture.files, "claude/files/settings.json.bak-routing-20260829"),
    ).toBeUndefined();
    expect(findFile(claudeCapture.files, "claude/files/scripts/dispatch.sh.bak")).toBeUndefined();
    // ...and the stale copy's content never reaches the repo either.
    expect(allCapturedText()).not.toContain('{"stale":true}');
  });

  it("lifts ONLY mcpServers out of ~/.claude.json (WP-A)", () => {
    const blob = allCapturedText() + JSON.stringify(claudeCapture.manifest);
    // The account payload is absent by VALUE and by KEY NAME.
    expect(blob).not.toContain(GLOBAL_STATE_OAUTH_TOKEN);
    expect(blob).not.toContain(GLOBAL_STATE_USER_ID);
    expect(blob).not.toContain("oauthAccount");
    expect(blob).not.toContain("numStartups");
    // ~/.claude.json itself is never a captured file, under any prefix.
    expect(claudeCapture.files.some((f) => f.repoPath.includes(".claude.json"))).toBe(false);

    // The servers DID make it, sanitized + templated.
    const serena = claudeCapture.manifest.mcpServers.serena as Record<string, unknown>;
    expect(serena).toBeDefined();
    expect(serena.command).toBe("{{HOME}}/.local/bin/serena-mcp-start");
    expect((serena.env as Record<string, unknown>).SERENA_TOKEN).toBe("{{REDACTED}}");
    expect(blob).not.toContain(GLOBAL_MCP_ENV_SECRET);

    expect(claudeCapture.manifest.projectMcpServers).toEqual([
      { projectPath: "{{HOME}}/programming/arbella", servers: { local: { command: "local-mcp" } } },
    ]);
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

describe("capture: the wider Claude frozen set (WP-A)", () => {
  it("captures rules/, scripts/ (with its exec bit) and keybindings.json", () => {
    const rule = findFile(claudeCapture.files, "claude/files/rules/ecc/common/coding-style.md");
    expect(rule).toBeDefined();
    expect(rule!.content).toContain("{{TOOL_HOME}}/rules/ecc/README.md");

    const script = findFile(claudeCapture.files, "claude/files/scripts/dispatch.sh");
    expect(script).toBeDefined();
    expect(script!.mode).toBe(0o755);

    const keys = findFile(claudeCapture.files, "claude/files/keybindings.json");
    expect(keys).toBeDefined();
    // "key" is deliberately NOT a secret key name — a keybinding must survive.
    expect(keys!.content).toContain("cmd+k");
    expect(keys!.content).not.toContain("{{REDACTED}}");
  });

  it("captures projects/<slug>/memory under its own repo root, not projects/", () => {
    const mem = findFile(
      claudeCapture.files,
      `${MEMORIES_REPO_PREFIX}/home/-programming-arbella/MEMORY.md`,
    );
    expect(mem).toBeDefined();
    expect(mem!.content).toContain("{{HOME}}/programming/arbella");
    // Session state next to it stays behind, and nothing lands under claude/files.
    expect(
      claudeCapture.files.some((f) => f.repoPath.includes("history.jsonl")),
    ).toBe(false);
    expect(
      claudeCapture.files.some((f) => f.repoPath.startsWith("claude/files/projects")),
    ).toBe(false);
  });
});

describe("capture: linked $HOME files land in shared/home (WP-B)", () => {
  /** Look a shared/home file up by its $HOME-relative path. */
  function homeFile(rel: string): CapturedFile | undefined {
    return mergedHomeFiles.find((f) => f.repoPath === `${SHARED_HOME_REPO_PREFIX}/${rel}`);
  }

  it("carries the hook dispatcher settings.json points at, redacted and executable", () => {
    const script = homeFile(".agents/hooks/dispatch.sh");
    expect(script).toBeDefined();
    expect(script!.mode).toBe(0o755);
    // The inline token is gone; the machine paths are placeholders.
    expect(script!.content).not.toContain(HOME_SCRIPT_TOKEN);
    expect(script!.content).toContain("{{REDACTED}}");
    expect(script!.content).not.toContain(srcHome);
    expect(script!.content).toContain("{{HOME}}/.agents/lib/common.sh");
    // Shared home files are tool-agnostic: no {{TOOL_HOME}} may appear.
    expect(script!.content).not.toContain("{{TOOL_HOME}}");
  });

  it("carries the MCP launcher ~/.claude.json points at", () => {
    const launcher = homeFile(".local/bin/serena-mcp-start");
    expect(launcher).toBeDefined();
    expect(launcher!.mode).toBe(0o755);
  });

  it("carries a codex hook script from hooks.json", () => {
    expect(homeFile(".local/bin/graphify")).toBeDefined();
  });

  it("carries the claude-mem companion config with its API key redacted", () => {
    const companion = homeFile(".claude-mem/settings.json");
    expect(companion).toBeDefined();
    expect(companion!.content).not.toContain(CLAUDE_MEM_API_KEY);
    expect(companion!.content).toContain("{{REDACTED}}");
    expect(JSON.parse(companion!.content).archiveMode).toBe("full");
  });

  it("carries an extraPaths directory but not its denylisted noise", () => {
    const notes = homeFile(".agents/memory/PROJECTS.md");
    expect(notes).toBeDefined();
    expect(notes!.content).toContain("{{HOME}}/programming");
    expect(homeFile(".agents/memory/scratch.log")).toBeUndefined();
    // A configured path outside $HOME is refused, loudly.
    expect(extraHomeCapture.warnings.join("\n")).toContain("/etc/hosts");
  });

  it("NEVER carries ~/.env, even though a hook command reads it", () => {
    expect(homeFile(".env")).toBeUndefined();
    const blob = [allCapturedText(), ...mergedHomeFiles.map((f) => f.content)].join("\n");
    expect(blob).not.toContain(HOME_DOTENV_SECRET);
  });

  it("NEVER duplicates a script that already lives inside a tool home", () => {
    // send_event.py is referenced by a hook AND lives under ~/.claude: it belongs
    // to claude/files exactly once, and to shared/home not at all.
    expect(findFile(claudeCapture.files, "claude/files/hooks/send_event.py")).toBeDefined();
    expect(homeFile(".claude/hooks/send_event.py")).toBeUndefined();
    for (const file of mergedHomeFiles) {
      expect(file.repoPath.startsWith(`${SHARED_HOME_REPO_PREFIX}/.claude/`)).toBe(false);
      expect(file.repoPath.startsWith(`${SHARED_HOME_REPO_PREFIX}/.codex/`)).toBe(false);
    }
  });
});

describe("capture: external tools behind MCP/hook commands (WP-C)", () => {
  it("records the package-manager binary an MCP server invokes", () => {
    expect(claudeCapture.manifest.externalTools).toEqual([
      {
        name: "codegraph",
        manager: "uv",
        command: "codegraph",
        resolvedPath: UV_TOOL_BIN,
        usedBy: ["claude:.claude.json#mcpServers.codegraph"],
      },
    ]);
  });

  it("never records a script the backup already carries as a file", () => {
    const commands = [
      ...claudeCapture.manifest.externalTools,
      ...codexCapture.manifest.externalTools,
    ].map((tool) => tool.command);

    // Each of these IS referenced by a hook / statusline / MCP command, and each
    // one travels in shared/home or claude/files — reinstalling them would be
    // wrong, and telling the user to install them by hand would be a lie.
    for (const carried of [
      "serena-mcp-start",
      "dispatch.sh",
      "graphify",
      "send_event.py",
      "statusline",
    ]) {
      expect(commands.some((command) => command.includes(carried))).toBe(false);
    }
  });

  it("leaves the list empty when every referenced command is a runtime or carried", () => {
    // Codex's fixture references `node` (a runtime) and ~/.local/bin/graphify
    // (carried into shared/home) — nothing left to install.
    expect(codexCapture.manifest.externalTools).toEqual([]);
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
    // Materialize the captured repo tree on disk under repoRoot. Modes are
	    // written too, so the exec bit round-trips through the repo like it does in
	    // a real clone.
	    for (const f of [
	      ...claudeCapture.files,
	      ...codexCapture.files,
	      ...cursorCapture.files,
	      ...extraHomeCapture.files,
	    ]) {
	      const abs = path.join(repoRoot, ...f.repoPath.split("/"));
	      await fsp.mkdir(path.dirname(abs), { recursive: true });
	      const mode = f.mode !== undefined ? { mode: f.mode } : undefined;
	      if (f.binary) {
	        await fsp.writeFile(abs, Buffer.from(f.content, "base64"), mode);
	      } else {
	        await fsp.writeFile(abs, f.content, mode);
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
	    // The project-scope MCP entry only applies when its (rehydrated) project dir
	    // exists here, so create the twin of the source machine's project.
	    await fsp.mkdir(path.join(dstHome, "programming", "arbella"), { recursive: true });
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

	    // WP-B step "8c": the cross-tool shared/home root, read back out of the
	    // repo exactly as `arbella pull` reads it and written into the fresh $HOME.
	    const homeFilesFromRepo = await loadHomeFiles(repoRoot);
	    await restoreHomeFiles(
	      {
	        fs: realFs,
	        log: silentLog,
	        sanitizer,
	        templater,
	        vars: restoredVars,
	        os: "linux",
	        env: {},
	        sourceOfTruth: "repo",
	        dryRun: false,
	      },
	      homeFilesFromRepo,
	      { safetyDir: path.join(tmpRoot, "home-safety") },
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

  itPosixHost("restores the wider frozen set into the fresh home (WP-A)", async () => {
    const claudeDst = path.join(dstHome, ".claude");

    const rule = await fsp.readFile(under(claudeDst, "rules/ecc/common/coding-style.md"), "utf8");
    expect(rule).toContain(`${dstHome}/.claude/rules/ecc/README.md`);
    expect(rule).not.toContain("{{TOOL_HOME}}");

    const scriptPath = under(claudeDst, "scripts/dispatch.sh");
    expect(await realFs.exists(scriptPath)).toBe(true);
    expect((await fsp.stat(scriptPath)).mode & 0o777).toBe(0o755);

    const keys = await fsp.readFile(under(claudeDst, "keybindings.json"), "utf8");
    expect(JSON.parse(keys)[0].key).toBe("cmd+k");

    // The droppings were never captured, so they cannot reappear.
    expect(await realFs.exists(under(claudeDst, "settings.json.bak-routing-20260829"))).toBe(false);
    expect(await realFs.exists(under(claudeDst, "scripts/dispatch.sh.bak"))).toBe(false);
  });

  itPosixHost("restores the memory under the TARGET machine's project slug", async () => {
    const dest = under(
      path.join(dstHome, ".claude"),
      `projects/${slugifyPath(dstHome)}-programming-arbella/memory/MEMORY.md`,
    );
    const content = await fsp.readFile(dest, "utf8");
    expect(content).toContain(`${dstHome}/programming/arbella`);
    expect(content).not.toContain("{{HOME}}");
    // The source machine's slug must not survive into the target home.
    expect(
      await realFs.exists(
        under(path.join(dstHome, ".claude"), `projects/${slugifyPath(srcHome)}-programming-arbella`),
      ),
    ).toBe(false);
  });

  itPosixHost("merges the MCP servers into a freshly created ~/.claude.json", async () => {
    const globalState = path.join(dstHome, ".claude.json");
    const stat = await fsp.stat(globalState);
    expect(stat.mode & 0o777).toBe(0o600);

    const obj = JSON.parse(await fsp.readFile(globalState, "utf8"));
    // ONLY the keys arbella owns exist — nothing was invented from the source file.
    expect(Object.keys(obj).sort()).toEqual(["mcpServers", "projects"]);
    expect(obj.mcpServers.serena.command).toBe(`${dstHome}/.local/bin/serena-mcp-start`);
    expect(obj.mcpServers.serena.env.SERENA_TOKEN).toBe("{{REDACTED}}");
    // The project dir exists in the fresh home only because the fixture created it
    // there too; the entry is keyed by THIS machine's absolute path.
    const projectDir = path.join(dstHome, "programming", "arbella");
    expect(obj.projects[projectDir].mcpServers.local).toEqual({ command: "local-mcp" });

    const blob = await fsp.readFile(globalState, "utf8");
    expect(blob).not.toContain(GLOBAL_STATE_OAUTH_TOKEN);
    expect(blob).not.toContain(GLOBAL_MCP_ENV_SECRET);
  });

  itPosixHost("writes the shared/home files back into the fresh $HOME (WP-B)", async () => {
    const dispatch = path.join(dstHome, ".agents", "hooks", "dispatch.sh");
    const content = await fsp.readFile(dispatch, "utf8");
    // Paths rehydrated to the TARGET home, secret still redacted, exec bit kept.
    expect(content).toContain(`${dstHome}/.agents/lib/common.sh`);
    expect(content).toContain(`${dstHome}/.agents/hooks/handoff-offer.sh`);
    expect(content).not.toContain("{{HOME}}");
    expect(content).not.toContain(srcHome);
    expect(content).toContain("{{REDACTED}}");
    expect(content).not.toContain(HOME_SCRIPT_TOKEN);
    expect((await fsp.stat(dispatch)).mode & 0o777).toBe(0o755);

    const launcher = path.join(dstHome, ".local", "bin", "serena-mcp-start");
    expect((await fsp.stat(launcher)).mode & 0o777).toBe(0o755);
    expect(await realFs.exists(path.join(dstHome, ".local", "bin", "graphify"))).toBe(true);

    const companion = await fsp.readFile(
      path.join(dstHome, ".claude-mem", "settings.json"),
      "utf8",
    );
    expect(JSON.parse(companion).ANTHROPIC_API_KEY).toBe("{{REDACTED}}");
    expect(companion).not.toContain(CLAUDE_MEM_API_KEY);

    const notes = await fsp.readFile(
      path.join(dstHome, ".agents", "memory", "PROJECTS.md"),
      "utf8",
    );
    expect(notes).toContain(`${dstHome}/programming`);
  });

  it("never recreates a denylisted $HOME file that a hook referenced", async () => {
    expect(await realFs.exists(path.join(dstHome, ".env"))).toBe(false);
    expect(
      await realFs.exists(path.join(dstHome, ".agents", "memory", "scratch.log")),
    ).toBe(false);
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

describe("restore: shared/home can never write outside $HOME", () => {
  it("refuses a hand-edited repo path that climbs out of shared/home", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-home-escape-"));
    try {
      const home = path.join(root, "home");
      await fsp.mkdir(home, { recursive: true });
      const warnings: string[] = [];

      const written = await restoreHomeFiles(
        {
          fs: realFs,
          log: { ...silentLog, warn: (m: string) => warnings.push(m) },
          sanitizer,
          templater,
          vars: makeVariables(home, "newuser", "linux"),
          os: "linux",
          env: {},
          sourceOfTruth: "repo",
          dryRun: false,
        },
        [
          { repoPath: `${SHARED_HOME_REPO_PREFIX}/../../escaped.txt`, content: "nope" },
          { repoPath: `${SHARED_HOME_REPO_PREFIX}/./ok.txt`, content: "nope" },
          { repoPath: "claude/files/settings.json", content: "nope" },
          { repoPath: `${SHARED_HOME_REPO_PREFIX}/fine.txt`, content: "yes" },
        ],
        { safetyDir: path.join(root, "safety") },
      );

      expect(written).toBe(1);
      expect(await fsp.readFile(path.join(home, "fine.txt"), "utf8")).toBe("yes");
      // Nothing was created next to (or above) the home dir.
      expect(await fsp.readdir(root)).toEqual(["home"]);
      expect(warnings.join("\n")).toContain("escaped.txt");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
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
