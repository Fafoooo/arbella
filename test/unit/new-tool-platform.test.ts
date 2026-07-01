/**
 * Unit tests for the platform + denylist wiring of the new tools
 * (opencode, copilot, kilo): home-dir resolution, CLI binary names, install
 * commands, and per-tool denylists.
 *
 * toolHomeDir reads process.env + the detected OS; these tests run on the CI
 * linux box, so they assert the XDG/posix branch and the env-override behavior
 * that is OS-independent.
 */

import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cliBinaryName,
  installCommandFor,
  toolHomeDir,
} from "../../src/platform/os.js";
import { denylistFor } from "../../src/core/sanitizer/denylist.js";
import { TOOL_IDS } from "../../src/types.js";

const savedEnv = { ...process.env };

afterEach(() => {
  // Restore any env vars the tests mutated.
  process.env = { ...savedEnv };
});

describe("new tools: registry + canonical order", () => {
  it("registers opencode, copilot, kilo, antigravity after the original trio", () => {
    expect(TOOL_IDS).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "copilot",
      "kilo",
      "antigravity",
    ]);
  });
});

describe("toolHomeDir for config-dir tools", () => {
  it("opencode + kilo honor XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/mnt/cfg";
    delete process.env.APPDATA;
    // Only meaningful off win32; the CI runner is linux.
    if (process.platform !== "win32") {
      expect(toolHomeDir("opencode")).toBe(path.join("/mnt/cfg", "opencode"));
      expect(toolHomeDir("kilo")).toBe(path.join("/mnt/cfg", "kilo"));
    }
  });

  it("copilot honors COPILOT_HOME on every OS", () => {
    process.env.COPILOT_HOME = path.join("/custom", "copilot-home");
    expect(toolHomeDir("copilot")).toBe(path.join("/custom", "copilot-home"));
  });
});

describe("cliBinaryName", () => {
  it("maps each new tool to its CLI binary", () => {
    expect(cliBinaryName("opencode")).toBe("opencode");
    expect(cliBinaryName("copilot")).toBe("copilot");
    expect(cliBinaryName("kilo")).toBe("kilo");
  });
});

describe("installCommandFor (npm globals on every OS)", () => {
  for (const os of ["linux", "darwin", "win32"] as const) {
    it(`installs the new tools via npm on ${os}`, () => {
      expect(installCommandFor("opencode", os)).toEqual({
        cmd: "npm",
        args: ["install", "-g", "opencode-ai"],
      });
      expect(installCommandFor("copilot", os)).toEqual({
        cmd: "npm",
        args: ["install", "-g", "@github/copilot"],
      });
      expect(installCommandFor("kilo", os)).toEqual({
        cmd: "npm",
        args: ["install", "-g", "@kilocode/cli"],
      });
    });
  }
});

describe("denylistFor", () => {
  it("opencode + kilo exclude plugin-install artifacts and skills", () => {
    for (const tool of ["opencode", "kilo"] as const) {
      const deny = denylistFor(tool);
      expect(deny).toContain("node_modules/");
      expect(deny).toContain("package.json");
      expect(deny).toContain("bun.lock");
      expect(deny).toContain("skills/");
    }
  });

  it("copilot excludes session/log state and command history", () => {
    const deny = denylistFor("copilot");
    expect(deny).toContain("session-state/");
    expect(deny).toContain("logs/");
    expect(deny).toContain("command-history-state.json");
    expect(deny).toContain("skills/");
  });

  it("copilot hard-denies config.json (auth/internal state)", () => {
    // Regression guard for the P1 fix: config.json must be excluded even if it
    // ever slipped into a frozen path — it holds auth data + plugin metadata.
    expect(denylistFor("copilot")).toContain("config.json");
  });
});

describe("config-dir tools resolve under ~/.config on Windows (not %APPDATA%)", () => {
  // Regression guard for the P2 fix: opencode + kilo follow the XDG convention on
  // EVERY OS. Pointing them at %APPDATA% on win32 (the old bug) made detect() miss
  // them and restore write where the CLI never reads. We fake win32 to prove the
  // %APPDATA% branch is gone.
  const withPlatform = (value: NodeJS.Platform, fn: () => void): void => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value, configurable: true });
    try {
      fn();
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  };

  it("ignores %APPDATA% and uses ~/.config even when the OS is win32", () => {
    withPlatform("win32", () => {
      process.env.APPDATA = "C:\\Users\\fab\\AppData\\Roaming";
      delete process.env.XDG_CONFIG_HOME;
      const dotConfig = path.join(os.homedir(), ".config");
      expect(toolHomeDir("opencode")).toBe(path.join(dotConfig, "opencode"));
      expect(toolHomeDir("kilo")).toBe(path.join(dotConfig, "kilo"));
      expect(toolHomeDir("opencode").startsWith(process.env.APPDATA!)).toBe(false);
    });
  });

  it("still honors XDG_CONFIG_HOME on win32", () => {
    withPlatform("win32", () => {
      process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "xdgcfg");
      expect(toolHomeDir("opencode")).toBe(path.join(process.env.XDG_CONFIG_HOME!, "opencode"));
    });
  });
});
