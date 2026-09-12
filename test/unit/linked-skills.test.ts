import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const { execaMock, whichMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
  whichMock: vi.fn(),
}));
vi.mock("execa", () => ({ execa: execaMock }));
vi.mock("../../src/platform/install.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/platform/install.js")>(),
  listNpmGlobals: async () => [],
  which: whichMock,
  resolveBinaryPath: async () => null,
}));

import { capture as captureClaude } from "../../src/adapters/claude/capture.js";
import { restore as restoreClaude } from "../../src/adapters/claude/restore.js";
import { capture as captureCursor, restore as restoreCursor } from "../../src/adapters/cursor/index.js";
import { restoreHomeFiles } from "../../src/core/homefiles/restore.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { fs } from "../../src/utils/fs.js";
import type { CaptureContext, RestoreContext } from "../../src/adapters/adapter.interface.js";

let root: string;
const log = { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), debug: vi.fn() };

function context(home: string, tool: string): CaptureContext & RestoreContext {
  const toolHome = path.join(home, `.${tool}`);
  return {
    fs, log, toolHome,
    sanitizer: createSanitizer(), templater: createTemplater(),
    vars: makeVariables(home, "test", "linux", toolHome),
    os: "linux", env: {}, includeSecrets: false, includeMemories: false, dryRun: false,
    repoRoot: path.join(root, "repo"), repoToolDir: path.join(root, "repo", tool),
    sourceOfTruth: "repo",
  };
}

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-linked-skills-")));
  vi.clearAllMocks();
  whichMock.mockResolvedValue(false);
  execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

const adapters = [
  { id: "claude", capture: captureClaude, restore: restoreClaude },
  { id: "cursor", capture: captureCursor, restore: restoreCursor },
];

describe.each(adapters)("$id linked skills", ({ id, capture, restore }) => {
  it("restores a working shared skill with its contents, without an inferred installer", async () => {
    const source = context(path.join(root, "source"), id);
    const shared = path.join(source.vars.HOME, ".agents", "skills", "example");
    const link = path.join(source.toolHome, "skills", "example");
    await fsp.mkdir(shared, { recursive: true });
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.writeFile(path.join(shared, "SKILL.md"), `# Example\nLocation: ${source.vars.HOME}/.agents/skills/example\n`);
    await fsp.writeFile(path.join(shared, "settings.json"), JSON.stringify({ apiKey: "opaque-private-value" }));
    await fsp.writeFile(path.join(shared, ".env"), "PRIVATE=do-not-carry\n");
    await fsp.writeFile(path.join(shared, "run.sh"), "#!/bin/sh\nexit 0\n");
    await fsp.chmod(path.join(shared, "run.sh"), 0o755);
    // Absolute links must become portable too.
    await fsp.symlink(shared, link, "dir");
    const captured = await capture(source);
    expect(captured.manifest.skills).toContainEqual({ name: "example", source: "frozen", symlinked: true });
    expect(captured.symlinks).toContainEqual({ repoPath: `${id}/files/skills/example`, target: "../../.agents/skills/example" });
    expect(captured.files.some((file) => file.repoPath.endsWith("/.env"))).toBe(false);
    expect(JSON.stringify(captured.files)).not.toContain("opaque-private-value");

    const target = context(path.join(root, "target"), id);
    await restore(target, { ...captured, files: captured.files.filter((file) => file.repoPath.startsWith(`${id}/`)) });
    await restoreHomeFiles(target, captured.files.filter((file) => file.repoPath.startsWith("shared/home/")), { safetyDir: path.join(root, "safety") });
    const restored = path.join(target.toolHome, "skills", "example");
    expect((await fsp.lstat(restored)).isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(path.join(restored, "SKILL.md"), "utf8")).toContain(`${target.vars.HOME}/.agents/skills/example`);
    expect(JSON.parse(await fsp.readFile(path.join(restored, "settings.json"), "utf8")).apiKey).toBe("{{REDACTED}}");
    if (process.platform !== "win32") expect((await fsp.stat(path.join(restored, "run.sh"))).mode & 0o100).toBe(0o100);
    expect(execaMock.mock.calls.some(([command]) => command === "npx")).toBe(false);
  });

  it("does not follow a shared skill redirected through a second symlink", async () => {
    const source = context(path.join(root, "source"), id);
    const shared = path.join(source.vars.HOME, ".agents", "skills", "example");
    const outside = path.join(root, "outside");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(path.dirname(shared), { recursive: true });
    await fsp.mkdir(path.join(source.toolHome, "skills"), { recursive: true });
    await fsp.writeFile(path.join(outside, "SKILL.md"), "private-outside-content");
    await fsp.symlink(outside, shared, "dir");
    await fsp.symlink(shared, path.join(source.toolHome, "skills", "example"), "dir");
    const captured = await capture(source);
    expect(JSON.stringify(captured.files)).not.toContain("private-outside-content");
    expect(captured.warnings.some((warning) => warning.includes("example"))).toBe(true);
  });
});

it("reports rejected Claude marketplace, plugin and legacy skill installs as failures", async () => {
  whichMock.mockResolvedValue(true);
  execaMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "fixture installer failed" });
  const manifest = emptyManifest("claude");
  manifest.marketplaces = [{ name: "fixture", source: "owner/repo", sourceType: "github" }];
  manifest.plugins = [{ id: "example@fixture", name: "example", enabled: true, scope: "user" }];
  manifest.skills = [{ name: "example", source: "skills.sh", symlinked: true }];
  await restoreClaude(context(path.join(root, "target"), "claude"), { manifest, files: [], symlinks: [] });
  expect(log.warn.mock.calls.filter(([line]) => line.includes("fixture installer failed"))).toHaveLength(3);
  expect(log.step.mock.calls.filter(([line]) => /marketplace add|plugin install|skills add/.test(line))).toHaveLength(0);
});
