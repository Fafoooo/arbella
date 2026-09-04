/**
 * Unit tests for `shared/home` capture (WP-B / B2, B3).
 *
 * $HOME is the widest surface arbella ever reads, so most of these tests are
 * NEGATIVE: the interesting assertions are the files that must never appear in
 * the output, no matter how a config points at them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HOME_DENY,
  MAX_HOME_FILE_BYTES,
  SHARED_HOME_REPO_PREFIX,
  captureExtraPaths,
  captureHomeFile,
  captureHomeTree,
  captureLinkedHomeFiles,
  computeAlreadyCaptured,
  dedupeByRepoPath,
  isSharedHomePath,
  resolveExtraPath,
} from "../../src/core/homefiles/capture.js";
import type {
  HomeCaptureContext,
  HomeCaptureOut,
} from "../../src/core/homefiles/capture.js";
import { matchesDeny } from "../../src/core/sanitizer/denylist.js";
import { renderRepoGitignore } from "../../src/commands/backup.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import type { CaptureResult } from "../../src/types.js";
import { isPosixHost, toPosixAll } from "../helpers/platform.js";

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const silentLog = {
  info() {},
  success() {},
  warn() {},
  error() {},
  step() {},
  debug() {},
};

let root: string;
let home: string;
let toolHome: string;

function ctx(includeSecrets = false): HomeCaptureContext {
  return {
    fs: realFs,
    log: silentLog,
    sanitizer: createSanitizer(),
    templater: createTemplater(),
    vars: makeVariables(home, "fab", "linux", toolHome),
    os: "linux",
    env: {},
    includeSecrets,
  };
}

function emptyOut(): HomeCaptureOut {
  return { files: [], secrets: [], warnings: [] };
}

/** Options with the fixture tool home as the only excluded root. */
function opts(maxFiles?: number) {
  return { excludeRoots: [toolHome], ...(maxFiles !== undefined ? { maxFiles } : {}) };
}

async function write(rel: string, content: string, mode?: number): Promise<string> {
  const abs = path.join(home, ...rel.split("/"));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, mode !== undefined ? { mode } : undefined);
  // writeFile's creation mode is filtered through the process umask. Apply the
  // requested fixture mode explicitly so mode-preservation assertions also run
  // correctly under restrictive shells (for example umask 077).
  if (mode !== undefined && isPosixHost) await fsp.chmod(abs, mode);
  return abs;
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-homefiles-"));
  home = path.join(root, "home");
  toolHome = path.join(home, ".claude");
  await fsp.mkdir(toolHome, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Placement + exclusions                                                      */
/* -------------------------------------------------------------------------- */

describe("captureHomeFile: placement", () => {
  it("stores a linked script at shared/home/<rel> with its mode preserved", async () => {
    const abs = await write(".agents/hooks/dispatch.sh", "#!/bin/sh\nexec \"$@\"\n", 0o755);
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "linked:test", out, opts());

    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.repoPath).toBe(`${SHARED_HOME_REPO_PREFIX}/.agents/hooks/dispatch.sh`);
    // Windows has no POSIX mode bits — chmod(0o755) is a near no-op there and
    // every file lstats back as 0o666 — so only this claim is host-specific.
    if (isPosixHost) expect(out.files[0]!.mode).toBe(0o755);
    expect(isSharedHomePath(out.files[0]!.repoPath)).toBe(true);
  });

  it("folds machine paths to {{HOME}} but never to {{TOOL_HOME}}", async () => {
    // The stored file must not depend on WHICH adapter found it, so a mention of
    // the tool home inside a shared home file folds to {{HOME}}/.claude.
    const abs = await write(
      ".agents/hooks/dispatch.sh",
      `#!/bin/sh\nsource ${home}/.agents/lib.sh\nexec ${home}/.claude/hooks/x.py\n`,
    );
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "linked:test", out, opts());

    const content = out.files[0]!.content;
    expect(content).not.toContain(home);
    expect(content).toContain("{{HOME}}/.agents/lib.sh");
    expect(content).toContain("{{HOME}}/.claude/hooks/x.py");
    expect(content).not.toContain("{{TOOL_HOME}}");
  });

  it("never duplicates a file that already lives under a tool home", async () => {
    const abs = await write(".claude/hooks/send_event.py", "print('hi')\n");
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "linked:test", out, opts());

    expect(out.files).toHaveLength(0);
  });

  it("never captures anything outside $HOME", async () => {
    const outside = path.join(root, "elsewhere", "x.sh");
    await fsp.mkdir(path.dirname(outside), { recursive: true });
    await fsp.writeFile(outside, "#!/bin/sh\n");
    const out = emptyOut();

    await captureHomeFile(ctx(), outside, "claude", "linked:test", out, opts());

    expect(out.files).toHaveLength(0);
  });

  it("skips symlinks (their targets are machine-specific)", async () => {
    const target = await write(".agents/real.sh", "#!/bin/sh\n");
    const link = path.join(home, ".agents", "link.sh");
    await fsp.symlink(target, link);
    const out = emptyOut();

    await captureHomeFile(ctx(), link, "claude", "linked:test", out, opts());

    expect(out.files).toHaveLength(0);
  });

  it("captures each path only once per pass", async () => {
    const abs = await write(".agents/hooks/dispatch.sh", "#!/bin/sh\n");
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "linked:a", out, opts());
    await captureHomeFile(ctx(), abs, "claude", "linked:b", out, opts());

    expect(out.files).toHaveLength(1);
  });

  it("captures a hook script named id_lookup.sh (not an SSH key) when referenced", async () => {
    // Regression for the old blanket "id_*" HOME_DENY pattern, which would have
    // silently eaten this file even though it is not a private key at all.
    const abs = await write(".agents/hooks/id_lookup.sh", "#!/bin/sh\nexec \"$@\"\n", 0o755);
    const out = emptyOut();

    await captureLinkedHomeFiles(
      ctx(),
      [{ command: `bash ~/.agents/hooks/id_lookup.sh`, source: "claude:settings.json#hooks.X[0]" }],
      "claude",
      out,
      opts(),
    );

    expect(out.files.map((f) => f.repoPath)).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/.agents/hooks/id_lookup.sh`,
    ]);
    expect(abs.endsWith("id_lookup.sh")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

describe("captureHomeFile: symlinked parents", () => {
  it("skips a file reached through a symlinked parent that leaves $HOME", async () => {
    // `~/link/x` passes every path check as written — it is under $HOME, it is a
    // regular file, its rel path is denylist-clean — while actually living
    // outside the home directory entirely.
    const outside = path.join(root, "outside");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, "x.sh"), "#!/bin/sh\necho hi\n");
    await fsp.symlink(outside, path.join(home, "link"));

    const out = emptyOut();
    await captureHomeFile(ctx(), path.join(home, "link", "x.sh"), "claude", "linked:test", out, opts());

    expect(out.files).toEqual([]);
  });

  it("re-applies the denylist to the REAL path behind a link inside $HOME", async () => {
    // The link stays under $HOME, so the under-home test passes — and the path
    // AS WRITTEN ("cloud/aws/credentials") matches no rule at all. Only the real
    // path (".aws/credentials") is denied, and only the denied one is the truth.
    await write(".aws/credentials", "[default]\naws_secret_access_key = x\n");
    await fsp.mkdir(path.join(home, "cloud"), { recursive: true });
    await fsp.symlink(path.join(home, ".aws"), path.join(home, "cloud", "aws"));

    const written = path.join(home, "cloud", "aws", "credentials");
    expect(matchesDeny("cloud/aws/credentials", [...HOME_DENY])).toBe(false);

    const out = emptyOut();
    await captureHomeFile(ctx(), written, "claude", "extraPaths:~/cloud", out, opts());

    expect(out.files).toEqual([]);
  });

  it("still captures an ordinary file whose parents are real directories", async () => {
    const abs = await write(".agents/hooks/dispatch.sh", "#!/bin/sh\n");
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "linked:test", out, opts());

    expect(out.files.map((f) => f.repoPath)).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/.agents/hooks/dispatch.sh`,
    ]);
  });
});

describe("captureHomeFile: secrets never leave the machine", () => {
  const DENIED: ReadonlyArray<[string, string]> = [
    [".env", "API_TOKEN=sk-ant-api03-DOTENV-AAAAAAAAAAAAAAAAAAAAAAAA"],
    [".ssh/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n"],
    [".ssh/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nBBBB\n"],
    [".netrc", "machine github.com login fab password hunter2"],
    [".npmrc", "//registry.npmjs.org/:_authToken=npm_CCCCCCCCCCCCCCCCCCCC"],
    [".git-credentials", "https://fab:token@github.com"],
    [".config/gh/credentials.json", '{"token":"ghp_DDDDDDDDDDDDDDDDDDDD"}'],
    [".agents/tls/server.pem", "-----BEGIN CERTIFICATE-----\n"],
    [".claude.json", '{"oauthAccount":{"accessToken":"sk-ant-oat01-EEEE"}}'],
  ];

  it.each(DENIED)(
    "refuses to capture ~/%s even when a hook references it",
    async (rel, content) => {
      const abs = await write(rel, content);
      const out = emptyOut();

      // Referenced exactly the way a real (misguided) hook would reference it.
      await captureLinkedHomeFiles(
        ctx(),
        [{ command: `cat ~/${rel}`, source: "claude:settings.json#hooks.X[0]" }],
        "claude",
        out,
        opts(),
      );

      expect(out.files).toHaveLength(0);
      expect(JSON.stringify(out)).not.toContain(content.trim().split("\n")[0]);
    },
  );

  it("redacts an inline token inside a referenced shell script", async () => {
    const TOKEN = "sk-ant-api03-INSIDE-A-SCRIPT-FFFFFFFFFFFFFFFFFFFF";
    const abs = await write(
      ".agents/hooks/dispatch.sh",
      `#!/bin/sh\nexport API_TOKEN=${TOKEN}\nexec "$@"\n`,
      0o755,
    );
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "linked:test", out, opts());

    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.content).not.toContain(TOKEN);
    expect(out.files[0]!.content).toContain("{{REDACTED}}");
    expect(out.secrets.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.secrets)).not.toContain(TOKEN);
    // The reason it was captured is still an ordinary executable script.
    if (isPosixHost) expect(out.files[0]!.mode).toBe(0o755);
    expect(abs.endsWith("dispatch.sh")).toBe(true);
  });

  it("carries the value verbatim only when includeSecrets is ON", async () => {
    const TOKEN = "sk-ant-api03-OPT-IN-GGGGGGGGGGGGGGGGGGGGGGGG";
    const abs = await write(".agents/hooks/dispatch.sh", `TOKEN=${TOKEN}\n`);
    const out = emptyOut();

    await captureHomeFile(ctx(true), abs, "claude", "linked:test", out, opts());

    expect(out.files[0]!.content).toContain(TOKEN);
  });

  it("drops a binary file whose bytes look like a secret", async () => {
    const TOKEN = "sk-ant-api03-INSIDE-A-BLOB-HHHHHHHHHHHHHHHHHHHH";
    const abs = path.join(home, ".agents", "bin", "blob");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(TOKEN)]));
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "linked:test", out, opts());

    expect(out.files).toHaveLength(0);
    expect(out.warnings.join("\n")).toContain("secret-shaped bytes");
  });

  it("denies the credential stores a $HOME walk can reach", () => {
    // Checked with the REAL matcher, not by looking for pattern strings: the
    // question is whether a path is excluded, and a multi-segment directory rule
    // (".config/gh/") is exactly the kind that can be present and still not match.
    for (const rel of [
      ".ssh/config",
      ".ssh/id_ed25519",
      ".gnupg/secring.gpg",
      ".aws/credentials",
      ".kube/config",
      ".docker/config.json",
      ".config/gh/hosts.yml",
      ".config/gcloud/credentials.db",
      ".password-store/work/aws.gpg",
      "Library/Keychains/login.keychain-db",
      ".local/share/keyrings/login.keyring",
      ".m2/settings.xml",
      ".vault-token",
      ".pgpass",
      ".my.cnf",
      "projects/gsc.env", // "*.env": the prefixed spelling ".env*" rules miss
      // direnv: `.envrc` is a shell script that routinely `export`s live
      // credentials, and `.direnv/` caches the environment it produced. Neither
      // is matched by ".env" / ".env.*" / "*.env".
      ".envrc",
      "code/project/.envrc",
      ".direnv/bin/x",
      "code/project/.direnv/python-3.12/bin/activate",
      ".zsh_history",
      ".node_repl_history",
      "work/server.crt",
      "work/service.p8",
      "vault.kdbx",
    ]) {
      expect({ rel, denied: matchesDeny(rel, [...HOME_DENY]) }).toEqual({ rel, denied: true });
    }
  });

  it("still carries the linked scripts and companion configs it exists for", () => {
    // The other half of the same rule: a denylist that eats `~/.agents/hooks` or
    // `~/.local/bin/x-mcp-start` would silently break every restored setup.
    for (const rel of [
      ".agents/hooks/dispatch.sh",
      ".agents/router/ensure.sh",
      ".agents/bin/sp-api-mcp.sh",
      ".agents/memory/MEMORY.md",
      ".local/bin/gsc-mcp-start",
      ".claude-mem/settings.json",
      ".agents/hooks/id_lookup.sh",
    ]) {
      expect({ rel, denied: matchesDeny(rel, [...HOME_DENY]) }).toEqual({ rel, denied: false });
    }
  });

  it("renders every HOME_DENY pattern as a usable gitignore line", () => {
    const lines = renderRepoGitignore(["claude"]).split("\n");

    // A directory rule keeps its trailing slash and gains the depth-agnostic
    // "**/" prefix; `a/**/b` also matches `a/b`, so one line covers every depth.
    expect(lines).toContain(`${SHARED_HOME_REPO_PREFIX}/**/.config/gh/`);
    expect(lines).toContain(`${SHARED_HOME_REPO_PREFIX}/**/Library/Keychains/`);
    expect(lines).toContain(`${SHARED_HOME_REPO_PREFIX}/**/id_rsa*`);
    expect(lines).toContain(`${SHARED_HOME_REPO_PREFIX}/**/id_ed25519*`);

    // No pattern may reach the file with a leading slash (that would anchor it
    // at the repo root instead of under shared/home) or as an empty rule.
    const scoped = lines.filter((l) => l.startsWith(`${SHARED_HOME_REPO_PREFIX}/`));
    expect(scoped.length).toBe(new Set(scoped).size);
    for (const line of scoped) {
      expect(line.startsWith(`${SHARED_HOME_REPO_PREFIX}/**/`)).toBe(true);
      expect(line).not.toContain("/**//");
      expect(line.trim()).toBe(line);
    }
    // Every pattern made it across.
    expect(scoped.length).toBe(new Set(HOME_DENY).size);
  });

  it("HOME_DENY covers the credential filenames the spec names", () => {
    // Explicit per-algorithm SSH key patterns, not a blanket "id_*" (which also
    // ate arbitrary "id_"-prefixed scripts a hook might legitimately reference).
    for (const pattern of [
      ".env",
      ".netrc",
      "id_rsa*",
      "id_dsa*",
      "id_ecdsa*",
      "id_ed25519*",
      "id_ed25519_sk*",
      "id_ecdsa_sk*",
      ".git-credentials",
      "*.pem",
      ".envrc",
      ".direnv/",
    ]) {
      expect(HOME_DENY).toContain(pattern);
    }
  });

  it("denies SSH private keys by their explicit ssh-keygen basenames, wherever they live", () => {
    // Proves the per-algorithm patterns work standalone, not only via the
    // wholesale ".ssh/" directory rule.
    for (const rel of [
      "backup/id_rsa",
      "backup/id_rsa.bak",
      "work/id_dsa",
      "work/id_ecdsa",
      "keys/id_ed25519",
      "keys/id_ed25519_sk",
      "keys/id_ecdsa_sk",
    ]) {
      expect({ rel, denied: matchesDeny(rel, [...HOME_DENY]) }).toEqual({ rel, denied: true });
    }
  });

  it("no longer denies an ordinary 'id_'-prefixed script (the id_* over-broadness this replaced)", () => {
    // A hook dispatcher named "id_lookup.sh" is not an SSH key and must survive.
    expect(matchesDeny(".agents/hooks/id_lookup.sh", [...HOME_DENY])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Denylist skip visibility (explicit references vs. tree-walk finds)         */
/* -------------------------------------------------------------------------- */

describe("captureHomeFile: denylist skip warnings for explicit references", () => {
  it("warns when a linked hook references a denylisted path (~/.kube/config)", async () => {
    await write(".kube/config", "apiVersion: v1\nusers:\n  - name: x\n    user:\n      token: shh\n");
    const out = emptyOut();

    await captureLinkedHomeFiles(
      ctx(),
      [{ command: "cat ~/.kube/config", source: "claude:settings.json#hooks.X[0]" }],
      "claude",
      out,
      opts(),
    );

    expect(out.files).toHaveLength(0);
    const warning = out.warnings.find((w) => w.includes(".kube/config"));
    expect(warning).toBeDefined();
    expect(warning).toContain("home denylist");
    expect(warning).toContain(".kube/");
    expect(warning).toContain("referenced by");
    expect(warning).toContain("claude:settings.json#hooks.X[0]");
  });

  it("warns when an explicit extraPaths FILE entry (not a directory walk) hits the denylist", async () => {
    await write(".kube/config", "apiVersion: v1\n");
    const out = emptyOut();

    await captureExtraPaths(ctx(), ["~/.kube/config"], "claude", out, opts());

    expect(out.files).toHaveLength(0);
    const warning = out.warnings.find((w) => w.includes(".kube/config"));
    expect(warning).toBeDefined();
    expect(warning).toContain("referenced by");
    expect(warning).toContain("~/.kube/config");
  });

  it("warns when a companion config hits the denylist", async () => {
    // Same mechanism a plugin companion (e.g. claude-mem) would hit if its
    // well-known path ever collided with a denied name.
    await write(".netrc", "machine github.com login fab password hunter2");
    const out = emptyOut();

    await captureHomeFile(ctx(), path.join(home, ".netrc"), "claude", "companion:test-plugin", out, opts());

    expect(out.files).toHaveLength(0);
    const warning = out.warnings.find((w) => w.includes(".netrc"));
    expect(warning).toBeDefined();
    expect(warning).toContain("referenced by test-plugin");
  });

  it("stays a debug-only skip when the same shape of file is found by a tree walk (no warning)", async () => {
    // The user pointed extraPaths at a DIRECTORY, not at this specific file —
    // a denylisted entry turned up while walking it is not something they
    // singled out, so it must not produce a warning line.
    await write(".agents/env/.env", "SECRET=sk-ant-api03-TREEWARN-JJJJJJJJJJJJJJJJJJJJ");
    await write(".agents/env/notes.md", "fine.\n");
    const out = emptyOut();

    await captureHomeTree(
      ctx(),
      path.join(home, ".agents", "env"),
      "claude",
      "extraPaths:~/.agents/env",
      out,
      opts(),
    );

    expect(out.files.map((f) => f.repoPath)).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/.agents/env/notes.md`,
    ]);
    expect(out.warnings).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Caps                                                                        */
/* -------------------------------------------------------------------------- */

describe("captureHomeFile: size cap", () => {
  it("warns and skips a file above the 1 MiB limit", async () => {
    const abs = await write(".agents/big.txt", "x".repeat(MAX_HOME_FILE_BYTES + 1));
    const out = emptyOut();

    await captureHomeFile(ctx(), abs, "claude", "extraPaths:~/.agents", out, opts());

    expect(out.files).toHaveLength(0);
    expect(out.warnings.join("\n")).toContain("exceeds the");
  });
});

describe("captureHomeTree", () => {
  it("walks a directory, keeping order and skipping denylisted entries", async () => {
    await write(".agents/hooks/a.sh", "#!/bin/sh\n", 0o755);
    await write(".agents/hooks/nested/b.sh", "#!/bin/sh\n");
    await write(".agents/hooks/.env", "SECRET=sk-ant-api03-TREE-IIIIIIIIIIIIIIIIIIII");
    await write(".agents/hooks/notes.log", "noise");
    await write(".agents/hooks/node_modules/pkg/index.js", "module.exports={}");
    const out = emptyOut();

    await captureHomeTree(
      ctx(),
      path.join(home, ".agents", "hooks"),
      "claude",
      "extraPaths:~/.agents/hooks",
      out,
      opts(),
    );

    expect(out.files.map((f) => f.repoPath)).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/.agents/hooks/a.sh`,
      `${SHARED_HOME_REPO_PREFIX}/.agents/hooks/nested/b.sh`,
    ]);
  });

  it("stops with a warning once the file cap is hit", async () => {
    for (const n of [1, 2, 3, 4, 5]) await write(`.agents/many/f${n}.txt`, `${n}`);
    const out = emptyOut();

    await captureHomeTree(
      ctx(),
      path.join(home, ".agents", "many"),
      "claude",
      "extraPaths:~/.agents/many",
      out,
      opts(2),
    );

    expect(out.files).toHaveLength(2);
    expect(out.warnings.join("\n")).toContain("stopped walking");
  });

  it("refuses a tree that lives under a tool home", async () => {
    await write(".claude/scripts/x.sh", "#!/bin/sh\n");
    const out = emptyOut();

    await captureHomeTree(
      ctx(),
      path.join(toolHome, "scripts"),
      "claude",
      "extraPaths:~/.claude/scripts",
      out,
      opts(),
    );

    expect(out.files).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* extraPaths                                                                  */
/* -------------------------------------------------------------------------- */

describe("resolveExtraPath", () => {
  it("accepts ~/x, x and an absolute path under $HOME", () => {
    expect(resolveExtraPath("~/.agents/hooks", "/Users/fab")).toBe("/Users/fab/.agents/hooks");
    expect(resolveExtraPath(".agents/hooks", "/Users/fab")).toBe("/Users/fab/.agents/hooks");
    expect(resolveExtraPath("/Users/fab/.agents/hooks", "/Users/fab")).toBe(
      "/Users/fab/.agents/hooks",
    );
    expect(resolveExtraPath("$HOME/.agents", "/Users/fab")).toBe("/Users/fab/.agents");
  });

  it("rejects $HOME itself, blank entries and anything outside $HOME", () => {
    expect(resolveExtraPath("", "/Users/fab")).toBeNull();
    expect(resolveExtraPath("~", "/Users/fab")).toBeNull();
    expect(resolveExtraPath("/etc", "/Users/fab")).toBeNull();
    expect(resolveExtraPath("~/../root", "/Users/fab")).toBeNull();
  });
});

describe("captureExtraPaths", () => {
  it("captures a configured dir and a configured file, and warns on an outside path", async () => {
    await write(".agents/memory/notes.md", "Notes.\n");
    await write(".config/mytool.json", '{"a":1}');
    const out = emptyOut();

    await captureExtraPaths(
      ctx(),
      ["~/.agents/memory", ".config/mytool.json", "/etc/hosts", "~/.agents/absent"],
      "claude",
      out,
      opts(),
    );

    expect(out.files.map((f) => f.repoPath).sort()).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/.agents/memory/notes.md`,
      `${SHARED_HOME_REPO_PREFIX}/.config/mytool.json`,
    ]);
    expect(out.warnings.join("\n")).toContain("/etc/hosts");
    // A configured path that simply does not exist here is not an error.
    expect(out.warnings.join("\n")).not.toContain("absent");
  });

  it("reaches INSIDE a tool home when the user names it explicitly", async () => {
    // ~/.claude/.agents is exactly the "add via extraPaths" case status hints
    // at: the tool home's excludeRoots must not block an explicit extraPaths
    // entry, unlike a linked script/companion (see captureLinkedHomeFiles).
    await write(".claude/.agents/notes.md", "Third-party agent notes.\n");
    const out = emptyOut();

    await captureExtraPaths(ctx(), ["~/.claude/.agents"], "claude", out, opts());

    expect(out.files.map((f) => f.repoPath)).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/.claude/.agents/notes.md`,
    ]);
  });

  it("skips a file already captured by the tool this run (alreadyCaptured)", async () => {
    const already = await write(".claude/.agents/foo.md", "Already captured by claude.\n");
    await write(".claude/.agents/bar.md", "Not captured yet.\n");
    const out = emptyOut();

    await captureExtraPaths(ctx(), ["~/.claude/.agents"], "claude", out, {
      ...opts(),
      alreadyCaptured: new Set([already]),
    });

    expect(out.files.map((f) => f.repoPath)).toEqual([
      `${SHARED_HOME_REPO_PREFIX}/.claude/.agents/bar.md`,
    ]);
  });
});

describe("captureLinkedHomeFiles: still refuses tool-home paths", () => {
  it("does not carry a linked script that lives inside a tool home", async () => {
    // Unlike extraPaths, a linked script/companion must stay out of every
    // tool home — excludeRoots keeps applying here regardless of the new
    // alreadyCaptured mechanism (which linked-script capture never sets).
    const abs = await write(".claude/scripts/dispatch.sh", "#!/bin/sh\nexec \"$@\"\n");
    const out = emptyOut();

    await captureLinkedHomeFiles(
      ctx(),
      [{ command: abs, source: "claude:settings.json#hooks.X[0]" }],
      "claude",
      out,
      opts(),
    );

    expect(out.files).toHaveLength(0);
  });
});

describe("computeAlreadyCaptured", () => {
  const toolHomeFor = (tool: "claude" | "codex"): string =>
    tool === "claude" ? "/Users/fab/.claude" : "/Users/fab/.codex";

  it("maps <tool>/files/<rel> entries to absolute paths under the tool's home", () => {
    const results: CaptureResult[] = [
      {
        tool: "claude",
        files: [
          { repoPath: "claude/files/settings.json", content: "{}" },
          { repoPath: "claude/files/agents/x.md", content: "x" },
        ],
        symlinks: [{ repoPath: "claude/files/skills/y", target: "../../.agents/skills/y" }],
        manifest: emptyManifest("claude"),
        secrets: [],
        warnings: [],
      },
    ];

    const out = computeAlreadyCaptured(results, toolHomeFor);

    // `path.join` emits "\" on Windows while the POSIX-rooted fixture literals
    // keep "/". Compare normalized: the routing is the subject, not separators.
    expect(toPosixAll(out).sort()).toEqual(
      [
        "/Users/fab/.claude/settings.json",
        "/Users/fab/.claude/agents/x.md",
        "/Users/fab/.claude/skills/y",
      ].sort(),
    );
  });

  it("ignores every other repo root (memories, user data, shared/home)", () => {
    const results: CaptureResult[] = [
      {
        tool: "claude",
        files: [
          { repoPath: "claude/memories/proj/notes.md", content: "n" },
          { repoPath: "shared/home/.agents/hooks/dispatch.sh", content: "#!/bin/sh\n" },
        ],
        symlinks: [],
        manifest: emptyManifest("claude"),
        secrets: [],
        warnings: [],
      },
      {
        tool: "cursor",
        files: [{ repoPath: "cursor/user/settings.json", content: "{}" }],
        symlinks: [],
        manifest: emptyManifest("cursor"),
        secrets: [],
        warnings: [],
      },
    ];

    const out = computeAlreadyCaptured(results, (tool) =>
      tool === "claude" ? "/Users/fab/.claude" : "/Users/fab/.cursor",
    );

    expect(out.size).toBe(0);
  });
});

describe("dedupeByRepoPath", () => {
  it("keeps the first entry for each repo path", () => {
    const files = [
      { repoPath: "shared/home/a", content: "first" },
      { repoPath: "shared/home/a", content: "second" },
      { repoPath: "shared/home/b", content: "b" },
    ];
    expect(dedupeByRepoPath(files).map((f) => f.content)).toEqual(["first", "b"]);
  });
});
