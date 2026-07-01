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
import {
  GEMINI_FROZEN_PATHS,
  antigravityHomeCandidates,
  antigravityUserDir,
  antigravityUserDirCandidates,
} from "../../src/adapters/antigravity/paths.js";
import { denylistFor } from "../../src/core/sanitizer/denylist.js";
import { cliBinaryName, installCommandFor, toolHomeDir } from "../../src/platform/os.js";
import { getDependency } from "../../src/platform/install.js";
import { toolRepoDataRoots } from "../../src/commands/backup.js";
import { safetySourcesForTool } from "../../src/commands/restore.js";

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

  it("probes the post-2.0 'Antigravity IDE' variant first, classic name second", () => {
    // The 2.0 update split the dirs on some platforms (Google AI forum, May 2026);
    // a migrated machine's live data sits in the IDE-variant, so it wins when both
    // exist, while the classic name (verified live on macOS 2.0.6) is the default.
    expect(antigravityUserDirCandidates("/home/fab/.antigravity", "linux", {})).toEqual([
      path.join("/home/fab", ".config", "Antigravity IDE", "User"),
      path.join("/home/fab", ".config", "Antigravity", "User"),
    ]);
    expect(antigravityHomeCandidates("/home/fab/.antigravity")).toEqual([
      path.join("/home/fab", ".antigravity-ide"),
      path.join("/home/fab", ".antigravity"),
    ]);
  });
});

describe("multi-root tools: backup mirror + R14 safety-backup wiring", () => {
  // Regression guards for the PR #7 review: every root a multi-root adapter OWNS
  // must be (a) wiped-and-rewritten by backup so deleted files can't resurrect,
  // and (b) snapshotted by the pre-restore safety backup so a repo-wins pull
  // can't overwrite local data without a fallback copy.

  it("backup mirrors ALL of antigravity's repo data roots", () => {
    expect(toolRepoDataRoots("antigravity")).toEqual([
      "antigravity/files",
      "antigravity/user",
      "antigravity/gemini",
    ]);
    // Existing behavior stays intact:
    expect(toolRepoDataRoots("cursor")).toEqual(["cursor/files", "cursor/user"]);
    expect(toolRepoDataRoots("claude")).toEqual(["claude/files"]);
  });

  it("safety backup snapshots BOTH antigravity dir variants and gemini restore targets", () => {
    const labels = safetySourcesForTool("antigravity", "linux", "stamp").map((s) => s.label);
    expect(labels).toContain("antigravity home");
    expect(labels).toContain("antigravity home (.antigravity-ide)");
    expect(labels).toContain("antigravity User data (Antigravity IDE)");
    expect(labels).toContain("antigravity User data (Antigravity)");
    for (const rel of GEMINI_FROZEN_PATHS) {
      expect(labels).toContain(`antigravity gemini ${rel}`);
    }
  });

  it("safety backup snapshots ONLY the gemini frozen paths, never the whole ~/.gemini", () => {
    // ~/.gemini is shared with the Gemini CLI and holds OAuth tokens + a browser
    // profile — a whole-dir snapshot would bulk-copy those. Every gemini source
    // must point BELOW ~/.gemini, never at the dir itself.
    const sources = safetySourcesForTool("antigravity", "linux", "stamp");
    const gemini = sources.filter((s) => s.label.startsWith("antigravity gemini "));
    expect(gemini.length).toBe(GEMINI_FROZEN_PATHS.length);
    for (const s of gemini) {
      expect(path.basename(s.source)).not.toBe(".gemini");
      expect(s.source.includes(`${path.sep}.gemini${path.sep}`)).toBe(true);
    }
  });

  it("cursor's safety backup still covers its User dir (no regression)", () => {
    const labels = safetySourcesForTool("cursor", "linux", "stamp").map((s) => s.label);
    expect(labels).toContain("cursor home");
    expect(labels).toContain("cursor User data");
  });
});
