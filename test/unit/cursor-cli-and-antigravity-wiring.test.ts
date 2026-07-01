/**
 * Wiring tests for the two new integrations:
 *   - the Cursor CLI (cursor-agent), which SHARES ~/.cursor with the IDE, so it is
 *     handled by widening the existing Cursor adapter rather than a duplicate one;
 *   - Google Antigravity's platform wiring (home resolution, no auto-install, CLI
 *     binary probe, and the secret denylist that keeps ~/.gemini OAuth files out).
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";

import { FROZEN_PATHS as CURSOR_FROZEN_PATHS } from "../../src/adapters/cursor/paths.js";
import { antigravityUserDir } from "../../src/adapters/antigravity/paths.js";
import { denylistFor } from "../../src/core/sanitizer/denylist.js";
import { cliBinaryName, installCommandFor, toolHomeDir } from "../../src/platform/os.js";
import { getDependency } from "../../src/platform/install.js";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("Cursor CLI (cursor-agent) support", () => {
  it("freezes the CLI's portable config alongside the shared IDE files", () => {
    // New CLI-specific bits:
    expect(CURSOR_FROZEN_PATHS).toContain("cli-config.json");
    expect(CURSOR_FROZEN_PATHS).toContain("commands");
    expect(CURSOR_FROZEN_PATHS).toContain("rules");
    // Shared IDE + CLI bits are still captured (no regression):
    expect(CURSOR_FROZEN_PATHS).toContain("mcp.json");
    expect(CURSOR_FROZEN_PATHS).toContain("skills");
  });

  it("excludes the CLI's machine-local runtime worktrees", () => {
    const deny = denylistFor("cursor");
    expect(deny).toContain("worktrees/");
    expect(deny).toContain("worktrees.json");
  });

  it("honors CURSOR_CONFIG_DIR to relocate the shared config dir", () => {
    process.env.CURSOR_CONFIG_DIR = path.join("/custom", "cursor-cfg");
    expect(toolHomeDir("cursor")).toBe(path.join("/custom", "cursor-cfg"));
  });

  it("defaults to ~/.cursor when CURSOR_CONFIG_DIR is unset", () => {
    delete process.env.CURSOR_CONFIG_DIR;
    expect(toolHomeDir("cursor").endsWith(`${path.sep}.cursor`)).toBe(true);
  });
});

describe("Antigravity platform wiring", () => {
  it("resolves the tool home to the ~/.antigravity dotfolder", () => {
    expect(toolHomeDir("antigravity").endsWith(`${path.sep}.antigravity`)).toBe(true);
  });

  it("has no automatic install on any OS (it's a desktop download)", () => {
    for (const os of ["linux", "darwin", "win32"] as const) {
      expect(installCommandFor("antigravity", os)).toBeNull();
    }
    const spec = getDependency("antigravity");
    expect(spec.install.darwin.kind).toBe("none");
    expect(spec.install.linux.kind).toBe("none");
    expect(spec.install.win32.kind).toBe("none");
  });

  it("probes the `antigravity` launcher on PATH", () => {
    expect(cliBinaryName("antigravity")).toBe("antigravity");
  });

  it("hard-denies the ~/.gemini OAuth + account secret files", () => {
    const deny = denylistFor("antigravity");
    expect(deny).toContain("oauth_creds.json");
    expect(deny).toContain("google_accounts.json");
    expect(deny).toContain("antigravity-browser-profile/");
    expect(deny).toContain("*.pb");
  });
});

describe("Antigravity User dir resolves per OS (cross-platform)", () => {
  // The user's core concern: a capture on one OS restores to the right place on
  // another. The VS Code-style User dir is OS-specific; assert each branch. (Uses
  // POSIX-style values so path.join on the test host is deterministic — the point
  // is the darwin/linux/win32 BRANCH, not the host separator.)
  it("uses ~/Library/Application Support on macOS", () => {
    expect(antigravityUserDir("/Users/fab/.antigravity", "darwin", {})).toBe(
      path.join("/Users/fab", "Library", "Application Support", "Antigravity", "User"),
    );
  });

  it("uses ~/.config on Linux, honoring XDG_CONFIG_HOME", () => {
    expect(antigravityUserDir("/home/fab/.antigravity", "linux", {})).toBe(
      path.join("/home/fab", ".config", "Antigravity", "User"),
    );
    expect(antigravityUserDir("/home/fab/.antigravity", "linux", { XDG_CONFIG_HOME: "/xdg" })).toBe(
      path.join("/xdg", "Antigravity", "User"),
    );
  });

  it("uses %APPDATA% on Windows", () => {
    expect(antigravityUserDir("/home/fab/.antigravity", "win32", { APPDATA: "/appdata" })).toBe(
      path.join("/appdata", "Antigravity", "User"),
    );
  });
});
