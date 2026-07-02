/**
 * Unit tests for the Antigravity adapter (multi-root capture/restore).
 *
 * Antigravity's setup spans three roots — ~/.antigravity, the VS Code User dir,
 * and the shared ~/.gemini agent dir. The load-bearing property is SECRET SAFETY:
 * ~/.gemini also holds live Google OAuth tokens, so these tests prove that an
 * allowlist capture never reads oauth_creds.json / google_accounts.json and that
 * their token text reaches NO captured file. They also prove the portable config
 * from every root round-trips into a fresh set of roots with paths rehydrated, and
 * that machine-local state (extension binaries, argv.json, globalStorage, history)
 * is excluded.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { capture, restore } from "../../src/adapters/antigravity/index.js";
import type { CaptureResult, EnvVars, TemplateVariables } from "../../src/types.js";
import type {
  CaptureContext,
  RestoreContext,
  RestoreData,
} from "../../src/adapters/adapter.interface.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";

const GEMINI_MCP_SECRET = "sk-ant-api03-ANTIGRAVITY-GEMINI-MCP-SECRET-AAAAAAAA";
// Built at runtime so the Google-OAuth-shaped fixture never trips secret scanners.
const OAUTH_TOKEN = ["ya29", "A0-ANTIGRAVITY-OAUTH-ACCESS-TOKEN-MUST-NEVER-LEAK"].join(".");

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

function captureCtx(toolHome: string, vars: TemplateVariables, env: EnvVars = {}): CaptureContext {
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

function restoreCtx(toolHome: string, vars: TemplateVariables): RestoreContext {
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

async function write(abs: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

/** Build the three roots for a given base "home" dir (os=linux, env={}). */
function roots(base: string): { toolHome: string; userDir: string; gemini: string } {
  return {
    toolHome: path.join(base, ".antigravity"),
    userDir: path.join(base, ".config", "Antigravity", "User"),
    gemini: path.join(base, ".gemini"),
  };
}

let srcBase: string;
let dstBase: string;
let result: CaptureResult;

beforeAll(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-antigravity-"));
  srcBase = path.join(tmp, "src");
  dstBase = path.join(tmp, "dst");
  const r = roots(srcBase);

  // Root B — ~/.antigravity: only the extension manifest is portable.
  await write(
    path.join(r.toolHome, "extensions", "extensions.json"),
    JSON.stringify([{ identifier: { id: "google.antigravity-python" }, version: "1.2.3" }], null, 2),
  );
  await write(path.join(r.toolHome, "extensions", "google.pkg-1.0.0-linux-x64", "main.js"), "BINARY");
  await write(path.join(r.toolHome, "argv.json"), JSON.stringify({ "crash-reporter-id": "MACHINE-ID" }));

  // Root A — VS Code User dir: editor prefs.
  await write(path.join(r.userDir, "settings.json"), JSON.stringify({ "editor.fontSize": 14 }, null, 2));
  await write(path.join(r.userDir, "keybindings.json"), "[]\n");
  await write(path.join(r.userDir, "snippets", "javascript.json"), JSON.stringify({}, null, 2));
  await write(path.join(r.userDir, "globalStorage", "state.vscdb"), "SQLITE-BINARY");

  // Root C — ~/.gemini: agent config (portable) sitting NEXT TO live secrets.
  await write(path.join(r.gemini, "GEMINI.md"), `# Global rules\nSkills live under ${srcBase}/.gemini/skills\n`);
  await write(path.join(r.gemini, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
  await write(
    path.join(r.gemini, "antigravity", "mcp_config.json"),
    JSON.stringify({ mcpServers: { weather: { env: { ANTHROPIC_API_KEY: GEMINI_MCP_SECRET } } } }, null, 2),
  );
  await write(path.join(r.gemini, "skills", "humanizer", "SKILL.md"), "# skill\n");

  // SECRETS + machine state that must NEVER be captured.
  await write(path.join(r.gemini, "oauth_creds.json"), JSON.stringify({ access_token: OAUTH_TOKEN }));
  await write(path.join(r.gemini, "google_accounts.json"), JSON.stringify({ email: "me@example.com" }));
  await write(path.join(r.gemini, "history", "session-1.json"), "{}\n");

  const vars = makeVariables(srcBase, "fab", "linux", r.toolHome);
  result = await capture(captureCtx(r.toolHome, vars));
});

afterAll(async () => {
  await fsp.rm(path.dirname(srcBase), { recursive: true, force: true });
});

describe("antigravity capture: portable config from all three roots", () => {
  it("captures the user-authored files under the right per-root prefixes", () => {
    const repoPaths = result.files.map((f) => f.repoPath).sort();
    expect(repoPaths).toContain("antigravity/files/extensions/extensions.json");
    expect(repoPaths).toContain("antigravity/user/settings.json");
    expect(repoPaths).toContain("antigravity/user/keybindings.json");
    expect(repoPaths).toContain("antigravity/user/snippets/javascript.json");
    expect(repoPaths).toContain("antigravity/gemini/GEMINI.md");
    expect(repoPaths).toContain("antigravity/gemini/settings.json");
    expect(repoPaths).toContain("antigravity/gemini/antigravity/mcp_config.json");
    expect(repoPaths).toContain("antigravity/gemini/skills/humanizer/SKILL.md");
  });
});

describe("antigravity capture: SECRET SAFETY (~/.gemini OAuth never leaves)", () => {
  it("never captures oauth_creds.json / google_accounts.json", () => {
    const repoPaths = result.files.map((f) => f.repoPath);
    expect(repoPaths.some((p) => p.includes("oauth_creds.json"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("google_accounts.json"))).toBe(false);
  });

  it("leaks the OAuth token into NO captured file", () => {
    for (const f of result.files) {
      if (f.binary) {
        // Check both decodings: a UTF-16LE token inside a base64 payload would
        // be invisible to a UTF-8-only scan.
        const bytes = Buffer.from(f.content, "base64");
        expect(bytes.toString("utf8")).not.toContain(OAUTH_TOKEN);
        expect(bytes.toString("utf16le")).not.toContain(OAUTH_TOKEN);
      } else {
        expect(f.content).not.toContain(OAUTH_TOKEN);
      }
    }
  });

  it("redacts the MCP env API key and reports a SecretRef", () => {
    const mcp = result.files.find((f) => f.repoPath === "antigravity/gemini/antigravity/mcp_config.json");
    expect(mcp).toBeDefined();
    expect(mcp!.content).not.toContain(GEMINI_MCP_SECRET);
    expect(result.secrets.length).toBeGreaterThan(0);
  });
});

describe("antigravity capture: excludes machine-local state", () => {
  it("drops extension binaries, argv.json, globalStorage, and history", () => {
    const repoPaths = result.files.map((f) => f.repoPath);
    expect(repoPaths.some((p) => p.includes("google.pkg-1.0.0"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("argv.json"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("globalStorage"))).toBe(false);
    expect(repoPaths.some((p) => p.includes("history/"))).toBe(false);
  });
});

describe("antigravity capture: cross-machine path templating", () => {
  it("folds the source home to {{HOME}} in GEMINI.md", () => {
    const gemini = result.files.find((f) => f.repoPath === "antigravity/gemini/GEMINI.md");
    expect(gemini!.content).not.toContain(srcBase);
    expect(gemini!.content).toContain("{{HOME}}");
  });
});

describe("antigravity: post-2.0 'Antigravity IDE' dir variant", () => {
  // The 2.0 update moved some installs to ~/.antigravity-ide + "Antigravity IDE"
  // User data (Windows migration, Google AI forum May 2026). Capture must find
  // those when the classic dirs are absent, and restore must write into them
  // when they exist rather than resurrecting the classic layout.
  it("captures from and restores into the IDE-variant dirs", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-agy-ide-"));
    try {
      const src = path.join(tmp, "src");
      const srcToolHome = path.join(src, ".antigravity"); // classic — NOT created
      await write(path.join(src, ".antigravity-ide", "extensions", "extensions.json"), "[]\n");
      await write(
        path.join(src, ".config", "Antigravity IDE", "User", "settings.json"),
        JSON.stringify({ "editor.fontSize": 13 }, null, 2),
      );

      const res = await capture(captureCtx(srcToolHome, makeVariables(src, "fab", "linux", srcToolHome)));
      const repoPaths = res.files.map((f) => f.repoPath);
      expect(repoPaths).toContain("antigravity/files/extensions/extensions.json");
      expect(repoPaths).toContain("antigravity/user/settings.json");

      // Restore into a machine that already has the IDE-variant dirs: files must
      // land THERE, and the classic dirs must not be created.
      const dst = path.join(tmp, "dst");
      const dstToolHome = path.join(dst, ".antigravity");
      await fsp.mkdir(path.join(dst, ".antigravity-ide"), { recursive: true });
      await fsp.mkdir(path.join(dst, ".config", "Antigravity IDE", "User"), { recursive: true });
      await restore(restoreCtx(dstToolHome, makeVariables(dst, "other", "linux", dstToolHome)), {
        manifest: res.manifest,
        files: res.files,
        symlinks: res.symlinks,
      });

      expect(
        await realFs.statKind(path.join(dst, ".antigravity-ide", "extensions", "extensions.json")),
      ).toBe("file");
      expect(
        await realFs.statKind(path.join(dst, ".config", "Antigravity IDE", "User", "settings.json")),
      ).toBe("file");
      expect(await realFs.statKind(path.join(dst, ".antigravity"))).toBe("missing");
      expect(await realFs.statKind(path.join(dst, ".config", "Antigravity"))).toBe("missing");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("antigravity restore: round-trip into fresh roots", () => {
  it("writes each root's files back with {{HOME}} expanded to the target", async () => {
    const d = roots(dstBase);
    const vars = makeVariables(dstBase, "newuser", "linux", d.toolHome);
    const data: RestoreData = {
      manifest: result.manifest,
      files: result.files,
      symlinks: result.symlinks,
    };
    await restore(restoreCtx(d.toolHome, vars), data);

    // Files landed in the correct per-root destinations.
    expect((await realFs.statKind(path.join(d.toolHome, "extensions", "extensions.json")))).toBe("file");
    expect((await realFs.statKind(path.join(d.userDir, "settings.json")))).toBe("file");
    expect((await realFs.statKind(path.join(d.gemini, "antigravity", "mcp_config.json")))).toBe("file");

    // GEMINI.md path rehydrated to THIS machine; MCP secret still redacted.
    const gemini = await fsp.readFile(path.join(d.gemini, "GEMINI.md"), "utf8");
    expect(gemini).toContain(`${dstBase}/.gemini/skills`);
    expect(gemini).not.toContain(srcBase);
    const mcp = await fsp.readFile(path.join(d.gemini, "antigravity", "mcp_config.json"), "utf8");
    expect(mcp).not.toContain(GEMINI_MCP_SECRET);

    // The OAuth secret was never captured, so it can never be restored.
    expect((await realFs.statKind(path.join(d.gemini, "oauth_creds.json")))).toBe("missing");
  });
});
