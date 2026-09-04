/**
 * Regression tests for "status says clean, the next push commits anyway".
 *
 * Every push rewrites arbella.json (`createdAt`) and README.md (its "Generated:"
 * line) unconditionally, so a run that changed nothing else still produced a
 * commit — while `status`, which ignores exactly those two files, had just
 * called the repo clean. `skipUnchangedPush` closes that gap: when the only
 * working-tree changes are those two paths AND the new meta is identical apart
 * from `createdAt`, it puts both files back byte-for-byte and the caller skips
 * the commit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { skipUnchangedPush } from "../../src/commands/backup.js";
import type { PreviousGenerated } from "../../src/commands/backup.js";
import { serialize } from "../../src/core/manifest/index.js";
import type { ArbellaMeta } from "../../src/types.js";

let repoRoot: string;

const OLD_STAMP = "2026-01-01T00:00:00.000Z";
const NEW_STAMP = "2026-02-02T00:00:00.000Z";

function meta(overrides: Partial<ArbellaMeta> = {}): ArbellaMeta {
  return {
    schemaVersion: 1,
    arbellaVersion: "0.3.0",
    tools: ["claude", "codex"],
    options: { includeSecrets: false, includeMemories: true, sourceOfTruth: "local" },
    createdAt: OLD_STAMP,
    sharedInstructions: true,
    ...overrides,
  };
}

function readme(stamp: string): string {
  return `# arbella backup\n\n> Generated: ${stamp}\n`;
}

async function read(name: string): Promise<string> {
  return fsp.readFile(path.join(repoRoot, name), "utf8");
}

/**
 * The state a push leaves behind just before committing: the previous (committed)
 * bytes captured up front, and both generated files already rewritten with the
 * new timestamp.
 */
async function afterRewrite(newMeta: ArbellaMeta): Promise<PreviousGenerated> {
  const previous: PreviousGenerated = {
    metaRaw: serialize(meta()),
    meta: meta(),
    readme: readme(OLD_STAMP),
  };
  await fsp.writeFile(path.join(repoRoot, "arbella.json"), previous.metaRaw!);
  await fsp.writeFile(path.join(repoRoot, "README.md"), previous.readme!);

  await fsp.writeFile(path.join(repoRoot, "arbella.json"), serialize(newMeta));
  await fsp.writeFile(path.join(repoRoot, "README.md"), readme(NEW_STAMP));
  return previous;
}

beforeEach(async () => {
  repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-noop-"));
});

afterEach(async () => {
  await fsp.rm(repoRoot, { recursive: true, force: true });
});

describe("skipUnchangedPush: a second push with identical content commits nothing", () => {
  it("restores both timestamp-only files and reports the run as a no-op", async () => {
    const previous = await afterRewrite(meta({ createdAt: NEW_STAMP }));

    const skipped = await skipUnchangedPush({
      repoRoot,
      changedPaths: ["arbella.json", "README.md"],
      meta: meta({ createdAt: NEW_STAMP }),
      previous,
    });

    expect(skipped).toBe(true);
    // Byte-for-byte back to what is committed: nothing left for git to commit.
    expect(await read("arbella.json")).toBe(previous.metaRaw);
    expect(await read("README.md")).toBe(previous.readme);
  });

  it("removes a README this run invented when none was committed", async () => {
    const previous = await afterRewrite(meta({ createdAt: NEW_STAMP }));
    const withoutReadme: PreviousGenerated = { ...previous, readme: undefined };

    const skipped = await skipUnchangedPush({
      repoRoot,
      changedPaths: ["arbella.json", "README.md"],
      meta: meta({ createdAt: NEW_STAMP }),
      previous: withoutReadme,
    });

    expect(skipped).toBe(true);
    await expect(read("README.md")).rejects.toThrow();
  });
});

describe("skipUnchangedPush: anything substantive still commits", () => {
  it("commits when a captured file changed", async () => {
    const previous = await afterRewrite(meta({ createdAt: NEW_STAMP }));

    const skipped = await skipUnchangedPush({
      repoRoot,
      changedPaths: ["arbella.json", "README.md", "claude/files/settings.json"],
      meta: meta({ createdAt: NEW_STAMP }),
      previous,
    });

    expect(skipped).toBe(false);
    // The freshly written files are left exactly as the push wrote them.
    expect(await read("README.md")).toBe(readme(NEW_STAMP));
  });

  it("commits on a first push (no previous arbella.json)", async () => {
    const previous = await afterRewrite(meta({ createdAt: NEW_STAMP }));

    const skipped = await skipUnchangedPush({
      repoRoot,
      changedPaths: ["arbella.json", "README.md"],
      meta: meta({ createdAt: NEW_STAMP }),
      previous: { ...previous, metaRaw: undefined, meta: undefined },
    });

    expect(skipped).toBe(false);
  });

  it("commits on a version bump", async () => {
    const bumped = meta({ createdAt: NEW_STAMP, arbellaVersion: "0.4.0" });
    const previous = await afterRewrite(bumped);

    const skipped = await skipUnchangedPush({
      repoRoot,
      changedPaths: ["arbella.json", "README.md"],
      meta: bumped,
      previous,
    });

    expect(skipped).toBe(false);
  });

  it("commits when the tool list changed", async () => {
    const grown = meta({ createdAt: NEW_STAMP, tools: ["claude", "codex", "cursor"] });
    const previous = await afterRewrite(grown);

    const skipped = await skipUnchangedPush({
      repoRoot,
      changedPaths: ["arbella.json", "README.md"],
      meta: grown,
      previous,
    });

    expect(skipped).toBe(false);
  });

  it("commits when the shared-instructions flag flipped", async () => {
    const flipped = meta({ createdAt: NEW_STAMP, sharedInstructions: false });
    const previous = await afterRewrite(flipped);

    const skipped = await skipUnchangedPush({
      repoRoot,
      changedPaths: ["arbella.json", "README.md"],
      meta: flipped,
      previous,
    });

    expect(skipped).toBe(false);
  });
});
