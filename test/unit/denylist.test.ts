/**
 * Unit tests for the path denylist (src/core/sanitizer/denylist.ts) and its main
 * consumer, listUnmanagedEntries.
 *
 * The denylist is the FIRST line of defense — a denied path is never even read
 * — so both directions matter equally:
 *   1. the noise/secret patterns really do exclude what they claim to;
 *   2. the newly-frozen Claude paths (rules/, scripts/, keybindings.json) are
 *      NOT collateral damage of a too-greedy pattern.
 * The same two lists decide what `arbella status` calls "not backed up", so that
 * probe is pinned here too.
 */

import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  COMMON_DENY,
  CLAUDE_DENY,
  denylistFor,
  firstMatchingDeny,
  matchesDeny,
} from "../../src/core/sanitizer/denylist.js";
import { listUnmanagedEntries } from "../../src/adapters/claude/paths.js";
import { fs as realFs } from "../../src/utils/fs.js";

const claude = denylistFor("claude");

describe("denylist: backup / merge droppings", () => {
  it("denies timestamped .bak-* siblings of real config files", () => {
    expect(matchesDeny("settings.json.bak-routing-20260829", claude)).toBe(true);
    expect(matchesDeny("CLAUDE.md.bak-20260101", claude)).toBe(true);
  });

  it("denies plain .bak / .orig / .rej files at any depth", () => {
    expect(matchesDeny("scripts/hooks/x.js.bak", claude)).toBe(true);
    expect(matchesDeny("rules/common/style.md.orig", claude)).toBe(true);
    expect(matchesDeny("agents/reviewer.md.rej", claude)).toBe(true);
  });

  it("denies vendored python runtimes and their bytecode", () => {
    expect(matchesDeny("security/agent-sdk-venv/bin/python", claude)).toBe(true);
    expect(matchesDeny(".venv/lib/site-packages/x.py", claude)).toBe(true);
    expect(matchesDeny("venv/pyvenv.cfg", claude)).toBe(true);
    expect(matchesDeny("scripts/__pycache__/hook.cpython-312.pyc", claude)).toBe(true);
    expect(matchesDeny("scripts/hook.pyo", claude)).toBe(true);
  });
});

describe("denylist: Claude state dirs are root-anchored", () => {
  it("denies the top-level state/noise dirs", () => {
    expect(matchesDeny("security", claude)).toBe(true);
    expect(matchesDeny("security/agent-sdk-venv/pyvenv.cfg", claude)).toBe(true);
    expect(matchesDeny("ecc", claude)).toBe(true);
    expect(matchesDeny("ecc/state.db", claude)).toBe(true);
    expect(matchesDeny("feedback/2026-01-01.json", claude)).toBe(true);
    expect(matchesDeny("plugins/cache/marketplace/x.json", claude)).toBe(true);
    expect(matchesDeny(".pi/state.json", claude)).toBe(true);
  });

  it("denies the server-pushed policy/catalog caches", () => {
    expect(matchesDeny("remote-settings.json", claude)).toBe(true);
    expect(matchesDeny("policy-limits.json", claude)).toBe(true);
    expect(matchesDeny("plugin-catalog-cache.json", claude)).toBe(true);
    expect(matchesDeny("blocklist.json", claude)).toBe(true);
  });

  it("does NOT deny a nested dir that merely shares a name with a state dir", () => {
    // The ECC rule pack really does live at ~/.claude/rules/ecc — anchoring the
    // "ecc" pattern to the home root is what keeps it capturable.
    expect(matchesDeny("rules/ecc/common/x.md", claude)).toBe(false);
    expect(matchesDeny("rules/ecc/typescript/testing.md", claude)).toBe(false);
    expect(matchesDeny("skills/feedback/SKILL.md", claude)).toBe(false);
    expect(matchesDeny("agents/security/reviewer.md", claude)).toBe(false);
  });
});

describe("denylist: newly frozen Claude paths survive", () => {
  it("keeps the files A1 added to FROZEN_PATHS", () => {
    expect(matchesDeny("keybindings.json", claude)).toBe(false);
    expect(matchesDeny("rules/common/coding-style.md", claude)).toBe(false);
    expect(matchesDeny("scripts/dispatch.sh", claude)).toBe(false);
    expect(matchesDeny("output-styles/terse.md", claude)).toBe(false);
    expect(matchesDeny("mcp-configs/serena.json", claude)).toBe(false);
    expect(matchesDeny("AGENTS.md", claude)).toBe(false);
  });
});

describe("denylist: anchoring semantics", () => {
  it("an anchored file pattern must consume the WHOLE path", () => {
    expect(matchesDeny("state.json", ["/state.json"])).toBe(true);
    expect(matchesDeny("nested/state.json", ["/state.json"])).toBe(false);
  });

  it("an unanchored pattern still matches at any depth (unchanged behavior)", () => {
    expect(matchesDeny("nested/deep/auth.json", ["auth.json"])).toBe(true);
    expect(matchesDeny("a/b/sessions/c", ["sessions/"])).toBe(true);
  });

  it("keeps the new patterns in the exported lists (wiring guard)", () => {
    expect(COMMON_DENY).toContain("*.bak-*");
    expect(COMMON_DENY).toContain("__pycache__/");
    expect(CLAUDE_DENY).toContain("/ecc/");
  });
});

describe("firstMatchingDeny: names the pattern that matched (matchesDeny with a reason)", () => {
  it("returns the exact matched pattern, verbatim, for a directory rule", () => {
    expect(firstMatchingDeny(".kube/config", [".kube/", ".aws/"])).toBe(".kube/");
  });

  it("returns the exact matched pattern for a wildcard segment rule", () => {
    expect(firstMatchingDeny("nested/auth.json", ["auth.json"])).toBe("auth.json");
    expect(firstMatchingDeny("scripts/hook.pyo", claude)).toBe("*.pyo");
  });

  it("returns null when nothing matches", () => {
    expect(firstMatchingDeny("settings.json", claude)).toBeNull();
    expect(firstMatchingDeny("config.toml", denylistFor("codex"))).toBeNull();
  });

  it("agrees with matchesDeny on every case (matchesDeny is defined in terms of it)", () => {
    for (const rel of [
      ".kube/config",
      "auth.json",
      "settings.json",
      "rules/ecc/common/x.md",
      "state.json",
    ]) {
      expect(matchesDeny(rel, claude)).toBe(firstMatchingDeny(rel, claude) !== null);
    }
  });
});

describe("listUnmanagedEntries: the status \"not backed up\" hint", () => {
  it("lists only what is neither frozen, denied, nor known state", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-unmanaged-"));
    const home = path.join(root, ".claude");
    try {
      for (const dir of [
        "agents", // frozen
        "rules", // frozen (WP-A)
        "scripts", // frozen (WP-A)
        "ecc", // denied (root-anchored)
        "plugins", // known state
        "projects", // known state
        "statsig", // denied
        "mystery-dir", // <- unmanaged
      ]) {
        await fsp.mkdir(path.join(home, dir), { recursive: true });
      }
      await fsp.writeFile(path.join(home, "keybindings.json"), "[]"); // frozen
      await fsp.writeFile(path.join(home, ".credentials.json"), "{}"); // known secret
      await fsp.writeFile(path.join(home, "remote-settings.json"), "{}"); // denied
      await fsp.writeFile(path.join(home, "notes.txt"), "hi"); // <- unmanaged

      expect(await listUnmanagedEntries(home, realFs)).toEqual([
        "mystery-dir",
        "notes.txt",
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("returns nothing for a home that does not exist", async () => {
    expect(await listUnmanagedEntries("/definitely/not/here/.claude", realFs)).toEqual([]);
  });
});
