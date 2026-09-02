/**
 * Zod schemas + inferred types for the reinstall manifests.
 *
 * Two artifacts are described here:
 *   1. ToolManifest  -> written to <tool>/manifest.json in the backup repo.
 *      The "reinstall" half of hybrid capture (R8, R10): plugins, marketplaces,
 *      reinstallable skills, npm globals, and enabled-plugin state.
 *   2. ArbellaMeta  -> written to arbella.json at the repo root.
 *      Top-level metadata: which tools, schema version, options, createdAt.
 *
 * IMPORTANT (library purity): nothing here reads the system clock. `createdAt`
 * is supplied by the CALLER as an ISO string argument to buildArbellaMeta(),
 * so library code stays deterministic and testable.
 */

import { z } from "zod";

import { isSafeToolName } from "../externaltools/classify.js";

/* -------------------------------------------------------------------------- */
/* Schema version                                                              */
/* -------------------------------------------------------------------------- */

/** Bump when the on-disk manifest/meta shape changes incompatibly. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

const toolIdSchema = z.enum([
  "claude",
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "kilo",
  "antigravity",
]);

/* -------------------------------------------------------------------------- */
/* Plugins (Claude installed_plugins.json + Codex [plugins.*])                  */
/* -------------------------------------------------------------------------- */

/**
 * A plugin to reinstall + re-enable on restore. Modeled to capture both Claude's
 * installed_plugins.json entries and Codex's [plugins."name@marketplace"] form.
 */
export const pluginEntrySchema = z.object({
  /** Fully-qualified id as used by the tool, e.g. "superpowers@claude-plugins-official". */
  id: z.string(),
  /** Short plugin name (left side of the @). */
  name: z.string(),
  /** Marketplace id this plugin came from (right side of the @), if any. */
  marketplace: z.string().optional(),
  /** Installed version string, when known (may be "unknown"). */
  version: z.string().optional(),
  /** Whether the plugin is enabled (Claude enabledPlugins / Codex enabled=true). */
  enabled: z.boolean().default(true),
  /**
   * Install scope. Claude entries carry "user" | "project"; restore only auto-
   * reinstalls "user"-scoped plugins (project-scoped ones are repo-specific).
   */
  scope: z.enum(["user", "project"]).default("user"),
  /** Project path for project-scoped entries (informational; templated). */
  projectPath: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Marketplaces (Claude known_marketplaces.json + Codex [marketplaces.*])       */
/* -------------------------------------------------------------------------- */

export const marketplaceEntrySchema = z.object({
  /** Marketplace id, e.g. "claude-plugins-official". */
  id: z.string(),
  /** Source kind. "github" => owner/repo shorthand; "git" => full URL. */
  sourceType: z.enum(["github", "git", "local"]),
  /**
   * The source locator. For "github": "owner/repo". For "git": a clone URL.
   * For "local": a templated path.
   */
  source: z.string(),
});

/* -------------------------------------------------------------------------- */
/* Skills (skills.sh / npx skills reinstallable; frozen ones are NOT here)       */
/* -------------------------------------------------------------------------- */

export const skillEntrySchema = z.object({
  /** Skill directory name, e.g. "humanizer". */
  name: z.string(),
  /**
   * How to reinstall:
   *  - "skills.sh": installed via `npx skills add <name>` into ~/.agents/skills,
   *                 then symlinked into the tool's skills dir.
   *  - "frozen":   hand-made; the directory is stored as files (NOT reinstalled).
   *                Recorded here for completeness/visibility only.
   */
  source: z.enum(["skills.sh", "frozen"]),
  /** The install command to run for reinstallable skills, when known. */
  installCommand: z.string().optional(),
  /** True when the local entry was a symlink into ~/.agents/skills. */
  symlinked: z.boolean().default(false),
});

/* -------------------------------------------------------------------------- */
/* npm globals (greppy, gemini-cli, etc.)                                        */
/* -------------------------------------------------------------------------- */

export const npmGlobalEntrySchema = z.object({
  /** Package name as `npm i -g` expects, e.g. "@google/gemini-cli". */
  package: z.string(),
  /** Version captured at backup time (informational; restore installs latest). */
  version: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* MCP servers (Claude ~/.claude.json#mcpServers, Codex [mcp_servers.*])        */
/* -------------------------------------------------------------------------- */

/**
 * One MCP server definition, stored VERBATIM apart from two transformations the
 * capture side always applies: secret values are redacted (every leaf under an
 * env/environment/headers map becomes {{REDACTED}} unless includeSecrets), and
 * machine paths are folded to {{HOME}}/{{TOOL_HOME}} placeholders. The shape is
 * intentionally open (`unknown` values): MCP server configs are vendor-defined
 * and arbella must round-trip fields it has never heard of.
 */
export const mcpServerDefSchema = z.record(z.string(), z.unknown());

/**
 * Project-scope MCP servers: the servers registered for ONE project directory
 * (Claude: ~/.claude.json#projects.<absPath>.mcpServers). `projectPath` is
 * templated, and restore only applies the entry when that directory actually
 * exists on the target machine.
 */
export const projectMcpServersSchema = z.object({
  /** Templated absolute path of the project the servers belong to. */
  projectPath: z.string(),
  /** name -> server definition. */
  servers: z.record(z.string(), mcpServerDefSchema),
});

/* -------------------------------------------------------------------------- */
/* External tools (binaries behind MCP/hook commands)                           */
/* -------------------------------------------------------------------------- */

/**
 * A binary referenced by an MCP/hook command that a package manager OTHER than
 * npm installed (brew, uv, pipx). npm globals have their own list; anything we
 * cannot classify lands here as "unknown" so the post-restore reminder can at
 * least tell the user what to install by hand.
 */
export const externalToolEntrySchema = z.object({
  /**
   * Package name to install, e.g. "serena-agent", "greppy".
   *
   * Validated against {@link isSafeToolName} by the ARRAY below rather than
   * here: an entry with an unusable name must not make the whole manifest
   * unparseable (a repo written by another/older client has to keep working),
   * so it is DROPPED instead of rejected.
   */
  name: z.string(),
  /** Which package manager owns it (or "unknown" when unclassifiable). */
  manager: z.enum(["brew", "uv", "pipx", "unknown"]),
  /** The command exactly as written in the config (templated). */
  command: z.string(),
  /** Resolved realpath at capture time, templated. Informational only. */
  resolvedPath: z.string().optional(),
  /** What referenced it, e.g. ["mcp:serena", "hook:PreToolUse"]. */
  usedBy: z.array(z.string()).default([]),
});

/* -------------------------------------------------------------------------- */
/* ToolManifest                                                                */
/* -------------------------------------------------------------------------- */

export const toolManifestSchema = z.object({
  /** Which tool this manifest belongs to. */
  tool: toolIdSchema,
  /** Plugins to reinstall + re-enable. */
  plugins: z.array(pluginEntrySchema).default([]),
  /** Marketplaces to register before reinstalling plugins. */
  marketplaces: z.array(marketplaceEntrySchema).default([]),
  /** Reinstallable + frozen-noted skills. */
  skills: z.array(skillEntrySchema).default([]),
  /** Global npm packages associated with this tool's workflow. */
  npmGlobals: z.array(npmGlobalEntrySchema).default([]),
  /**
   * enabledPlugins map mirrored from the tool's settings (id -> enabled). This
   * is the authoritative re-enable source on restore; `plugins[].enabled` is the
   * per-entry convenience copy.
   */
  enabledPlugins: z.record(z.string(), z.boolean()).default({}),
  /**
   * User-scope MCP servers (Claude: ~/.claude.json#mcpServers), sanitized +
   * templated, stored verbatim otherwise. Keyed by server name.
   */
  mcpServers: z.record(z.string(), mcpServerDefSchema).default({}),
  /** Project-scope MCP servers (Claude: ~/.claude.json#projects.<path>.mcpServers). */
  projectMcpServers: z.array(projectMcpServersSchema).default([]),
  /**
   * Binaries behind MCP/hook commands that a non-npm package manager installed.
   *
   * Entries whose `name` is not {@link isSafeToolName} are DROPPED here, at the
   * boundary where repo data becomes program data: the name ends up as an argv
   * element of `brew install <name>` on a pull, where a leading `-` is an option
   * and a `git+https://…` is a source. Dropping (rather than throwing) keeps a
   * manifest written by a foreign/older client parseable; the restore command
   * reports each dropped name via {@link parseManifest}'s callback so the user
   * hears about it instead of silently getting less than the repo claims.
   */
  externalTools: z
    .array(externalToolEntrySchema)
    .default([])
    .transform((list) => list.filter((entry) => isSafeToolName(entry.name))),
});

/* -------------------------------------------------------------------------- */
/* ArbellaMeta (top-level arbella.json)                                       */
/* -------------------------------------------------------------------------- */

export const arbellaMetaSchema = z.object({
  /** Manifest schema version (for forward migration). */
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  /** arbella package version that produced this backup. */
  arbellaVersion: z.string(),
  /** Tools captured into this repo. */
  tools: z.array(toolIdSchema),
  /** Options that were active during capture (subset of config). */
  options: z.object({
    includeSecrets: z.boolean(),
    includeMemories: z.boolean(),
    sourceOfTruth: z.enum(["local", "repo"]),
  }),
  /** ISO-8601 timestamp, SUPPLIED BY CALLER (no clock calls in library code). */
  createdAt: z.string(),
  /**
   * True when CLAUDE.md and AGENTS.md were byte-identical and stored once in
   * shared/instructions.md (R9). Restore deploys the shared file to both tools.
   */
  sharedInstructions: z.boolean().default(false),
});

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type PluginEntry = z.infer<typeof pluginEntrySchema>;
export type MarketplaceEntry = z.infer<typeof marketplaceEntrySchema>;
export type SkillEntry = z.infer<typeof skillEntrySchema>;
export type NpmGlobalEntry = z.infer<typeof npmGlobalEntrySchema>;
export type McpServerDef = z.infer<typeof mcpServerDefSchema>;
export type ProjectMcpServers = z.infer<typeof projectMcpServersSchema>;
export type ExternalToolEntry = z.infer<typeof externalToolEntrySchema>;
export type ToolManifest = z.infer<typeof toolManifestSchema>;
export type ArbellaMeta = z.infer<typeof arbellaMetaSchema>;
