/**
 * Unit tests for the manifest core (src/core/manifest).
 *
 * Build/read round-trip: a ToolManifest (and the top-level ArbellaMeta) built in
 * memory, serialized deterministically, then parsed back from that JSON, equals
 * what we started with. Also covers the R9 shared-instructions decision helpers
 * and the deterministic (sorted-key) serializer.
 */

import { describe, it, expect } from "vitest";

import {
  buildManifest,
  parseManifest,
  emptyManifest,
  buildArbellaMeta,
  parseMeta,
  serialize,
  shouldShareInstructions,
  buildSharedInstructionsFile,
  sharedInstructionsTargets,
  SHARED_INSTRUCTIONS_REPO_PATH,
} from "../../src/core/manifest/index.js";
import { MANIFEST_SCHEMA_VERSION } from "../../src/core/manifest/schema.js";
import type { ArbellaConfig } from "../../src/types.js";

describe("manifest: build -> serialize -> parse round-trip", () => {
  it("round-trips a populated ToolManifest", () => {
    const built = buildManifest("claude", {
      plugins: [
        {
          id: "superpowers@claude-plugins-official",
          name: "superpowers",
          marketplace: "claude-plugins-official",
          version: "5.1.0",
          enabled: true,
          scope: "user",
        },
      ],
      marketplaces: [
        { id: "claude-plugins-official", sourceType: "github", source: "anthropics/claude-plugins-official" },
      ],
      skills: [
        { name: "humanizer", source: "skills.sh", installCommand: "npx skills add humanizer", symlinked: true },
        { name: "my-frozen", source: "frozen", symlinked: false },
      ],
      npmGlobals: [{ package: "greppy", version: "1.2.3" }],
      enabledPlugins: { "superpowers@claude-plugins-official": true },
    });

    const json = serialize(built);
    const reparsed = parseManifest(JSON.parse(json));

    // The reparsed manifest deep-equals the built one (full round-trip).
    expect(reparsed).toEqual(built);
    expect(reparsed.tool).toBe("claude");
    expect(reparsed.plugins).toHaveLength(1);
    expect(reparsed.skills).toHaveLength(2);
  });

  it("round-trips an empty manifest", () => {
    const empty = emptyManifest("codex");
    const reparsed = parseManifest(JSON.parse(serialize(empty)));
    expect(reparsed).toEqual(empty);
    expect(reparsed.plugins).toEqual([]);
    expect(reparsed.marketplaces).toEqual([]);
    expect(reparsed.enabledPlugins).toEqual({});
  });

  it("de-duplicates list entries by their key (first wins)", () => {
    const built = buildManifest("claude", {
      npmGlobals: [
        { package: "greppy", version: "1.0.0" },
        { package: "greppy", version: "9.9.9" }, // duplicate package -> dropped
        { package: "gemini-cli" },
      ],
    });
    expect(built.npmGlobals).toHaveLength(2);
    expect(built.npmGlobals[0]).toEqual({ package: "greppy", version: "1.0.0" });
  });

  it("rejects a malformed manifest on parse", () => {
    // tool must be one of the enum members.
    expect(() => parseManifest({ tool: "emacs", plugins: [] })).toThrow();
  });
});

describe("manifest: ArbellaMeta round-trip", () => {
  const config: ArbellaConfig = {
    repo: { provider: "generic", url: "", localPath: "" },
    sourceOfTruth: "local",
    autoBackup: "off",
    includeSecrets: false,
    includeMemories: true,
    tools: ["claude", "codex"],
  };

  it("builds and reparses the top-level meta", () => {
    const createdAt = "2026-05-30T00:00:00.000Z";
    const meta = buildArbellaMeta({
      arbellaVersion: "0.1.0",
      tools: ["claude", "codex"],
      config,
      createdAt,
      sharedInstructions: true,
    });

    expect(meta.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(meta.createdAt).toBe(createdAt);
    expect(meta.sharedInstructions).toBe(true);
    expect(meta.options).toEqual({
      includeSecrets: false,
      includeMemories: true,
      sourceOfTruth: "local",
    });

    const reparsed = parseMeta(JSON.parse(serialize(meta)));
    expect(reparsed).toEqual(meta);
  });

  it("rejects a meta with the wrong schemaVersion literal", () => {
    expect(() =>
      parseMeta({
        schemaVersion: 999,
        arbellaVersion: "0.1.0",
        tools: ["claude"],
        options: { includeSecrets: false, includeMemories: false, sourceOfTruth: "repo" },
        createdAt: "2026-05-30T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("manifest: deterministic serialization", () => {
  it("sorts object keys recursively and is stable regardless of insertion order", () => {
    const a = { b: 1, a: { d: 4, c: 3 }, z: [3, 2, 1] };
    const b = { z: [3, 2, 1], a: { c: 3, d: 4 }, b: 1 };
    expect(serialize(a)).toBe(serialize(b));
    // Arrays keep their order (only object keys are sorted).
    expect(serialize(a)).toContain("[\n    3,\n    2,\n    1\n  ]");
  });

  it("ends with exactly one trailing newline", () => {
    const out = serialize({ x: 1 });
    expect(out.endsWith("}\n")).toBe(true);
    expect(out.endsWith("}\n\n")).toBe(false);
  });
});

describe("manifest: R9 shared instructions decision", () => {
  it("shares only when both files exist and are byte-identical", () => {
    expect(shouldShareInstructions("same", "same")).toBe(true);
    expect(shouldShareInstructions("a", "b")).toBe(false);
    expect(shouldShareInstructions(undefined, "x")).toBe(false);
    expect(shouldShareInstructions("x", undefined)).toBe(false);
    expect(shouldShareInstructions(undefined, undefined)).toBe(false);
  });

  it("builds the shared file at the canonical repo path with verbatim content", () => {
    const content = "# Global instructions\nbe nice.";
    const file = buildSharedInstructionsFile(content);
    expect(file.repoPath).toBe(SHARED_INSTRUCTIONS_REPO_PATH);
    expect(file.repoPath).toBe("shared/instructions.md");
    expect(file.content).toBe(content);
  });

  it("targets both Claude (CLAUDE.md) and Codex (AGENTS.md) on restore", () => {
    const targets = sharedInstructionsTargets();
    expect(targets).toContainEqual({ tool: "claude", relPath: "CLAUDE.md" });
    expect(targets).toContainEqual({ tool: "codex", relPath: "AGENTS.md" });
  });
});
