/**
 * Unit tests for stripping arbella's autobackup hook from captured files, so a
 * pushed backup never carries the hook that would auto-push on another machine.
 */

import { describe, expect, it } from "vitest";

import {
  HOOK_TAG,
  withoutAutobackupHook,
  withoutAutobackupHookInResult,
} from "../../src/core/autobackup/hook.js";
import type { CapturedFile, CaptureResult } from "../../src/types.js";

const POSIX = `arbella push --auto >/dev/null 2>&1 & # ${HOOK_TAG}`;
const WIN = `start /b "" arbella push --auto >NUL 2>&1 :: ${HOOK_TAG}`;
const USER_CMD = "echo hello";

const group = (command: string) => ({ hooks: [{ type: "command", command }] });
const file = (repoPath: string, value: unknown, tail = "\n"): CapturedFile => ({
  repoPath,
  content: JSON.stringify(value, null, 2) + tail,
});
const parse = (f: CapturedFile) => JSON.parse(f.content) as Record<string, any>;

describe("withoutAutobackupHook", () => {
  it.each([
    ["POSIX", POSIX],
    ["win32 ::", WIN],
  ])("removes only the tagged SessionStart group (%s tag)", (_n, cmd) => {
    const f = file("claude/files/settings.json", {
      theme: "dark",
      hooks: { SessionStart: [group(USER_CMD), group(cmd)] },
    });
    const out = withoutAutobackupHook(f);
    expect(parse(out).hooks.SessionStart).toEqual([group(USER_CMD)]);
    expect(parse(out).theme).toBe("dark");
    expect(out.repoPath).toBe(f.repoPath);
  });

  it("keeps user hooks on other events", () => {
    const f = file("codex/files/hooks.json", {
      hooks: { SessionStart: [group(POSIX)], Stop: [group(USER_CMD)] },
    });
    expect(parse(withoutAutobackupHook(f)).hooks).toEqual({ Stop: [group(USER_CMD)] });
  });

  it("drops the emptied hooks object like uninstallHook does", () => {
    const f = file("codex/files/hooks.json", { hooks: { SessionStart: [group(POSIX)] } });
    expect(parse(withoutAutobackupHook(f)).hooks).toEqual({});
  });

  it("preserves indent and trailing-newline state", () => {
    const base = { hooks: { SessionStart: [group(POSIX)] } };
    const tab = { repoPath: "claude/files/settings.json", content: JSON.stringify(base, null, "\t") };
    const out = withoutAutobackupHook(tab);
    expect(out.content.endsWith("\n")).toBe(false);
    expect(out.content).toBe(JSON.stringify({ hooks: {} }, null, "\t"));
    const nl = file("claude/files/settings.json", base);
    expect(withoutAutobackupHook(nl).content.endsWith("\n")).toBe(true);
  });

  it("does not mutate its input and keeps extra fields like mode", () => {
    const f = { ...file("claude/files/settings.json", { hooks: { SessionStart: [group(POSIX)] } }), mode: 0o600 };
    const before = f.content;
    const out = withoutAutobackupHook(f);
    expect(f.content).toBe(before);
    expect(out).not.toBe(f);
    expect(out.mode).toBe(0o600);
  });

  it("leaves other files, binary, invalid JSON and hook-free files untouched", () => {
    const other = file("claude/files/other.json", { hooks: { SessionStart: [group(POSIX)] } });
    const binary: CapturedFile = { ...file("claude/files/settings.json", { a: POSIX }), binary: true };
    const invalid: CapturedFile = { repoPath: "codex/files/hooks.json", content: `{ nope ${HOOK_TAG}` };
    const clean = file("claude/files/settings.json", { hooks: { SessionStart: [group(USER_CMD)] } });
    for (const f of [other, binary, invalid, clean]) expect(withoutAutobackupHook(f)).toBe(f);
  });
});

describe("withoutAutobackupHookInResult", () => {
  it("returns a new result with stripped files and leaves the rest alone", () => {
    const settings = file("claude/files/settings.json", { hooks: { SessionStart: [group(POSIX)] } });
    const md: CapturedFile = { repoPath: "claude/files/CLAUDE.md", content: "hi" };
    const r = {
      tool: "claude",
      files: [settings, md],
      symlinks: [],
      manifest: {},
      secrets: [],
      warnings: ["w"],
    } as unknown as CaptureResult;
    const out = withoutAutobackupHookInResult(r);
    expect(out).not.toBe(r);
    expect(r.files[0]).toBe(settings);
    expect(parse(out.files[0]!).hooks).toEqual({});
    expect(out.files[1]).toBe(md);
    expect(out.warnings).toEqual(["w"]);
  });
});
