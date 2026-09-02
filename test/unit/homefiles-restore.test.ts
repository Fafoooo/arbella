/**
 * Unit tests for `shared/home` RESTORE (WP-B / B4), against real temp dirs.
 *
 * A pull takes both the CONTENT and the PATH of every home file from the backup
 * repo, so the tests that matter here are the refusals: a destination that only
 * looks like it is under $HOME must not be written, and the dry run must refuse
 * exactly what the real pass refuses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  planHomeFileActions,
  restoreHomeFiles,
} from "../../src/core/homefiles/restore.js";
import type { HomeRestoreServices } from "../../src/core/homefiles/restore.js";
import { SHARED_HOME_REPO_PREFIX } from "../../src/core/homefiles/capture.js";
import { fs as realFs } from "../../src/utils/fs.js";
import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import type { CapturedFile, SourceOfTruth } from "../../src/types.js";

let root: string;
let home: string;
let safetyDir: string;
let warnings: string[];

function ctx(sourceOfTruth: SourceOfTruth = "repo"): HomeRestoreServices {
  return {
    fs: realFs,
    log: {
      info() {},
      success() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
      step() {},
      debug() {},
    },
    sanitizer: createSanitizer(),
    templater: createTemplater(),
    vars: makeVariables(home, "fab", "linux"),
    os: "linux",
    env: {},
    sourceOfTruth,
    dryRun: false,
  };
}

/** One stored home file at `shared/home/<rel>`. */
function file(rel: string, content = "#!/bin/sh\n", mode?: number): CapturedFile {
  return {
    repoPath: `${SHARED_HOME_REPO_PREFIX}/${rel}`,
    content,
    ...(mode !== undefined ? { mode } : {}),
  };
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-homerestore-"));
  home = path.join(root, "home");
  safetyDir = path.join(root, "safety");
  await fsp.mkdir(home, { recursive: true });
  warnings = [];
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("restoreHomeFiles: refuses to write through a symlink", () => {
  it("skips a file whose PARENT directory is a link, and says why", async () => {
    // The shape a dotfile manager creates: ~/.local/bin is a link into a git
    // checkout. Writing "~/.local/bin/x" would land in that checkout, not $HOME.
    const elsewhere = path.join(root, "elsewhere");
    await fsp.mkdir(elsewhere, { recursive: true });
    await fsp.mkdir(path.join(home, ".local"), { recursive: true });
    await fsp.symlink(elsewhere, path.join(home, ".local", "bin"));

    const written = await restoreHomeFiles(ctx(), [file(".local/bin/x-mcp-start")], {
      safetyDir,
    });

    expect(written).toBe(0);
    expect(await realFs.exists(path.join(elsewhere, "x-mcp-start"))).toBe(false);
    expect(warnings.join("\n")).toContain("is a symlink");
    expect(warnings.join("\n")).toContain(".local/bin");
  });

  it("skips a LEAF that is a link, rather than overwriting its target", async () => {
    const target = path.join(root, "target.sh");
    await fsp.writeFile(target, "original\n");
    await fsp.mkdir(path.join(home, ".agents"), { recursive: true });
    await fsp.symlink(target, path.join(home, ".agents", "dispatch.sh"));

    const written = await restoreHomeFiles(ctx(), [file(".agents/dispatch.sh", "new\n")], {
      safetyDir,
    });

    expect(written).toBe(0);
    expect(await fsp.readFile(target, "utf8")).toBe("original\n");
  });

  it("writes normally when every component is a real directory", async () => {
    const written = await restoreHomeFiles(
      ctx(),
      [file(".agents/hooks/dispatch.sh", "#!/bin/sh\nexec \"$@\"\n", 0o755)],
      { safetyDir },
    );

    expect(written).toBe(1);
    const dest = path.join(home, ".agents", "hooks", "dispatch.sh");
    expect(await fsp.readFile(dest, "utf8")).toBe('#!/bin/sh\nexec "$@"\n');
    expect((await fsp.stat(dest)).mode & 0o777).toBe(0o755);
    expect(warnings).toEqual([]);
  });

  it("plans exactly what it would write — a blocked file is not advertised", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await fsp.mkdir(elsewhere, { recursive: true });
    await fsp.mkdir(path.join(home, ".local"), { recursive: true });
    await fsp.symlink(elsewhere, path.join(home, ".local", "bin"));

    const actions = await planHomeFileActions(ctx(), [
      file(".local/bin/x-mcp-start"),
      file(".agents/hooks/dispatch.sh"),
    ]);

    expect(actions.map((a) => a.targetPath)).toEqual([
      path.join(home, ".agents", "hooks", "dispatch.sh"),
    ]);
  });
});
