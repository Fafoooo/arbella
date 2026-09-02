/**
 * Unit tests for the claude/files/ symlink gate in src/adapters/claude/restore.ts
 * (CodeRabbit finding on PR #8-era restore.ts ~L152).
 *
 * writeOne() writes `claude/files/<rel>` destinations with `ctx.fs.write` /
 * `writeBytes`, which FOLLOW any existing symlink component below the tool
 * home. That is exactly what `~/.claude/skills/<name>` needs — it is
 * legitimately a symlink into the shared skills root `~/.agents/skills/<name>`
 * under the skills.sh layout, and writing the frozen skill through it updates
 * the canonical skill on purpose — but it is also how a symlink planted
 * anywhere else under the tool home (e.g. `~/.claude/hooks -> /etc`) could
 * redirect a "repo" pull to write outside `~/.claude` entirely.
 *
 * These tests pin the gate: the shared-skills link is honored, every other
 * symlink is refused with a warning and nothing lands outside the tool home,
 * and `planActions` (the --dry-run path) agrees with what `restore` actually
 * does.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { restore as restoreClaude, planActions } from "../../src/adapters/claude/restore.js";
import { REPO_PREFIX } from "../../src/adapters/claude/paths.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import type { RestoreContext } from "../../src/adapters/adapter.interface.js";
import type { CapturedFile } from "../../src/types.js";

const sanitizer = createSanitizer();
const templater = createTemplater();

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-claude-restore-symlinks-"));
  // Resolve macOS's /var -> /private/var (and any other tmpdir symlink) up
  // front, so every path built from tmpRoot already matches what
  // ctx.fs.realPath() reports for a symlink underneath it — the gate compares
  // a REAL path against the shared-skills root, and an unresolved tmp root
  // would make every "legitimate link" assertion fail on macOS for reasons
  // that have nothing to do with the gate itself.
  tmpRoot = await fsp.realpath(dir);
  warnings = [];
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function restoreCtx(
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
    repoToolDir: path.join(tmpRoot, "repo", "claude"),
    repoRoot: path.join(tmpRoot, "repo"),
    sourceOfTruth: "repo",
    dryRun: false,
    ...overrides,
  };
}

function skillFile(name: string, basename: string, content: string): CapturedFile {
  return { repoPath: `${REPO_PREFIX}/skills/${name}/${basename}`, content };
}

function hookFile(basename: string, content: string): CapturedFile {
  return { repoPath: `${REPO_PREFIX}/hooks/${basename}`, content };
}

describe("claude restore: claude/files/ symlink gate", () => {
  it("writes THROUGH the legitimate skills.sh link into the shared skills root", async () => {
    const home = path.join(tmpRoot, "home");
    const toolHome = path.join(home, ".claude");
    const sharedSkill = path.join(home, ".agents", "skills", "foo");
    await fsp.mkdir(sharedSkill, { recursive: true });
    await fsp.mkdir(path.join(toolHome, "skills"), { recursive: true });
    // skills.sh layout: ~/.claude/skills/foo -> ../../.agents/skills/foo
    await fsp.symlink(
      path.join("..", "..", ".agents", "skills", "foo"),
      path.join(toolHome, "skills", "foo"),
    );

    const file = skillFile("foo", "SKILL.md", "# Foo skill\n");
    await restoreClaude(restoreCtx(toolHome, home), {
      manifest: emptyManifest("claude"),
      files: [file],
      symlinks: [],
    });

    expect(await fsp.readFile(path.join(sharedSkill, "SKILL.md"), "utf8")).toBe("# Foo skill\n");
    // Only the symlink gate matters here; an unrelated "claude CLI not found"
    // warning appears on CI runners that have no `claude` binary on PATH.
    expect(warnings.filter((w) => w.includes("symlink"))).toEqual([]);
  });

  it("refuses to write through a planted symlink elsewhere under the tool home", async () => {
    const home = path.join(tmpRoot, "home-hooks");
    const toolHome = path.join(home, ".claude");
    const outside = path.join(tmpRoot, "outside-hooks");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(toolHome, { recursive: true });
    // Planted symlink: ~/.claude/hooks -> somewhere outside ~/.claude entirely.
    await fsp.symlink(outside, path.join(toolHome, "hooks"));

    const file = hookFile("x.sh", "#!/bin/sh\necho pwned\n");
    await restoreClaude(restoreCtx(toolHome, home), {
      manifest: emptyManifest("claude"),
      files: [file],
      symlinks: [],
    });

    expect(await realFs.exists(path.join(outside, "x.sh"))).toBe(false);
    expect(await realFs.exists(path.join(toolHome, "hooks", "x.sh"))).toBe(false);
    expect(warnings.some((w) => w.includes("hooks/x.sh") && w.includes("symlink"))).toBe(true);
  });

  it("refuses a skills/<name> link that resolves outside the shared skills root", async () => {
    const home = path.join(tmpRoot, "home-evil-skill");
    const toolHome = path.join(home, ".claude");
    const outside = path.join(tmpRoot, "outside-evil-skill");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(path.join(toolHome, "skills"), { recursive: true });
    // Looks like a skill link, but does NOT resolve into ~/.agents/skills.
    await fsp.symlink(outside, path.join(toolHome, "skills", "evil"));

    const file = skillFile("evil", "SKILL.md", "# should not land\n");
    await restoreClaude(restoreCtx(toolHome, home), {
      manifest: emptyManifest("claude"),
      files: [file],
      symlinks: [],
    });

    expect(await realFs.exists(path.join(outside, "SKILL.md"))).toBe(false);
    expect(
      warnings.some((w) => w.includes("skills/evil/SKILL.md") && w.includes("symlink")),
    ).toBe(true);
  });

  it("planActions omits the refused writes so --dry-run matches restore", async () => {
    const home = path.join(tmpRoot, "home-plan");
    const toolHome = path.join(home, ".claude");
    const outside = path.join(tmpRoot, "outside-plan");
    const sharedSkill = path.join(home, ".agents", "skills", "foo");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(sharedSkill, { recursive: true });
    await fsp.mkdir(path.join(toolHome, "skills"), { recursive: true });
    await fsp.symlink(outside, path.join(toolHome, "hooks"));
    await fsp.symlink(
      path.join("..", "..", ".agents", "skills", "foo"),
      path.join(toolHome, "skills", "foo"),
    );

    const goodSkillFile = skillFile("foo", "SKILL.md", "# Foo skill\n");
    const badHookFile = hookFile("x.sh", "#!/bin/sh\n");

    const actions = await planActions(restoreCtx(toolHome, home), {
      manifest: emptyManifest("claude"),
      files: [goodSkillFile, badHookFile],
      symlinks: [],
    });

    const paths = actions.map((a) => a.description);
    expect(paths.some((d) => d.includes("skills/foo/SKILL.md"))).toBe(true);
    expect(paths.some((d) => d.includes("hooks/x.sh"))).toBe(false);
  });
});
