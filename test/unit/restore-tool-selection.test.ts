import { describe, expect, it } from "vitest";

import { selectToolsForRestore } from "../../src/commands/restore.js";
import type { ArbellaMeta, ToolId } from "../../src/types.js";

function metaWithTools(tools: ToolId[]): ArbellaMeta {
  return {
    schemaVersion: 1,
    arbellaVersion: "0.1.1",
    tools,
    options: {
      includeSecrets: false,
      includeMemories: false,
      sourceOfTruth: "local",
    },
    createdAt: "2026-05-31T00:00:00.000Z",
    sharedInstructions: false,
  };
}

describe("restore tool selection", () => {
  it("restores every captured tool by default even when local config is stale", () => {
    const tools = selectToolsForRestore(
      metaWithTools(["claude", "codex", "cursor"]),
      undefined,
      ["claude", "codex"],
    );

    expect(tools).toEqual(["claude", "codex", "cursor"]);
  });

  it("still lets --tools explicitly narrow the restore", () => {
    const tools = selectToolsForRestore(
      metaWithTools(["claude", "codex", "cursor"]),
      ["cursor"],
      ["claude", "codex"],
    );

    expect(tools).toEqual(["cursor"]);
  });
});
