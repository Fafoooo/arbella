/**
 * Unit tests for the external-tool classification core (WP-C).
 *
 * `src/core/externaltools/classify.ts` is pure (no fs/process), so every rule
 * in the classification table is exercised directly against string realpaths —
 * macOS Cellar + opt layouts, uv/pipx tool dirs, npm's node_modules (scoped and
 * unscoped), win32 `C:\Users\...` shapes, and `.exe` stripping.
 *
 * `installExternalTool` (src/platform/install.ts) is exercised with INJECTED
 * `which`/`run` fakes so nothing ever shells out for real.
 */

import { describe, it, expect, vi } from "vitest";

import {
  classifyBinaryPath,
  isRuntimeCommand,
  isSafeToolName,
  MAX_TOOL_NAME_LENGTH,
  mergeExternalTools,
  RUNTIME_COMMANDS,
  type ExternalToolRef,
} from "../../src/core/externaltools/classify.js";
import {
  externalToolInstallCommand,
  installExternalTool,
} from "../../src/platform/install.js";

const HOME_MAC = "/Users/fab";
const HOME_WIN = "C:\\Users\\fab";

/* -------------------------------------------------------------------------- */
/* classifyBinaryPath                                                          */
/* -------------------------------------------------------------------------- */

describe("classifyBinaryPath", () => {
  it("classifies a uv tool shim (macOS)", () => {
    expect(
      classifyBinaryPath(
        "/Users/fab/.local/share/uv/tools/serena-agent/bin/serena",
        HOME_MAC,
      ),
    ).toEqual({ manager: "uv", name: "serena-agent" });
  });

  it("classifies a pipx venv shim (Linux)", () => {
    expect(
      classifyBinaryPath("/home/fab/.local/pipx/venvs/greppy/bin/greppy", "/home/fab"),
    ).toEqual({ manager: "pipx", name: "greppy" });
  });

  it("classifies a Homebrew Cellar path (macOS Apple Silicon)", () => {
    expect(
      classifyBinaryPath(
        "/opt/homebrew/Cellar/projectatlas/1.2.0/bin/projectatlas",
        HOME_MAC,
      ),
    ).toEqual({ manager: "brew", name: "projectatlas" });
  });

  it("classifies a Homebrew Cellar path (macOS Intel)", () => {
    expect(
      classifyBinaryPath("/usr/local/Cellar/jq/1.7/bin/jq", HOME_MAC),
    ).toEqual({ manager: "brew", name: "jq" });
  });

  it("classifies a Homebrew opt symlink path (linuxbrew layout)", () => {
    expect(
      classifyBinaryPath(
        "/home/linuxbrew/.linuxbrew/homebrew/opt/ripgrep/bin/rg",
        "/home/fab",
      ),
    ).toEqual({ manager: "brew", name: "ripgrep" });
  });

  it("classifies a Homebrew opt symlink path (macOS default prefix)", () => {
    expect(
      classifyBinaryPath("/usr/local/opt/gh/bin/gh", HOME_MAC),
    ).toEqual({ manager: "brew", name: "gh" });
  });

  it("returns null for an unscoped npm global (node_modules)", () => {
    expect(
      classifyBinaryPath(
        "/Users/fab/.nvm/versions/node/v20/lib/node_modules/greppy/bin/greppy.js",
        HOME_MAC,
      ),
    ).toBeNull();
  });

  it("returns null for a scoped npm global (@scope/pkg in node_modules)", () => {
    expect(
      classifyBinaryPath(
        "/Users/fab/.nvm/versions/node/v20/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
        HOME_MAC,
      ),
    ).toBeNull();
  });

  it("classifies an unrecognized path as unknown, using the basename", () => {
    expect(
      classifyBinaryPath("/opt/local-tools/serena/bin/serena", HOME_MAC),
    ).toEqual({ manager: "unknown", name: "serena" });
  });

  it("handles win32 uv tool shapes (backslashes)", () => {
    expect(
      classifyBinaryPath(
        "C:\\Users\\fab\\.local\\share\\uv\\tools\\serena-agent\\Scripts\\serena.exe",
        HOME_WIN,
      ),
    ).toEqual({ manager: "uv", name: "serena-agent" });
  });

  it("strips .exe from an unknown win32 binary's basename", () => {
    expect(
      classifyBinaryPath("C:\\tools\\thing\\bin\\thing.exe", HOME_WIN),
    ).toEqual({ manager: "unknown", name: "thing" });
  });

  it("strips .cmd from an unknown win32 binary's basename", () => {
    expect(
      classifyBinaryPath("C:\\tools\\thing\\bin\\thing.cmd", HOME_WIN),
    ).toEqual({ manager: "unknown", name: "thing" });
  });
});

/* -------------------------------------------------------------------------- */
/* isRuntimeCommand                                                            */
/* -------------------------------------------------------------------------- */

describe("isRuntimeCommand", () => {
  it("flags every listed runtime command", () => {
    for (const cmd of RUNTIME_COMMANDS) {
      expect(isRuntimeCommand(cmd)).toBe(true);
    }
  });

  it("flags a bare runtime name", () => {
    expect(isRuntimeCommand("npx")).toBe(true);
  });

  it("flags a runtime resolved to an absolute POSIX path, by basename", () => {
    expect(isRuntimeCommand("/usr/bin/python3")).toBe(true);
  });

  it("flags a runtime with a win32 .exe suffix, case-insensitively", () => {
    expect(isRuntimeCommand("node.exe")).toBe(true);
    expect(isRuntimeCommand("C:\\Program Files\\nodejs\\Node.EXE")).toBe(true);
  });

  it("does not flag a non-runtime command", () => {
    expect(isRuntimeCommand("serena")).toBe(false);
    expect(isRuntimeCommand("/Users/fab/.local/bin/serena")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* mergeExternalTools                                                          */
/* -------------------------------------------------------------------------- */

function ref(overrides: Partial<ExternalToolRef> = {}): ExternalToolRef {
  return {
    name: "serena-agent",
    manager: "uv",
    command: "serena",
    usedBy: ["mcp:serena"],
    ...overrides,
  };
}

describe("isRuntimeCommand: shell builtins", () => {
  it("skips builtins a hook line starts with", () => {
    // `cd "$dir" && ...`, `source ~/.agents/env.sh`, `exec node x.js`: the first
    // token is a builtin, so there is no package behind it to install.
    for (const builtin of ["cd", "source", ".", "exec", "eval", "export", "test", "[", "echo", "command"]) {
      expect(isRuntimeCommand(builtin)).toBe(true);
    }
  });

  it("still classifies a real tool name as installable", () => {
    expect(isRuntimeCommand("serena")).toBe(false);
    expect(isRuntimeCommand("greppy")).toBe(false);
  });
});

describe("mergeExternalTools", () => {
  it("dedupes by manager:name and unions usedBy (sorted, unique)", () => {
    const claude = [ref({ usedBy: ["mcp:serena"] })];
    const codex = [ref({ usedBy: ["hook:PreToolUse", "mcp:serena"] })];

    const merged = mergeExternalTools([claude, codex]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.usedBy).toEqual(["hook:PreToolUse", "mcp:serena"]);
  });

  it("keeps the first occurrence's other fields when merging", () => {
    const first = [ref({ command: "serena", resolvedPath: "/first/serena" })];
    const second = [ref({ command: "serena-other", resolvedPath: "/second/serena" })];

    const merged = mergeExternalTools([first, second]);

    expect(merged[0]?.command).toBe("serena");
    expect(merged[0]?.resolvedPath).toBe("/first/serena");
  });

  it("keeps distinct manager:name pairs separate and sorts the output", () => {
    const list = [
      ref({ name: "zzz-tool", manager: "unknown", usedBy: ["hook:Stop"] }),
      ref({ name: "greppy", manager: "pipx", usedBy: ["hook:PreToolUse"] }),
      ref({ name: "serena-agent", manager: "uv", usedBy: ["mcp:serena"] }),
    ];

    const merged = mergeExternalTools([list]);

    expect(merged.map((r) => `${r.manager}:${r.name}`)).toEqual([
      "pipx:greppy",
      "unknown:zzz-tool",
      "uv:serena-agent",
    ]);
  });

  it("never mutates its inputs", () => {
    const original = ref({ usedBy: ["mcp:serena"] });
    const list: readonly ExternalToolRef[] = [original];
    const lists: ReadonlyArray<ReadonlyArray<ExternalToolRef>> = [list, [ref({ usedBy: ["hook:Stop"] })]];

    const frozenUsedBy = [...original.usedBy];
    mergeExternalTools(lists);

    expect(original.usedBy).toEqual(frozenUsedBy);
    expect(list).toHaveLength(1);
    expect(lists).toHaveLength(2);
  });

  it("returns [] for no lists / empty lists", () => {
    expect(mergeExternalTools([])).toEqual([]);
    expect(mergeExternalTools([[], []])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* externalToolInstallCommand                                                  */
/* -------------------------------------------------------------------------- */

describe("externalToolInstallCommand", () => {
  it("builds `brew install <name>`", () => {
    expect(externalToolInstallCommand({ manager: "brew", name: "projectatlas" })).toEqual({
      cmd: "brew",
      args: ["install", "projectatlas"],
    });
  });

  it("builds `uv tool install <name>`", () => {
    expect(externalToolInstallCommand({ manager: "uv", name: "serena-agent" })).toEqual({
      cmd: "uv",
      args: ["tool", "install", "serena-agent"],
    });
  });

  it("builds `pipx install <name>`", () => {
    expect(externalToolInstallCommand({ manager: "pipx", name: "greppy" })).toEqual({
      cmd: "pipx",
      args: ["install", "greppy"],
    });
  });

  it("returns null for an unknown manager", () => {
    expect(externalToolInstallCommand({ manager: "unknown", name: "mystery" })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* isSafeToolName                                                              */
/* -------------------------------------------------------------------------- */

describe("isSafeToolName", () => {
  it("accepts the package names real managers use", () => {
    for (const name of [
      "serena-agent",
      "cloudflare-cli4",
      "graphifyy",
      "foo.bar+baz",
      "ripgrep",
      "python3.12",
      "a",
      "7zip",
    ]) {
      expect(isSafeToolName(name)).toBe(true);
    }
  });

  it("rejects every shape that would change what a package manager installs", () => {
    for (const name of [
      "--cask", // an OPTION, not a package
      "-f",
      "git+https://evil.example/x", // a SOURCE, not a package
      "https://evil.example/formula.rb",
      "./local/formula.rb",
      "/etc/passwd",
      "a b", // two argv elements' worth of intent in one
      "tap/name",
      "name:1",
      "@scope/pkg",
      "",
      "\n",
    ]) {
      expect(isSafeToolName(name)).toBe(false);
    }
  });

  it("rejects a name past the length cap", () => {
    expect(isSafeToolName("a".repeat(MAX_TOOL_NAME_LENGTH))).toBe(true);
    expect(isSafeToolName("a".repeat(MAX_TOOL_NAME_LENGTH + 1))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* installExternalTool (injected which/run — never shells out)                 */
/* -------------------------------------------------------------------------- */

describe("installExternalTool", () => {
  it("returns 'unsupported' for an unknown manager without probing anything", async () => {
    const whichFn = vi.fn().mockResolvedValue(true);
    const runFn = vi.fn().mockResolvedValue(undefined);

    const outcome = await installExternalTool(
      { manager: "unknown", name: "mystery" },
      { which: whichFn, run: runFn },
    );

    expect(outcome).toBe("unsupported");
    expect(whichFn).not.toHaveBeenCalled();
    expect(runFn).not.toHaveBeenCalled();
  });

  it("returns 'rejected-name' and probes NOTHING for an option-shaped name", async () => {
    // Second line of defence: the manifest schema already drops these, but the
    // spawn itself must refuse too — `brew install --cask` is a different
    // command than `brew install <package>`.
    const whichFn = vi.fn().mockResolvedValue(true);
    const runFn = vi.fn().mockResolvedValue(undefined);

    for (const name of ["--cask", "git+https://evil.example/x", "a b"]) {
      const outcome = await installExternalTool(
        { manager: "brew", name },
        { which: whichFn, run: runFn },
      );
      expect(outcome).toBe("rejected-name");
    }

    expect(whichFn).not.toHaveBeenCalled();
    expect(runFn).not.toHaveBeenCalled();
  });

  it("returns 'skipped-manager-missing' when the manager binary is absent", async () => {
    const whichFn = vi.fn().mockResolvedValue(false);
    const runFn = vi.fn().mockResolvedValue(undefined);

    const outcome = await installExternalTool(
      { manager: "uv", name: "serena-agent" },
      { which: whichFn, run: runFn },
    );

    expect(outcome).toBe("skipped-manager-missing");
    expect(whichFn).toHaveBeenCalledWith("uv");
    expect(runFn).not.toHaveBeenCalled();
  });

  it("runs the resolved install command with the right argv when the manager is present", async () => {
    const whichFn = vi.fn().mockResolvedValue(true);
    const runFn = vi.fn().mockResolvedValue(undefined);

    const outcome = await installExternalTool(
      { manager: "pipx", name: "greppy" },
      { which: whichFn, run: runFn },
    );

    expect(outcome).toBe("installed");
    expect(runFn).toHaveBeenCalledWith({ cmd: "pipx", args: ["install", "greppy"] });
  });

  it("surfaces a runner error with the 'external tool <name>:' prefix", async () => {
    const whichFn = vi.fn().mockResolvedValue(true);
    const runFn = vi.fn().mockRejectedValue(new Error("network unreachable"));

    await expect(
      installExternalTool(
        { manager: "brew", name: "projectatlas" },
        { which: whichFn, run: runFn },
      ),
    ).rejects.toThrow("external tool projectatlas: network unreachable");
  });

  it("defaults which/run to the module's own which/runInstall when not injected", async () => {
    // Exercise the default-parameter path without actually installing
    // anything: an unknown manager short-circuits before either default
    // collaborator would ever be invoked.
    const outcome = await installExternalTool({ manager: "unknown", name: "mystery" });
    expect(outcome).toBe("unsupported");
  });
});
