/**
 * Unit tests for the `arbella init` extraPaths suggestions
 * (src/core/homefiles/suggest.ts), against a real fixture $HOME.
 *
 * The suggestion list is what the user is invited to accept with `-y`, so a bad
 * entry is not cosmetic: it decides what a backup carries from here on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { suggestExtraPaths } from "../../src/core/homefiles/suggest.js";
import { fs as realFs } from "../../src/utils/fs.js";

let home: string;
let claudeHome: string;
let codexHome: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(home, ...rel.split("/"));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

function suggest(): Promise<string[]> {
  return suggestExtraPaths({
    fs: realFs,
    home,
    claudeHome,
    codexHome,
    excludeRoots: [claudeHome, codexHome],
  });
}

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-suggest-"));
  claudeHome = path.join(home, ".claude");
  codexHome = path.join(home, ".codex");
  await fsp.mkdir(claudeHome, { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

describe("suggestExtraPaths", () => {
  it("suggests the directory a hook dispatcher lives in", async () => {
    await write(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: "bash ~/.agents/hooks/dispatch.sh" }] }],
        },
      }),
    );

    expect(await suggest()).toEqual(["~/.agents/hooks"]);
  });

  it("never suggests a well-known binary directory", async () => {
    // Everything in ~/.local/bin is an installed program or a shim. Accepting
    // this suggestion would carry a few hundred machine-specific binaries into a
    // git repo — and the linked script itself is captured individually anyway.
    await write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          gsc: { command: "~/.local/bin/gsc-mcp-start" },
          serena: { command: "$HOME/.cargo/bin/serena" },
          atlas: { command: "~/go/bin/atlas" },
          old: { command: "~/bin/legacy-mcp" },
          npmish: { command: "~/.npm-global/bin/thing" },
        },
      }),
    );

    expect(await suggest()).toEqual([]);
  });

  it("still suggests a non-binary directory alongside a binary one", async () => {
    await write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          gsc: { command: "~/.local/bin/gsc-mcp-start" },
          sp: { command: "~/.agents/bin/sp-api-mcp.sh" },
        },
      }),
    );

    expect(await suggest()).toEqual(["~/.agents/bin"]);
  });

  it("never suggests a tool home or $HOME itself", async () => {
    await write(
      ".claude/settings.json",
      JSON.stringify({
        statusLine: { command: `${home}/.claude/statusline.sh` },
        hooks: { Stop: [{ hooks: [{ command: `${home}/loose.sh` }] }] },
      }),
    );

    expect(await suggest()).toEqual([]);
  });
});
