/**
 * Unit tests for the pure command -> $HOME path scanner (WP-B / B1).
 *
 * The scanner decides which files a tool config POINTS AT and therefore which
 * files must ride along in `shared/home`. It is the gate in front of every
 * home-directory read, so its rejections matter as much as its hits: a token
 * that is not clearly a path must produce nothing at all.
 */

import { describe, it, expect } from "vitest";

import {
  collectCommandRefs,
  extractHomePathCandidates,
  expandHomePath,
  homeRelativePosix,
  isUnderHome,
  tokenizeCommand,
} from "../../src/core/homefiles/scan.js";

const HOME = "/Users/fab";
const WIN_HOME = "C:\\Users\\fab";

/** Shorthand: candidates for a bare command line. */
function candidates(command: string, args?: string[], home = HOME): string[] {
  return extractHomePathCandidates(
    { command, ...(args ? { args } : {}), source: "test" },
    home,
  );
}

describe("tokenizeCommand", () => {
  it("splits on whitespace and strips quotes, remembering that it saw them", () => {
    expect(tokenizeCommand(`bash "/Users/fab/my scripts/run.sh" --flag`)).toEqual([
      { text: "bash", quoted: false },
      { text: "/Users/fab/my scripts/run.sh", quoted: true },
      { text: "--flag", quoted: false },
    ]);
  });

  it("treats single quotes the same way and tolerates an unterminated quote", () => {
    expect(tokenizeCommand(`sh '~/x.sh`)).toEqual([
      { text: "sh", quoted: false },
      { text: "~/x.sh", quoted: true },
    ]);
  });
});

describe("extractHomePathCandidates: expansion", () => {
  it("expands ~/, $HOME/ and ${HOME}/ to the same absolute path", () => {
    expect(candidates("bash ~/.agents/hooks/dispatch.sh")).toEqual([
      "/Users/fab/.agents/hooks/dispatch.sh",
    ]);
    expect(candidates("bash $HOME/.agents/hooks/dispatch.sh")).toEqual([
      "/Users/fab/.agents/hooks/dispatch.sh",
    ]);
    expect(candidates("bash ${HOME}/.agents/hooks/dispatch.sh")).toEqual([
      "/Users/fab/.agents/hooks/dispatch.sh",
    ]);
  });

  it("keeps an already-absolute path under $HOME", () => {
    expect(candidates("/Users/fab/.local/bin/serena-mcp-start --stdio")).toEqual([
      "/Users/fab/.local/bin/serena-mcp-start",
    ]);
  });

  it("finds paths inside a quoted token", () => {
    expect(candidates(`bash "~/.agents/my hooks/run.sh"`)).toEqual([
      "/Users/fab/.agents/my hooks/run.sh",
    ]);
  });

  it("scans args entries verbatim (they are never re-tokenized)", () => {
    expect(candidates("node", ["~/.agents/mcp/server.js", "--port", "3000"])).toEqual([
      "/Users/fab/.agents/mcp/server.js",
    ]);
    expect(candidates("node", ["/Users/fab/a b/c.js"])).toEqual(["/Users/fab/a b/c.js"]);
  });

  it("strips a trailing permission-style :* before testing the path", () => {
    expect(candidates("~/.agents/bin/tool:*")).toEqual(["/Users/fab/.agents/bin/tool"]);
  });

  it("returns each path once, in first-seen order", () => {
    expect(
      candidates("bash ~/.agents/a.sh ~/.agents/b.sh $HOME/.agents/a.sh"),
    ).toEqual(["/Users/fab/.agents/a.sh", "/Users/fab/.agents/b.sh"]);
  });
});

describe("extractHomePathCandidates: inline command lines", () => {
  // `sh -c "<script> <args>"` puts a whole command line in ONE token. Taken as a
  // filename it points nowhere, and the script the hook needs is never carried.
  it("takes the leading script out of sh -c / bash -lc / zsh -c", () => {
    expect(candidates(`sh -c "~/.agents/hooks/dispatch.sh --json"`)).toEqual([
      "/Users/fab/.agents/hooks/dispatch.sh",
    ]);
    expect(candidates(`bash -lc "$HOME/.agents/router/ensure.sh --quiet"`)).toEqual([
      "/Users/fab/.agents/router/ensure.sh",
    ]);
    expect(candidates(`zsh -c '~/.local/bin/report.py --since 7d'`)).toEqual([
      "/Users/fab/.local/bin/report.py",
    ]);
  });

  it("applies the same rule to an args entry holding a command line", () => {
    expect(candidates("sh", ["-c", "~/.agents/hooks/dispatch.sh --json"])).toEqual([
      "/Users/fab/.agents/hooks/dispatch.sh",
    ]);
  });

  it("keeps a quoted path with spaces whole when nothing follows the script", () => {
    // The documented rule: the FIRST word must end in a script extension AND be
    // followed by more words. Here it is the LAST word, so this is a filename.
    expect(candidates(`bash "~/My Scripts/run.sh"`)).toEqual([
      "/Users/fab/My Scripts/run.sh",
    ]);
    expect(candidates("node", ["/Users/fab/a b/c.js"])).toEqual(["/Users/fab/a b/c.js"]);
  });

  it("keeps a space-containing path whole even when arguments follow it", () => {
    // Unresolvable either way — keeping it whole fails as a missing file instead
    // of silently capturing "~/My".
    expect(candidates(`bash "~/My Scripts/run.sh --json"`)).toEqual([
      "/Users/fab/My Scripts/run.sh --json",
    ]);
  });

  it("still yields the script when the inline command line pipes", () => {
    expect(candidates(`sh -c "~/.agents/a.sh --json | tee /tmp/log"`)).toEqual([
      "/Users/fab/.agents/a.sh",
    ]);
  });

  it("does not treat inline interpreter code as a command line", () => {
    // isInlineCode rejects it first (a paren is never part of a path we carry).
    expect(candidates(`node -e "require('~/.agents/x.js') && run()"`)).toEqual([]);
  });

  it("ignores an inline command line whose script is outside $HOME", () => {
    expect(candidates(`sh -c "/opt/tools/run.sh --json"`)).toEqual([]);
  });
});

describe("extractHomePathCandidates: rejection", () => {
  it("ignores bare command names, flags and non-path literals", () => {
    expect(candidates("npx -y @playwright/mcp --headless")).toEqual([]);
    expect(candidates("claude-mem hook session-start")).toEqual([]);
  });

  it("ignores absolute paths outside $HOME", () => {
    expect(candidates("/usr/local/bin/graphify")).toEqual([]);
    expect(candidates("bash /etc/profile.d/x.sh")).toEqual([]);
  });

  it("refuses a path that climbs back out of $HOME with ..", () => {
    expect(candidates("bash ~/../../etc/passwd")).toEqual([]);
    expect(candidates("bash /Users/fab/../root/.ssh/id_rsa")).toEqual([]);
  });

  it("ignores $HOME itself (there is no file there to carry)", () => {
    expect(candidates("ls ~/")).toEqual([]);
    expect(candidates("ls /Users/fab")).toEqual([]);
  });

  it("ignores tokens carrying shell operators", () => {
    expect(candidates("cat ~/.agents/a.sh|grep x")).toEqual([]);
    expect(candidates("~/.agents/a.sh;rm -rf /")).toEqual([]);
    expect(candidates("~/.agents/a.sh&&~/.agents/b.sh")).toEqual([]);
    expect(candidates("tee >(~/.agents/a.sh)")).toEqual([]);
  });

  it("ignores inline code passed to an interpreter", () => {
    expect(
      candidates(`node -e "require('~/.agents/x.js')"`),
    ).toEqual([]);
    expect(candidates('python3 -c "import os\nprint(os.environ)"')).toEqual([]);
  });

  it("is case-sensitive, so a differently-cased home never matches", () => {
    expect(candidates("/users/fab/.agents/a.sh")).toEqual([]);
  });

  it("returns nothing when the home is unknown", () => {
    expect(candidates("bash ~/.agents/a.sh", undefined, "")).toEqual([]);
  });
});

describe("extractHomePathCandidates: win32", () => {
  it("expands ~ against a win32 home and keeps its separators", () => {
    expect(candidates("bash ~/.agents/hooks/dispatch.sh", undefined, WIN_HOME)).toEqual([
      "C:\\Users\\fab\\.agents\\hooks\\dispatch.sh",
    ]);
  });

  it("accepts an absolute win32 path under the home", () => {
    expect(
      candidates("C:\\Users\\fab\\.local\\bin\\x.cmd", undefined, WIN_HOME),
    ).toEqual(["C:\\Users\\fab\\.local\\bin\\x.cmd"]);
  });

  it("rejects a win32 path outside the home", () => {
    expect(candidates("C:\\Windows\\system32\\cmd.exe", undefined, WIN_HOME)).toEqual([]);
  });
});

describe("path primitives", () => {
  it("isUnderHome is separator-agnostic and rejects the home itself", () => {
    expect(isUnderHome("C:/Users/fab/x", WIN_HOME)).toBe(true);
    expect(isUnderHome(WIN_HOME, WIN_HOME)).toBe(false);
    expect(isUnderHome("/Users/fabulous/x", HOME)).toBe(false);
  });

  it("homeRelativePosix returns a POSIX tail or null", () => {
    expect(homeRelativePosix(HOME, "/Users/fab/.agents/a.sh")).toBe(".agents/a.sh");
    expect(homeRelativePosix(WIN_HOME, "C:\\Users\\fab\\.agents\\a.sh")).toBe(".agents/a.sh");
    expect(homeRelativePosix(HOME, "/etc/passwd")).toBeNull();
  });

  it("expandHomePath only resolves home-prefixed or absolute tokens", () => {
    expect(expandHomePath("~/x", HOME)).toBe("/Users/fab/x");
    expect(expandHomePath("/tmp/x", HOME)).toBe("/tmp/x");
    expect(expandHomePath("x", HOME)).toBeNull();
  });
});

describe("collectCommandRefs", () => {
  it("finds hook, statusLine and MCP commands in a settings.json shape", () => {
    const settings = {
      statusLine: { type: "command", command: "~/.agents/statusline.sh" },
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "bash ~/.agents/hooks/dispatch.sh" },
              { type: "command", command: "echo hi" },
            ],
          },
        ],
      },
      mcpServers: {
        serena: { command: "uvx", args: ["serena-agent", "--stdio"] },
      },
    };

    const refs = collectCommandRefs(settings, "claude:settings.json");
    const bySource = Object.fromEntries(refs.map((r) => [r.source, r]));

    expect(bySource["claude:settings.json#statusLine"]!.command).toBe(
      "~/.agents/statusline.sh",
    );
    expect(bySource["claude:settings.json#hooks.PreToolUse[0].hooks[0]"]!.command).toBe(
      "bash ~/.agents/hooks/dispatch.sh",
    );
    expect(bySource["claude:settings.json#mcpServers.serena"]!.args).toEqual([
      "serena-agent",
      "--stdio",
    ]);
  });

  it("ignores non-string and empty commands, and never walks into command/args", () => {
    const refs = collectCommandRefs(
      { a: { command: 42 }, b: { command: "   " }, c: { command: "ok", args: ["x"] } },
      "src",
    );
    expect(refs).toEqual([{ command: "ok", args: ["x"], source: "src#c" }]);
  });

  it("tolerates undefined / scalars / arrays at the root", () => {
    expect(collectCommandRefs(undefined, "src")).toEqual([]);
    expect(collectCommandRefs("nope", "src")).toEqual([]);
    expect(collectCommandRefs([{ command: "x" }], "src")).toEqual([
      { command: "x", source: "src[0]" },
    ]);
  });
});
