/**
 * Unit tests for the one path check a restore performs before it writes
 * (src/utils/safe-path.ts), against real temp dirs.
 *
 * Two failure modes matter here and they pull in opposite directions:
 *   - too PERMISSIVE lets a pull follow a dotfile-manager symlink out of the
 *     tree it believes it owns;
 *   - too STRICT silently drops files a restore should have written, which
 *     looks identical to "the backup never had it".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findSymlinkComponent } from "../../src/utils/safe-path.js";
import { fs as realFs } from "../../src/utils/fs.js";

let root: string;
let home: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-safepath-"));
  home = path.join(root, "home");
  await fsp.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("findSymlinkComponent: what it lets through", () => {
  it("allows a destination whose components are all real (or missing)", async () => {
    await fsp.mkdir(path.join(home, ".agents"), { recursive: true });
    expect(
      await findSymlinkComponent(realFs, home, path.join(home, ".agents", "hooks", "x.sh")),
    ).toBeNull();
  });

  it("allows a component that merely BEGINS with two dots", async () => {
    // The regression: the guard rejected any `path.relative` result starting
    // with "..", so an ordinary directory named "..config" — relativizing to
    // "..config/file" — read as "escapes the root" and its file was skipped.
    // Only the `..` SEGMENT is an escape.
    const weird = path.join(home, "..config");
    await fsp.mkdir(weird, { recursive: true });
    await fsp.writeFile(path.join(weird, "file"), "x\n");

    expect(await findSymlinkComponent(realFs, home, path.join(weird, "file"))).toBeNull();
    expect(await findSymlinkComponent(realFs, home, path.join(home, "..data", "y"))).toBeNull();
    expect(await findSymlinkComponent(realFs, home, path.join(home, "..", "x"))).not.toBeNull();
  });
});

describe("findSymlinkComponent: what it refuses", () => {
  it("names the symlinked PARENT that would redirect the write", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await fsp.mkdir(elsewhere, { recursive: true });
    await fsp.mkdir(path.join(home, ".local"), { recursive: true });
    await fsp.symlink(elsewhere, path.join(home, ".local", "bin"));

    expect(
      await findSymlinkComponent(realFs, home, path.join(home, ".local", "bin", "x-mcp-start")),
    ).toBe(path.join(home, ".local", "bin"));
  });

  it("names a symlinked LEAF too", async () => {
    const target = path.join(root, "target.sh");
    await fsp.writeFile(target, "original\n");
    await fsp.mkdir(path.join(home, ".agents"), { recursive: true });
    const leaf = path.join(home, ".agents", "dispatch.sh");
    await fsp.symlink(target, leaf);

    expect(await findSymlinkComponent(realFs, home, leaf)).toBe(leaf);
  });

  it("refuses the root itself and anything genuinely outside it", async () => {
    // "Cannot validate" must read as "do not write", so these return `dest`.
    expect(await findSymlinkComponent(realFs, home, home)).toBe(home);
    const outside = path.join(root, "elsewhere", "x");
    expect(await findSymlinkComponent(realFs, home, outside)).toBe(outside);
  });
});
