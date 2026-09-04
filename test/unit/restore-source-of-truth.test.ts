/**
 * Unit tests for the two post-processing steps that used to ignore
 * `sourceOfTruth: "local"` — the one setting whose whole promise is "a pull
 * never overwrites what is already on this machine".
 *
 *   - claude's enabledPlugins overlay (src/adapters/claude/restore.ts). The
 *     frozen-files pass KEEPS an existing settings.json under "local", and the
 *     overlay then rewrote the very key the user is most likely to have changed
 *     by hand: which plugins are on. A plugin disabled here came back enabled.
 *   - the shared-instructions deployment (src/commands/restore.ts, R9), which
 *     wrote ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md unconditionally, and
 *     through whatever symlink happened to sit at the destination.
 *
 * Both are also asserted in the dry-run direction: the plan action / the
 * "Would deploy" line has to disappear alongside the write.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { itPosixHost } from "../helpers/platform.js";

import {
  restore as restoreClaude,
  planActions as claudePlanActions,
} from "../../src/adapters/claude/restore.js";
import { REPO_PREFIX } from "../../src/adapters/claude/paths.js";
import { deploySharedInstructions } from "../../src/commands/restore.js";
import { SHARED_INSTRUCTIONS_REPO_PATH } from "../../src/core/manifest/index.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import { emptyManifest } from "../../src/core/manifest/index.js";
import type { RestoreContext, RestoreData } from "../../src/adapters/adapter.interface.js";
import type { Logger, ToolManifest } from "../../src/types.js";

const sanitizer = createSanitizer();
const templater = createTemplater();

let tmpRoot: string;
let lines: string[];

/** A Logger that records every line, tagged with its level. */
function recordingLogger(): Logger {
  return {
    info(msg: string) {
      lines.push(`info: ${msg}`);
    },
    success(msg: string) {
      lines.push(`success: ${msg}`);
    },
    warn(msg: string) {
      lines.push(`warn: ${msg}`);
    },
    error(msg: string) {
      lines.push(`error: ${msg}`);
    },
    step(msg: string) {
      lines.push(`step: ${msg}`);
    },
    debug(msg: string) {
      lines.push(`debug: ${msg}`);
    },
  };
}

beforeEach(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-restore-sot-"));
  tmpRoot = await fsp.realpath(dir);
  lines = [];
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* claude: enabledPlugins vs sourceOfTruth                                     */
/* -------------------------------------------------------------------------- */

function claudeCtx(
  toolHome: string,
  home: string,
  sourceOfTruth: "local" | "repo",
): RestoreContext {
  return {
    fs: realFs,
    log: recordingLogger(),
    sanitizer,
    templater,
    vars: makeVariables(home, "fab", "linux", toolHome),
    os: "linux",
    env: {},
    toolHome,
    repoToolDir: path.join(tmpRoot, "repo", "claude"),
    repoRoot: path.join(tmpRoot, "repo"),
    sourceOfTruth,
    dryRun: false,
  };
}

function manifestWithEnabled(enabled: Record<string, boolean>): ToolManifest {
  return { ...emptyManifest("claude"), enabledPlugins: enabled };
}

async function claudeHome(name: string): Promise<{ home: string; toolHome: string }> {
  const home = path.join(tmpRoot, name);
  const toolHome = path.join(home, ".claude");
  await fsp.mkdir(toolHome, { recursive: true });
  return { home, toolHome };
}

describe("claude restore: enabledPlugins honors sourceOfTruth", () => {
  it("keeps a locally DISABLED plugin when local is authoritative", async () => {
    const { home, toolHome } = await claudeHome("enabled-local");
    const settings = path.join(toolHome, "settings.json");
    await fsp.writeFile(settings, JSON.stringify({ enabledPlugins: { "a@m": false } }, null, 2));

    const ctx = claudeCtx(toolHome, home, "local");
    const data: RestoreData = {
      manifest: manifestWithEnabled({ "a@m": true }),
      // The repo also carries settings.json; the file pass keeps the local copy.
      files: [
        {
          repoPath: `${REPO_PREFIX}/settings.json`,
          content: JSON.stringify({ enabledPlugins: { "a@m": true } }, null, 2),
        },
      ],
      symlinks: [],
    };

    const actions = await claudePlanActions(ctx, data);
    await restoreClaude(ctx, data);

    const onDisk = JSON.parse(await fsp.readFile(settings, "utf8")) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(onDisk.enabledPlugins["a@m"]).toBe(false);
    // The dry run must not advertise the overlay it will not perform.
    expect(actions.filter((a) => a.type === "enable-plugin")).toEqual([]);
  });

  it("still applies the overlay when the repo is authoritative", async () => {
    const { home, toolHome } = await claudeHome("enabled-repo");
    const settings = path.join(toolHome, "settings.json");
    await fsp.writeFile(settings, JSON.stringify({ enabledPlugins: { "a@m": false } }, null, 2));

    const ctx = claudeCtx(toolHome, home, "repo");
    const data: RestoreData = {
      manifest: manifestWithEnabled({ "a@m": true }),
      files: [],
      symlinks: [],
    };

    const actions = await claudePlanActions(ctx, data);
    await restoreClaude(ctx, data);

    const onDisk = JSON.parse(await fsp.readFile(settings, "utf8")) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(onDisk.enabledPlugins["a@m"]).toBe(true);
    expect(actions.filter((a) => a.type === "enable-plugin")).toHaveLength(1);
  });

  it("applies the overlay under local policy when settings.json is NEW", async () => {
    // Nothing was here before the pull, so nothing local is being overwritten:
    // the settings.json this restore just placed must get its enabledPlugins.
    const { home, toolHome } = await claudeHome("enabled-local-new");
    const ctx = claudeCtx(toolHome, home, "local");
    const data: RestoreData = {
      manifest: manifestWithEnabled({ "a@m": true }),
      files: [{ repoPath: `${REPO_PREFIX}/settings.json`, content: "{}\n" }],
      symlinks: [],
    };

    const actions = await claudePlanActions(ctx, data);
    await restoreClaude(ctx, data);

    const onDisk = JSON.parse(
      await fsp.readFile(path.join(toolHome, "settings.json"), "utf8"),
    ) as { enabledPlugins: Record<string, boolean> };
    expect(onDisk.enabledPlugins["a@m"]).toBe(true);
    expect(actions.filter((a) => a.type === "enable-plugin")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Shared instructions (R9)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * deploySharedInstructions resolves its destinations through `toolHomeDir()`,
 * i.e. from the real $HOME. Point $HOME at a temp dir for the duration.
 */
async function withTempHome<T>(name: string, fn: (home: string) => Promise<T>): Promise<T> {
  const home = path.join(tmpRoot, name);
  await fsp.mkdir(home, { recursive: true });
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

/** Write shared/instructions.md into a fresh repo root and return that root. */
async function repoWithSharedInstructions(content: string): Promise<string> {
  const repoRoot = path.join(tmpRoot, "shared-repo");
  const abs = path.join(repoRoot, ...SHARED_INSTRUCTIONS_REPO_PATH.split("/"));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  return repoRoot;
}

describe("deploySharedInstructions: containment + sourceOfTruth", () => {
  itPosixHost("refuses a destination that is reached through a symlink", async () => {
    const repoRoot = await repoWithSharedInstructions("# shared\n");
    const outside = path.join(tmpRoot, "outside-instructions");
    await fsp.mkdir(outside, { recursive: true });

    await withTempHome("home-link", async (home) => {
      const toolHome = path.join(home, ".claude");
      await fsp.mkdir(toolHome, { recursive: true });
      // A planted link AT the destination: following it writes outside ~/.claude.
      await fsp.symlink(path.join(outside, "stolen.md"), path.join(toolHome, "CLAUDE.md"));

      await deploySharedInstructions(repoRoot, ["claude"], false, "repo", recordingLogger());

      expect(await realFs.exists(path.join(outside, "stolen.md"))).toBe(false);
      expect(lines.some((l) => l.startsWith("warn:") && l.includes("symlink"))).toBe(true);
    });
  });

  it("keeps an existing instructions file when local is authoritative", async () => {
    const repoRoot = await repoWithSharedInstructions("# from repo\n");

    await withTempHome("home-local", async (home) => {
      const dest = path.join(home, ".claude", "CLAUDE.md");
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, "# mine\n");

      await deploySharedInstructions(repoRoot, ["claude"], false, "local", recordingLogger());

      expect(await fsp.readFile(dest, "utf8")).toBe("# mine\n");
      expect(lines.some((l) => l.startsWith("step: Deployed"))).toBe(false);
    });
  });

  it("dry-run agrees: no 'Would deploy' line for a file local policy keeps", async () => {
    const repoRoot = await repoWithSharedInstructions("# from repo\n");

    await withTempHome("home-local-dry", async (home) => {
      const dest = path.join(home, ".claude", "CLAUDE.md");
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, "# mine\n");

      await deploySharedInstructions(repoRoot, ["claude"], true, "local", recordingLogger());

      expect(lines.some((l) => l.includes("Would deploy"))).toBe(false);
    });
  });

  it("deploys when the target is absent, whatever the policy", async () => {
    const repoRoot = await repoWithSharedInstructions("# from repo\n");

    await withTempHome("home-fresh", async (home) => {
      await fsp.mkdir(path.join(home, ".claude"), { recursive: true });

      await deploySharedInstructions(repoRoot, ["claude"], false, "local", recordingLogger());

      expect(await fsp.readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "# from repo\n",
      );
    });
  });
});
