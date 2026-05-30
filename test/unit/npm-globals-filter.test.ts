/**
 * Unit tests for the npm-globals platform filter — the conservative heuristic
 * that keeps restore from trying to reinstall platform-specific native builds
 * (e.g. `@scope/tui-darwin-arm64` on Linux), which only ever install on their
 * own OS. (The "never reinstall arbella itself" rule is covered by the capture
 * ignore-list + the restore dedupe filter.)
 */
import { describe, it, expect } from "vitest";

import { isForeignPlatformPackage } from "../../src/platform/install.js";

describe("isForeignPlatformPackage", () => {
  it("flags a *-darwin-arm64 build as foreign on linux + win32, native on darwin", () => {
    const pkg = "@skillsgate/tui-darwin-arm64";
    expect(isForeignPlatformPackage(pkg, "linux")).toBe(true);
    expect(isForeignPlatformPackage(pkg, "win32")).toBe(true);
    expect(isForeignPlatformPackage(pkg, "darwin")).toBe(false);
  });

  it("flags win32 / linux builds as foreign on the other OSes only", () => {
    expect(isForeignPlatformPackage("esbuild-win32-x64", "linux")).toBe(true);
    expect(isForeignPlatformPackage("esbuild-win32-x64", "darwin")).toBe(true);
    expect(isForeignPlatformPackage("esbuild-win32-x64", "win32")).toBe(false);

    expect(isForeignPlatformPackage("@foo/bar-linux-x64", "darwin")).toBe(true);
    expect(isForeignPlatformPackage("@foo/bar-linux-x64", "win32")).toBe(true);
    expect(isForeignPlatformPackage("@foo/bar-linux-x64", "linux")).toBe(false);
  });

  it("never mistakes ordinary package names for platform builds", () => {
    for (const os of ["darwin", "linux", "win32"] as const) {
      expect(isForeignPlatformPackage("winston", os)).toBe(false);
      expect(isForeignPlatformPackage("macaron", os)).toBe(false);
      expect(isForeignPlatformPackage("typescript", os)).toBe(false);
      expect(isForeignPlatformPackage("@anthropic-ai/claude-code", os)).toBe(false);
      expect(isForeignPlatformPackage("@openai/codex", os)).toBe(false);
      expect(isForeignPlatformPackage("greppy", os)).toBe(false);
    }
  });
});
