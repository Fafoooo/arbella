/**
 * Regression tests for two manifest-portability fixes:
 *
 *  1. Claude `parseInstalledPlugins` must TEMPLATE a project-scope install's
 *     `projectPath` (it was committed raw, leaking `/Users/<you>/...` into the
 *     repo and breaking portability).
 *
 *  2. Codex restore must DEFER plugins whose marketplace was not captured (e.g. a
 *     built-in `openai-curated`, which has no addable source) to config.toml
 *     re-sync instead of attempting a doomed `codex plugin add`.
 */

import { describe, it, expect } from "vitest";

import { parseInstalledPlugins } from "../../src/adapters/claude/plugins.js";
import {
  planActions,
  partitionPluginsForRestore,
  pluginInstallArgs,
} from "../../src/adapters/codex/restore.js";
import { processConfigToml } from "../../src/adapters/codex/configToml.js";
import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import type { RestoreContext, RestoreData } from "../../src/adapters/adapter.interface.js";
import type { Logger, MarketplaceEntry, PluginEntry } from "../../src/types.js";

/** Minimal no-op Logger fake shared by the restore-planning tests below. */
function fakeLogger(): Logger {
  return {
    info: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    step: () => {},
    debug: () => {},
  };
}

describe("claude parseInstalledPlugins: projectPath is templated (no machine-path leak)", () => {
  const installed = {
    version: 2,
    plugins: {
      "superpowers@claude-plugins-official": [
        { scope: "user", version: "5.1.0" },
        {
          scope: "project",
          version: "5.1.0",
          projectPath: "/Users/alice/programming/secret-project",
        },
      ],
    },
  };

  it("folds projectPath through the real templater to {{HOME}}/...", () => {
    const templater = createTemplater();
    const vars = makeVariables("/Users/alice", "alice", "linux", "/Users/alice/.claude");
    const out = parseInstalledPlugins(installed, (p) => templater.toTemplate(p, vars));

    const project = out.find((p) => p.scope === "project");
    expect(project?.projectPath).toBe("{{HOME}}/programming/secret-project");
    // Regression guard: NO raw machine path survives in any parsed entry.
    expect(out.some((p) => p.projectPath?.includes("/Users/alice"))).toBe(false);
  });

  it("defaults to identity (raw value) when no foldPath is supplied", () => {
    const out = parseInstalledPlugins(installed);
    const project = out.find((p) => p.scope === "project");
    expect(project?.projectPath).toBe("/Users/alice/programming/secret-project");
  });

  it("does not invent a projectPath for entries that lack one", () => {
    const out = parseInstalledPlugins(installed, () => "SHOULD_NOT_APPEAR");
    const user = out.find((p) => p.scope === "user");
    expect(user?.projectPath).toBeUndefined();
  });
});

describe("codex partitionPluginsForRestore: built-in-marketplace plugins are deferred", () => {
  const captured: MarketplaceEntry[] = [
    {
      id: "claude-plugins-official",
      sourceType: "git",
      source: "https://github.com/anthropics/claude-plugins-official.git",
    },
  ];
  const userPlugins: PluginEntry[] = [
    {
      id: "superpowers@claude-plugins-official",
      name: "superpowers",
      enabled: true,
      scope: "user",
      marketplace: "claude-plugins-official",
    },
    {
      id: "github@openai-curated",
      name: "github",
      enabled: true,
      scope: "user",
      marketplace: "openai-curated",
    },
    { id: "loner", name: "loner", enabled: true, scope: "user" },
  ];

  it("installs captured-marketplace and marketplace-less plugins; defers the uncaptured (built-in) one", () => {
    const { installable, deferred } = partitionPluginsForRestore(captured, userPlugins);
    expect(installable.map((p) => p.id)).toEqual([
      "superpowers@claude-plugins-official",
      "loner",
    ]);
    expect(deferred.map((p) => p.id)).toEqual(["github@openai-curated"]);
  });

  it("defers nothing when every referenced marketplace was captured", () => {
    const onlyCaptured = userPlugins.filter((p) => p.marketplace !== "openai-curated");
    const { deferred } = partitionPluginsForRestore(captured, onlyCaptured);
    expect(deferred).toEqual([]);
  });

  it("uses the current Codex CLI subcommand for plugin installation", () => {
    expect(pluginInstallArgs(userPlugins[0]!)).toEqual([
      "plugin",
      "add",
      "superpowers@claude-plugins-official",
    ]);
  });

  it("keeps the dry-run plan aligned with deferred built-in marketplace plugins", async () => {
    const ctx = {
      fs: { exists: async () => false, statKind: async () => "missing" as const },
      templater: createTemplater(),
      vars: makeVariables("/home/alice", "alice", "linux", "/home/alice/.codex"),
      log: fakeLogger(),
      toolHome: "/home/alice/.codex",
      sourceOfTruth: "repo",
    } as RestoreContext;
    const data: RestoreData = {
      manifest: {
        tool: "codex",
        plugins: userPlugins,
        marketplaces: captured,
        skills: [],
        npmGlobals: [],
        enabledPlugins: {},
      },
      files: [],
      symlinks: [],
    };

    const actions = await planActions(ctx, data);

    expect(
      actions
        .filter((action) => action.type === "install-plugin")
        .map((action) => action.description),
    ).toEqual([
      "Install plugin superpowers@claude-plugins-official",
      "Install plugin loner",
    ]);
  });
});

describe("codex processConfigToml: local marketplace sources are templated", () => {
  it("folds a [marketplaces.*] local source through the templater instead of leaking the raw machine path", () => {
    const home = "/Users/alice";
    const templater = createTemplater();
    const vars = makeVariables(home, "alice", "linux", `${home}/.codex`);

    const raw = [
      `[marketplaces.openai-primary-runtime]`,
      `source_type = "local"`,
      `source = "${home}/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime"`,
      ``,
      `[marketplaces.claude-plugins-official]`,
      `source_type = "git"`,
      `source = "https://github.com/anthropics/claude-plugins-official.git"`,
      ``,
    ].join("\n");

    const result = processConfigToml(raw, templater, vars);

    const local = result.marketplaces.find((m) => m.id === "openai-primary-runtime");
    expect(local?.sourceType).toBe("local");
    expect(local?.source).toBe(
      "{{HOME}}/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime",
    );
    // Regression guard: no raw machine path survives in the extracted manifest entry.
    expect(result.marketplaces.some((m) => m.source.includes(home))).toBe(false);

    const git = result.marketplaces.find((m) => m.id === "claude-plugins-official");
    expect(git?.source).toBe("https://github.com/anthropics/claude-plugins-official.git");
  });
});

describe("codex restore planning: local marketplaces missing on this machine are skipped", () => {
  it("hydrates each marketplace source and skips a local one whose directory is absent, while still planning a github one", async () => {
    const home = "/home/bob";
    const toolHome = `${home}/.codex`;
    const templater = createTemplater();
    const vars = makeVariables(home, "bob", "linux", toolHome);

    const marketplaces: MarketplaceEntry[] = [
      {
        id: "openai-bundled",
        sourceType: "local",
        source: "{{TOOL_HOME}}/.tmp/bundled-marketplaces/openai-bundled",
      },
      {
        id: "claude-plugins-official",
        sourceType: "github",
        source: "anthropics/claude-plugins-official",
      },
    ];

    const statKindCalls: string[] = [];
    const ctx = {
      fs: {
        exists: async () => false,
        statKind: async (p: string) => {
          statKindCalls.push(p);
          return "missing" as const;
        },
      },
      templater,
      vars,
      log: fakeLogger(),
      toolHome,
      sourceOfTruth: "repo",
    } as RestoreContext;

    const data: RestoreData = {
      manifest: {
        tool: "codex",
        plugins: [],
        marketplaces,
        skills: [],
        npmGlobals: [],
        enabledPlugins: {},
      },
      files: [],
      symlinks: [],
    };

    const actions = await planActions(ctx, data);
    const marketplaceActions = actions.filter((action) => action.type === "add-marketplace");

    expect(marketplaceActions.map((action) => action.description)).toEqual([
      "Register marketplace claude-plugins-official (anthropics/claude-plugins-official)",
    ]);
    // Only the local marketplace's hydrated path is ever stat'd.
    expect(statKindCalls).toEqual([`${toolHome}/.tmp/bundled-marketplaces/openai-bundled`]);
  });
});
