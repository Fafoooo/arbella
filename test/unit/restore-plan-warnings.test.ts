/**
 * Unit test for the skipped-project-MCP-dirs warning printed by the dry-run
 * plan (src/commands/restore.ts, `printPlan`).
 *
 * The warning used to live inside src/adapters/claude/mcp.ts's `planMcpMerge`,
 * deduped via a module-level `WeakSet<ToolManifest>` — hidden global state
 * keyed on object identity. It now lives on `RestorePlan.skippedProjectDirs`
 * (populated once in `buildPlan` from the same MCP merge plan that decides
 * `needsEnv`), and `printPlan` is the one place that turns it into a line, so
 * the message can only ever appear once per `--dry-run` and only ever name
 * directories the merge actually skipped.
 */

import { describe, it, expect } from "vitest";

import { printPlan } from "../../src/commands/restore.js";
import type { ArbellaMeta, Logger, RestorePlan } from "../../src/types.js";

function meta(): ArbellaMeta {
  return {
    schemaVersion: 1,
    arbellaVersion: "0.1.1",
    tools: ["claude"],
    options: {
      includeSecrets: false,
      includeMemories: false,
      sourceOfTruth: "local",
    },
    createdAt: "2026-05-31T00:00:00.000Z",
    sharedInstructions: false,
  };
}

function plan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    tools: ["claude"],
    actions: [],
    missingClis: [],
    willBackupExisting: true,
    skippedProjectDirs: [],
    ...overrides,
  };
}

/** A Logger that records every line, tagged with its level. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
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
    },
  };
}

describe("printPlan: skipped-project-MCP-dirs warning", () => {
  it("warns exactly once, naming the skipped directories, when the plan carries any", () => {
    const { logger, lines } = recordingLogger();

    printPlan(
      plan({ skippedProjectDirs: ["/home/fab/programming/gone"] }),
      meta(),
      logger,
    );

    const skipWarnings = lines.filter(
      (l) => l.startsWith("warn:") && l.includes("skipped MCP servers"),
    );
    expect(skipWarnings).toHaveLength(1);
    expect(skipWarnings[0]).toContain("/home/fab/programming/gone");
    expect(skipWarnings[0]).toContain("arbella pull");
  });

  it("does not warn when the plan carries no skipped directories", () => {
    const { logger, lines } = recordingLogger();

    printPlan(plan({ skippedProjectDirs: [] }), meta(), logger);

    expect(lines.some((l) => l.includes("skipped MCP servers"))).toBe(false);
  });
});
