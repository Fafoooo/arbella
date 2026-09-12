/**
 * Unit tests for the shared write-containment gate (src/utils/safe-path.ts,
 * `resolveContainedTarget`) as it is applied by the restore paths OUTSIDE the
 * Claude adapter: codex, the shared config-dir engine (opencode/copilot/kilo)
 * and cursor.
 *
 * Two things a backup repo controls could otherwise put a pull's writes outside
 * the tool home it names:
 *   - the repoPath itself. `codex/files/../../x` is decomposed and joined onto
 *     ~/.codex by a bare `path.join`, which happily walks out of it; the
 *     mixed-separator `cursor/files/..\escape` is normalized to `../escape`
 *     first and does the same.
 *   - a symlinked component ON THIS MACHINE. A traversal-free
 *     `codex/files/prompts/x.md` still lands wherever `~/.codex/prompts`
 *     happens to point, and `fs.write` follows that link without a word.
 *
 * Each case is asserted three ways: nothing lands outside the tool home, the
 * refusal is a WARNING that names the offending repoPath (so the user can fix
 * their repo), and the planner omits the same target — a `--dry-run` that
 * advertises a write the restore then declines is its own bug.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { itPosixHost } from "../helpers/platform.js";

import {
  restore as restoreCodex,
  planActions as codexPlanActions,
} from "../../src/adapters/codex/restore.js";
import {
  restoreConfigDir,
  planConfigDirActions,
  type ConfigDirSpec,
} from "../../src/adapters/shared/configDir.js";
import {
  restore as restoreCursor,
  planActions as cursorPlanActions,
} from "../../src/adapters/cursor/index.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import type { RestoreContext, RestoreData } from "../../src/adapters/adapter.interface.js";
import type { CapturedFile, ToolId } from "../../src/types.js";

const sanitizer = createSanitizer();
const templater = createTemplater();

/** The shared engine only reads `tool` on the restore side. */
const OPENCODE_SPEC: ConfigDirSpec = { tool: "opencode", frozenPaths: [] };

let tmpRoot: string;
let warnings: string[];

function silentLog() {
  return {
    info() {},
    success() {},
    warn(msg: string) {
      warnings.push(msg);
    },
    error() {},
    step() {},
    debug() {},
  };
}

beforeEach(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-restore-containment-"));
  // macOS's /var -> /private/var: resolve up front so every path built here is
  // the one the fs service reports back.
  tmpRoot = await fsp.realpath(dir);
  warnings = [];
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function ctxFor(
  tool: ToolId,
  toolHome: string,
  home: string,
  overrides: Partial<RestoreContext> = {},
): RestoreContext {
  return {
    fs: realFs,
    log: silentLog(),
    sanitizer,
    templater,
    vars: makeVariables(home, "fab", "linux", toolHome),
    os: "linux",
    env: {},
    toolHome,
    repoToolDir: path.join(tmpRoot, "repo", tool),
    repoRoot: path.join(tmpRoot, "repo"),
    sourceOfTruth: "repo",
    dryRun: false,
    ...overrides,
  };
}

function dataWith(tool: ToolId, files: CapturedFile[]): RestoreData {
  return { manifest: emptyManifest(tool), files, symlinks: [] };
}

/** A tool home under a fresh subdir of tmpRoot, plus its $HOME. */
async function makeHome(name: string, dotdir: string): Promise<{ home: string; toolHome: string }> {
  const home = path.join(tmpRoot, name);
  const toolHome = path.join(home, dotdir);
  await fsp.mkdir(toolHome, { recursive: true });
  return { home, toolHome };
}

describe("codex restore: repoPath containment", () => {
  it("refuses a `..` traversal and writes nothing outside the tool home", async () => {
    const { home, toolHome } = await makeHome("codex-dotdot", ".codex");
    const repoPath = "codex/files/../../escaped.txt";

    const ctx = ctxFor("codex", toolHome, home);
    const data = dataWith("codex", [{ repoPath, content: "pwned\n" }]);

    const actions = await codexPlanActions(ctx, data);
    await restoreCodex(ctx, data);

    expect(await realFs.exists(path.join(tmpRoot, "escaped.txt"))).toBe(false);
    expect(await realFs.exists(path.join(home, "escaped.txt"))).toBe(false);
    expect(warnings.some((w) => w.includes(repoPath))).toBe(true);
    expect(actions.filter((a) => a.type === "write-file")).toEqual([]);
  });

  it("refuses a backslash traversal (mixed separators) the same way", async () => {
    const { home, toolHome } = await makeHome("codex-backslash", ".codex");
    const repoPath = "codex/files/..\\..\\escaped.txt";

    const ctx = ctxFor("codex", toolHome, home);
    const data = dataWith("codex", [{ repoPath, content: "pwned\n" }]);

    const actions = await codexPlanActions(ctx, data);
    await restoreCodex(ctx, data);

    expect(await realFs.exists(path.join(tmpRoot, "escaped.txt"))).toBe(false);
    expect(warnings.some((w) => w.includes(repoPath))).toBe(true);
    expect(actions.filter((a) => a.type === "write-file")).toEqual([]);
  });

  itPosixHost("refuses a planted directory symlink under the codex home", async () => {
    const { home, toolHome } = await makeHome("codex-link", ".codex");
    const outside = path.join(tmpRoot, "codex-outside");
    await fsp.mkdir(outside, { recursive: true });
    // ~/.codex/prompts -> somewhere outside ~/.codex entirely.
    await fsp.symlink(outside, path.join(toolHome, "prompts"), "dir");

    const repoPath = "codex/files/prompts/x.md";
    const ctx = ctxFor("codex", toolHome, home);
    const data = dataWith("codex", [{ repoPath, content: "# prompt\n" }]);

    const actions = await codexPlanActions(ctx, data);
    await restoreCodex(ctx, data);

    expect(await realFs.exists(path.join(outside, "x.md"))).toBe(false);
    expect(warnings.some((w) => w.includes(repoPath) && w.includes("symlink"))).toBe(true);
    expect(actions.filter((a) => a.type === "write-file")).toEqual([]);
  });

  it("still writes an ordinary file (the gate is not a blanket refusal)", async () => {
    const { home, toolHome } = await makeHome("codex-ok", ".codex");
    const ctx = ctxFor("codex", toolHome, home);
    const data = dataWith("codex", [
      { repoPath: "codex/files/prompts/x.md", content: "# prompt\n" },
    ]);

    const actions = await codexPlanActions(ctx, data);
    await restoreCodex(ctx, data);

    expect(await fsp.readFile(path.join(toolHome, "prompts", "x.md"), "utf8")).toBe("# prompt\n");
    expect(actions.filter((a) => a.type === "write-file")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

describe("config-dir restore (opencode): repoPath containment", () => {
  it("refuses `..` and backslash traversals, and the plan omits them", async () => {
    const { home, toolHome } = await makeHome("opencode-escape", ".config-opencode");
    const dotdot = "opencode/files/../../escaped.txt";
    const backslash = "opencode/files/..\\escaped-2.txt";

    const ctx = ctxFor("opencode", toolHome, home);
    const data = dataWith("opencode", [
      { repoPath: dotdot, content: "pwned\n" },
      { repoPath: backslash, content: "pwned\n" },
    ]);

    const actions = await planConfigDirActions(ctx, data, OPENCODE_SPEC);
    await restoreConfigDir(ctx, data, OPENCODE_SPEC);

    expect(await realFs.exists(path.join(tmpRoot, "escaped.txt"))).toBe(false);
    expect(await realFs.exists(path.join(home, "escaped-2.txt"))).toBe(false);
    expect(warnings.some((w) => w.includes(dotdot))).toBe(true);
    expect(warnings.some((w) => w.includes(backslash))).toBe(true);
    expect(actions).toEqual([]);
  });

  itPosixHost("refuses a planted directory symlink under the config home", async () => {
    const { home, toolHome } = await makeHome("opencode-link", ".config-opencode");
    const outside = path.join(tmpRoot, "opencode-outside");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.symlink(outside, path.join(toolHome, "agent"), "dir");

    const repoPath = "opencode/files/agent/reviewer.md";
    const ctx = ctxFor("opencode", toolHome, home);
    const data = dataWith("opencode", [{ repoPath, content: "# reviewer\n" }]);

    const actions = await planConfigDirActions(ctx, data, OPENCODE_SPEC);
    await restoreConfigDir(ctx, data, OPENCODE_SPEC);

    expect(await realFs.exists(path.join(outside, "reviewer.md"))).toBe(false);
    expect(warnings.some((w) => w.includes(repoPath) && w.includes("symlink"))).toBe(true);
    expect(actions).toEqual([]);
  });
});

describe("cursor restore: repoPath containment", () => {
  it("refuses a `..` traversal and the plan omits it", async () => {
    const { home, toolHome } = await makeHome("cursor-escape", ".cursor");
    const repoPath = "cursor/files/../../escaped.txt";

    const ctx = ctxFor("cursor", toolHome, home);
    const data = dataWith("cursor", [{ repoPath, content: "pwned\n" }]);

    const actions = await cursorPlanActions(ctx, data);
    await restoreCursor(ctx, data);

    expect(await realFs.exists(path.join(tmpRoot, "escaped.txt"))).toBe(false);
    expect(warnings.some((w) => w.includes(repoPath))).toBe(true);
    expect(actions.filter((a) => a.type === "write-file")).toEqual([]);
  });

  itPosixHost("refuses a planted directory symlink under ~/.cursor", async () => {
    const { home, toolHome } = await makeHome("cursor-link", ".cursor");
    const outside = path.join(tmpRoot, "cursor-outside");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.symlink(outside, path.join(toolHome, "rules"), "dir");

    const repoPath = "cursor/files/rules/team.mdc";
    const ctx = ctxFor("cursor", toolHome, home);
    const data = dataWith("cursor", [{ repoPath, content: "# rule\n" }]);

    const actions = await cursorPlanActions(ctx, data);
    await restoreCursor(ctx, data);

    expect(await realFs.exists(path.join(outside, "team.mdc"))).toBe(false);
    expect(warnings.some((w) => w.includes(repoPath) && w.includes("symlink"))).toBe(true);
    expect(actions.filter((a) => a.type === "write-file")).toEqual([]);
  });
});

describe("codex restore: plan and execution agree under sourceOfTruth=local", () => {
  it("omits the write the restore then skips, and keeps the local file", async () => {
    const { home, toolHome } = await makeHome("codex-local", ".codex");
    const local = path.join(toolHome, "config.toml");
    await fsp.writeFile(local, 'model = "local"\n');

    const ctx = ctxFor("codex", toolHome, home, { sourceOfTruth: "local" });
    const data = dataWith("codex", [
      { repoPath: "codex/files/config.toml", content: 'model = "from-repo"\n' },
    ]);

    const actions = await codexPlanActions(ctx, data);
    await restoreCodex(ctx, data);

    expect(actions.filter((a) => a.type === "write-file")).toEqual([]);
    expect(await fsp.readFile(local, "utf8")).toBe('model = "local"\n');
  });

  it("still plans (and performs) the write when the file is absent", async () => {
    const { home, toolHome } = await makeHome("codex-local-new", ".codex");
    const ctx = ctxFor("codex", toolHome, home, { sourceOfTruth: "local" });
    const data = dataWith("codex", [
      { repoPath: "codex/files/config.toml", content: 'model = "from-repo"\n' },
    ]);

    const actions = await codexPlanActions(ctx, data);
    await restoreCodex(ctx, data);

    expect(actions.filter((a) => a.type === "write-file")).toHaveLength(1);
    expect(await fsp.readFile(path.join(toolHome, "config.toml"), "utf8")).toBe(
      'model = "from-repo"\n',
    );
  });
});
