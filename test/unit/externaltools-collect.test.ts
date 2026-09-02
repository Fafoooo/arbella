/**
 * Unit tests for the external-tool COLLECTOR (WP-C) and the restore-side pass
 * that acts on what it produced.
 *
 * `collectExternalTools` is the one place where a command reference becomes a
 * manifest entry, so the tests below drive the whole pipeline — token → runtime
 * filter → resolve → carried-file filter → classify → merge — with INJECTED
 * `resolve`/`realpath` fakes. Nothing here touches PATH, the filesystem, or a
 * package manager: every "binary" is a string the test hands over, which is
 * exactly why the collector takes those two collaborators as options.
 *
 * The restore section exercises the same contract from the other end: planning
 * never probes the machine, execution skips whatever is already on PATH, and
 * every non-install outcome ends up in the manual-install reminder list.
 */

import { describe, it, expect, vi } from "vitest";

import {
  capturedAbsolutePaths,
  collectExternalTools,
  commandBaseName,
  executableToken,
} from "../../src/core/externaltools/collect.js";
import type { ExternalToolRef } from "../../src/core/externaltools/classify.js";
import type { CommandRef } from "../../src/core/homefiles/scan.js";
import {
  externalToolActions,
  installSharedExternalTools,
} from "../../src/commands/restore.js";
import type { Logger } from "../../src/types.js";

const HOME = "/Users/fab";

/** Realpaths the fake resolver knows about, keyed by the token as written. */
const BINARIES: Record<string, string> = {
  serena: "/Users/fab/.local/share/uv/tools/serena-agent/bin/serena",
  greppy: "/Users/fab/.local/pipx/venvs/greppy/bin/greppy",
  projectatlas: "/opt/homebrew/Cellar/projectatlas/1.2.0/bin/projectatlas",
  "claude-mem": "/Users/fab/.nvm/versions/node/v22.0.0/lib/node_modules/claude-mem/bin/cli.js",
  cat: "/bin/cat",
  mystery: "/Users/fab/bin/mystery",
};

/** Resolver over {@link BINARIES}; absolute paths echo back, everything else misses. */
async function fakeResolve(name: string): Promise<string | null> {
  if (name.startsWith("/")) return name;
  return BINARIES[name] ?? null;
}

/** Identity realpath (the fake resolver already returns install locations). */
async function fakeRealpath(binaryPath: string): Promise<string> {
  return binaryPath;
}

/** Fold $HOME to {{HOME}} the way the real templater would. */
function toTemplate(value: string): string {
  return value.startsWith(HOME) ? `{{HOME}}${value.slice(HOME.length)}` : value;
}

/** Run the collector with the fakes above and no carried files unless given. */
function collect(
  refs: CommandRef[],
  overrides: {
    capturedPaths?: Set<string>;
    resolve?: (name: string) => Promise<string | null>;
    realpath?: (p: string) => Promise<string>;
  } = {},
): Promise<ExternalToolRef[]> {
  return collectExternalTools(refs, {
    home: HOME,
    capturedPaths: overrides.capturedPaths ?? new Set<string>(),
    resolve: overrides.resolve ?? fakeResolve,
    realpath: overrides.realpath ?? fakeRealpath,
    toTemplate,
  });
}

/** One command reference, with a provenance label. */
function ref(command: string, source = "claude:.claude.json#mcpServers.x"): CommandRef {
  return { command, source };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

describe("executableToken", () => {
  it("returns the first token, honoring quotes", () => {
    expect(executableToken("serena start --stdio")).toBe("serena");
    expect(executableToken('"/Users/fab/my tools/x" --flag')).toBe("/Users/fab/my tools/x");
  });

  it("rejects empty commands and shell syntax", () => {
    expect(executableToken("   ")).toBeNull();
    expect(executableToken("foo|bar")).toBeNull();
    expect(executableToken("(cd /tmp")).toBeNull();
  });
});

describe("commandBaseName", () => {
  it("takes the basename across separator flavors and strips .exe/.cmd", () => {
    expect(commandBaseName("serena")).toBe("serena");
    expect(commandBaseName("{{HOME}}/.local/bin/serena")).toBe("serena");
    expect(commandBaseName("C:\\tools\\serena.EXE")).toBe("serena");
  });
});

describe("capturedAbsolutePaths", () => {
  it("maps tool-home and shared/home repo paths back to absolute paths", () => {
    const paths = capturedAbsolutePaths(
      [
        { repoPath: "claude/files/hooks/send_event.py" },
        { repoPath: "shared/home/.agents/hooks/dispatch.sh" },
        { repoPath: "claude/memories/home/-proj/memory/MEMORY.md" },
        { repoPath: "shared/instructions.md" },
      ],
      { home: HOME, toolHome: "/Users/fab/.claude", filesPrefix: "claude/files" },
    );

    expect([...paths].sort()).toEqual([
      "/Users/fab/.agents/hooks/dispatch.sh",
      "/Users/fab/.claude/hooks/send_event.py",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* collectExternalTools: classification end-to-end                             */
/* -------------------------------------------------------------------------- */

describe("collectExternalTools: classification", () => {
  it("classifies uv / pipx / brew binaries from a bare command name", async () => {
    const tools = await collect([
      ref("serena start --stdio", "claude:.claude.json#mcpServers.serena"),
      ref("greppy search", "claude:settings.json#hooks.PreToolUse[0].hooks[0]"),
      ref("projectatlas serve", "codex:config.toml#mcp_servers.atlas"),
    ]);

    expect(tools).toEqual([
      {
        name: "projectatlas",
        manager: "brew",
        command: "projectatlas",
        resolvedPath: "/opt/homebrew/Cellar/projectatlas/1.2.0/bin/projectatlas",
        usedBy: ["codex:config.toml#mcp_servers.atlas"],
      },
      {
        name: "greppy",
        manager: "pipx",
        command: "greppy",
        resolvedPath: "{{HOME}}/.local/pipx/venvs/greppy/bin/greppy",
        usedBy: ["claude:settings.json#hooks.PreToolUse[0].hooks[0]"],
      },
      {
        name: "serena-agent",
        manager: "uv",
        command: "serena",
        resolvedPath: "{{HOME}}/.local/share/uv/tools/serena-agent/bin/serena",
        usedBy: ["claude:.claude.json#mcpServers.serena"],
      },
    ]);
  });

  it("records an unclassifiable binary under $HOME as manager 'unknown'", async () => {
    expect(await collect([ref("mystery --serve")])).toEqual([
      {
        name: "mystery",
        manager: "unknown",
        command: "mystery",
        resolvedPath: "{{HOME}}/bin/mystery",
        usedBy: ["claude:.claude.json#mcpServers.x"],
      },
    ]);
  });

  it("keeps the command AS WRITTEN and templates the resolved path", async () => {
    // `~/x` is already portable, so the templater leaves it alone; the absolute
    // realpath behind it is the value that must never carry a machine path.
    const viaTilde = await collect([ref("~/.local/share/uv/tools/serena-agent/bin/serena")]);
    expect(viaTilde[0]?.command).toBe("~/.local/share/uv/tools/serena-agent/bin/serena");
    expect(viaTilde[0]?.resolvedPath).toBe(
      "{{HOME}}/.local/share/uv/tools/serena-agent/bin/serena",
    );
    expect(viaTilde[0]?.manager).toBe("uv");

    const viaAbsolute = await collect([
      ref("/Users/fab/.local/share/uv/tools/serena-agent/bin/serena --stdio"),
    ]);
    expect(viaAbsolute[0]?.command).toBe(
      "{{HOME}}/.local/share/uv/tools/serena-agent/bin/serena",
    );
  });

  it("expands ~ / $HOME and understands a quoted command", async () => {
    const viaHomeVar = await collect([ref("$HOME/.local/pipx/venvs/greppy/bin/greppy -n 10")]);
    expect(viaHomeVar).toHaveLength(1);
    expect(viaHomeVar[0]).toMatchObject({ manager: "pipx", name: "greppy" });

    const quoted = await collect([ref('"~/.local/pipx/venvs/greppy/bin/greppy" -n 10')]);
    expect(quoted[0]).toMatchObject({ manager: "pipx", name: "greppy" });
  });
});

/* -------------------------------------------------------------------------- */
/* collectExternalTools: everything it must NOT record                         */
/* -------------------------------------------------------------------------- */

describe("collectExternalTools: exclusions", () => {
  it("skips runtimes, launchers and arbella itself", async () => {
    const resolve = vi.fn(fakeResolve);
    const tools = await collect(
      [
        ref("npx some-mcp-server"),
        ref("python3 ~/.claude/hooks/send_event.py"),
        ref("uvx serena-agent"),
        ref("node /Users/fab/.codex/mcp/search.js"),
        ref("/usr/bin/env node server.js"),
        ref("arbella push"),
      ],
      { resolve },
    );

    expect(tools).toEqual([]);
    // Runtimes are filtered BEFORE any resolution — no lookups at all.
    expect(resolve).not.toHaveBeenCalled();
  });

  it("skips a script this capture already carries (shared/home or tool home)", async () => {
    const dispatcher = "/Users/fab/.agents/hooks/dispatch.sh";
    const statusline = "/Users/fab/.claude/statusline/run.sh";

    const tools = await collect(
      [ref(`${dispatcher} --json`), ref("~/.claude/statusline/run.sh")],
      { capturedPaths: new Set([dispatcher, statusline]) },
    );

    expect(tools).toEqual([]);
  });

  it("skips a carried script even when the LINK resolves elsewhere", async () => {
    // ~/.local/bin/x is a symlink into a carried script: the realpath is what
    // the captured-file set knows about, so both ends must be checked.
    const carried = "/Users/fab/.agents/bin/sp-api-mcp.sh";
    const tools = await collect([ref("~/.local/bin/sp-api-mcp")], {
      capturedPaths: new Set([carried]),
      realpath: async () => carried,
    });

    expect(tools).toEqual([]);
  });

  it("skips npm globals (node_modules) — manifest.npmGlobals already covers them", async () => {
    expect(await collect([ref("claude-mem index")])).toEqual([]);
  });

  it("skips OS-provided binaries", async () => {
    expect(await collect([ref("cat ~/.env")])).toEqual([]);
  });

  it("skips a command that does not resolve on this machine", async () => {
    expect(await collect([ref("local-mcp --stdio")])).toEqual([]);
    expect(await collect([ref("/opt/gone/bin/nope")], { resolve: async () => null })).toEqual(
      [],
    );
  });

  it("skips a relative path, which only means something next to an unknown cwd", async () => {
    const resolve = vi.fn(fakeResolve);
    expect(await collect([ref("./bin/serena")], { resolve })).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("never throws when the resolver or realpath fails", async () => {
    await expect(
      collect([ref("serena")], {
        resolve: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    ).resolves.toEqual([]);

    await expect(
      collect([ref("serena")], {
        realpath: async () => {
          throw new Error("EACCES");
        },
      }),
    ).resolves.toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* collectExternalTools: merging + cost                                        */
/* -------------------------------------------------------------------------- */

describe("collectExternalTools: never emits an unusable name", () => {
  it("drops a binary whose directory name is not a package name", async () => {
    // The "unknown" classifier names a tool after its basename, and a basename
    // can be anything a filesystem allows. Whatever it produces has to survive
    // being written to a manifest and read back as `brew install <name>` on
    // another machine — so a name that could not be one is dropped here.
    const weird = "/Users/fab/opt/--cask/bin/--cask";
    const tools = await collect([ref(weird)], {
      resolve: async (name) => (name === weird ? weird : null),
    });

    expect(tools).toEqual([]);
  });

  it("still records an ordinary unknown-manager binary", async () => {
    const tools = await collect([ref("mystery")]);
    expect(tools.map((t) => t.name)).toEqual(["mystery"]);
  });
});

describe("collectExternalTools: dedupe and cost", () => {
  it("dedupes by manager:name and unions usedBy", async () => {
    const tools = await collect([
      ref("serena start", "claude:.claude.json#mcpServers.serena"),
      ref("serena start", "codex:config.toml#mcp_servers.serena"),
      ref("serena", "claude:settings.json#hooks.PreToolUse[0].hooks[0]"),
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.usedBy).toEqual([
      "claude:.claude.json#mcpServers.serena",
      "claude:settings.json#hooks.PreToolUse[0].hooks[0]",
      "codex:config.toml#mcp_servers.serena",
    ]);
    // Fields other than usedBy come from the FIRST occurrence.
    expect(tools[0]?.command).toBe("serena");
  });

  it("resolves each distinct executable exactly once per capture", async () => {
    const resolve = vi.fn(fakeResolve);
    const realpath = vi.fn(fakeRealpath);

    await collect(
      [ref("serena a"), ref("serena b"), ref("serena c"), ref("greppy x"), ref("greppy y")],
      { resolve, realpath },
    );

    expect(resolve.mock.calls.map((c) => c[0])).toEqual(["serena", "greppy"]);
    expect(realpath).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Restore pass                                                                */
/* -------------------------------------------------------------------------- */

/** A logger that records what was said, so warnings can be asserted. */
function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => void lines.push(`info: ${m}`),
    success: (m) => void lines.push(`success: ${m}`),
    warn: (m) => void lines.push(`warn: ${m}`),
    error: (m) => void lines.push(`error: ${m}`),
    step: (m) => void lines.push(`step: ${m}`),
    debug: (m) => void lines.push(`debug: ${m}`),
  };
}

const SERENA: ExternalToolRef = {
  name: "serena-agent",
  manager: "uv",
  command: "{{HOME}}/.local/bin/serena",
  resolvedPath: "{{HOME}}/.local/share/uv/tools/serena-agent/bin/serena",
  usedBy: ["mcp:serena"],
};

const MYSTERY: ExternalToolRef = {
  name: "mystery",
  manager: "unknown",
  command: "mystery",
  resolvedPath: "{{HOME}}/bin/mystery",
  usedBy: ["hook:PreToolUse"],
};

describe("externalToolActions", () => {
  it("plans the exact install command, or the manual phrasing when unknown", () => {
    expect(
      externalToolActions([
        { ...SERENA, manager: "brew", name: "projectatlas", usedBy: ["mcp:atlas"] },
        SERENA,
        MYSTERY,
      ]),
    ).toEqual([
      {
        type: "install-external-tool",
        tool: "system",
        description: "brew install projectatlas (mcp:atlas)",
      },
      {
        type: "install-external-tool",
        tool: "system",
        description: "uv tool install serena-agent (mcp:serena)",
      },
      {
        type: "install-external-tool",
        tool: "system",
        description: "install mystery manually (hook:PreToolUse)",
      },
    ]);
  });
});

describe("installSharedExternalTools", () => {
  it("skips a tool whose BINARY already resolves on PATH", async () => {
    const install = vi.fn();
    const l = recordingLogger();

    const manual = await installSharedExternalTools(
      [SERENA],
      { which: async () => true, install },
      l,
    );

    expect(install).not.toHaveBeenCalled();
    expect(manual).toEqual([]);
    // Probed by the binary name, not the package name.
    expect(l.lines).toContain("debug: restore: serena is already on PATH; skipping serena-agent");
  });

  it("installs a missing tool through its manager", async () => {
    const install = vi.fn().mockResolvedValue("installed");

    const manual = await installSharedExternalTools(
      [SERENA],
      { which: async () => false, install },
      recordingLogger(),
    );

    expect(install).toHaveBeenCalledWith(SERENA);
    expect(manual).toEqual([]);
  });

  it("collects unsupported / manager-missing / failing tools for the reminder", async () => {
    const l = recordingLogger();
    const install = vi
      .fn()
      .mockResolvedValueOnce("unsupported")
      .mockResolvedValueOnce("skipped-manager-missing")
      .mockRejectedValueOnce(new Error("network unreachable"));

    const manual = await installSharedExternalTools(
      [MYSTERY, SERENA, { ...SERENA, name: "other-agent" }],
      { which: async () => false, install },
      l,
    );

    expect(manual.map((t) => t.name)).toEqual(["mystery", "serena-agent", "other-agent"]);
    expect(l.lines.filter((line) => line.startsWith("warn:"))).toHaveLength(3);
    expect(l.lines.join("\n")).toContain("network unreachable");
  });

  it("never puts a refused name in the manual-install reminder", async () => {
    // "rejected-name" means the entry is repo data arbella refuses to act on.
    // Telling the user to "install --cask manually" would just relay the
    // attacker's chosen string into the summary.
    const l = recordingLogger();
    const install = vi.fn().mockResolvedValue("rejected-name");

    const manual = await installSharedExternalTools(
      [{ ...SERENA, name: "--cask" }],
      { which: async () => false, install },
      l,
    );

    expect(manual).toEqual([]);
    expect(l.lines.join("\n")).toContain("unsafe name");
  });

  it("is a no-op with nothing to install", async () => {
    const l = recordingLogger();
    expect(await installSharedExternalTools([], {}, l)).toEqual([]);
    expect(l.lines).toEqual(["debug: restore: no external tools to install."]);
  });
});
