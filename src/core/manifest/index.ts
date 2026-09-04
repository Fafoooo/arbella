/**
 * Manifest + meta orchestration for arbella.
 *
 * This module is the single source of truth for:
 *   - building / parsing / validating ToolManifest objects (per-tool manifest.json)
 *   - building / parsing / validating ArbellaMeta (top-level arbella.json)
 *   - deterministic JSON serialization for everything committed to the repo
 *   - the shared-instructions (R9) decision + storage contract:
 *       deciding whether CLAUDE.md and AGENTS.md are byte-identical and should be
 *       stored once under shared/instructions.md, and where that single file is
 *       deployed on restore.
 *
 * LIBRARY PURITY: nothing here reads the system clock.
 * `createdAt` is supplied by the caller as an ISO string. The R9 helpers are pure
 * and synchronous (no fs) — callers do the reading and pass content in.
 *
 * Validation is delegated to the zod schemas in ./schema.js so there is exactly
 * one definition of each on-disk shape.
 */

import type {
  ToolManifest,
  ArbellaMeta,
  ArbellaConfig,
  ToolId,
  CapturedFile,
} from "../../types.js";
import { toolManifestSchema, arbellaMetaSchema, MANIFEST_SCHEMA_VERSION } from "./schema.js";
import { isSafeToolName, mergeExternalTools } from "../externaltools/classify.js";
import { isPlainObject } from "../../utils/object.js";

/* -------------------------------------------------------------------------- */
/* Empty / default manifest                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An empty manifest for `tool` (all collections empty). Built by parsing a
 * minimal object through the schema so every default is applied and the result
 * is guaranteed schema-valid (and carries the exact inferred output type).
 */
export function emptyManifest(tool: ToolId): ToolManifest {
  return toolManifestSchema.parse({
    tool,
    plugins: [],
    marketplaces: [],
    skills: [],
    npmGlobals: [],
    enabledPlugins: {},
    mcpServers: {},
    projectMcpServers: [],
    externalTools: [],
  });
}

/* -------------------------------------------------------------------------- */
/* Parse / validate (read side)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Validate + parse a manifest read from disk. Throws a ZodError on malformed
 * data so the restore/status caller can surface a clear "corrupt manifest"
 * message rather than silently proceeding with garbage.
 *
 * The ONE thing that is dropped rather than rejected is an `externalTools`
 * entry whose name is not {@link isSafeToolName} (see the schema): a hostile or
 * merely broken name must not make an otherwise-good repo unreadable, but it
 * must also never reach `brew install <name>`. `onDroppedTool` is called once
 * per dropped name so the caller can say so out loud instead of quietly
 * restoring less than the repo lists.
 */
export function parseManifest(
  json: unknown,
  onDroppedTool?: (name: string) => void,
): ToolManifest {
  const manifest = toolManifestSchema.parse(json);
  if (onDroppedTool !== undefined) {
    for (const name of droppedExternalToolNames(json)) onDroppedTool(name);
  }
  return manifest;
}

/**
 * The `externalTools` names the schema filter removed from `json` — the RAW
 * manifest value, before parsing. Pure; used only for reporting (the parse
 * itself has already dropped them).
 */
export function droppedExternalToolNames(json: unknown): string[] {
  if (!isPlainObject(json) || !Array.isArray(json.externalTools)) return [];
  const out: string[] = [];
  for (const entry of json.externalTools) {
    if (!isPlainObject(entry)) continue;
    const name = entry.name;
    if (typeof name === "string" && !isSafeToolName(name)) out.push(name);
  }
  return out;
}

/**
 * Validate + parse the top-level arbella.json (ArbellaMeta). Throws on bad
 * data (e.g. wrong schemaVersion literal, missing required fields).
 */
export function parseMeta(json: unknown): ArbellaMeta {
  return arbellaMetaSchema.parse(json);
}

/* -------------------------------------------------------------------------- */
/* Build top-level meta (write side)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the top-level ArbellaMeta written to <repoRoot>/arbella.json.
 *
 * `createdAt` MUST be supplied by the caller (e.g. `new Date().toISOString()` at
 * the command layer) — library code never touches the clock. The result is run
 * through the schema so it is validated + normalized before it is serialized.
 */
export function buildArbellaMeta(args: {
  arbellaVersion: string;
  tools: ToolId[];
  config: ArbellaConfig;
  createdAt: string;
  sharedInstructions: boolean;
}): ArbellaMeta {
  const { arbellaVersion, tools, config, createdAt, sharedInstructions } = args;
  return arbellaMetaSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    arbellaVersion,
    tools,
    options: {
      includeSecrets: config.includeSecrets,
      includeMemories: config.includeMemories,
      sourceOfTruth: config.sourceOfTruth,
    },
    createdAt,
    sharedInstructions,
  });
}

/* -------------------------------------------------------------------------- */
/* Manifest merge helpers                                                      */
/* -------------------------------------------------------------------------- */
/*
 * These let an adapter accumulate plugin / marketplace / skill / npm-global
 * entries from multiple sources (e.g. settings.json + installed_plugins.json,
 * or several skill directories) into one manifest without duplicating ids.
 * They are pure: they return NEW arrays / objects and never mutate inputs, so
 * they are safe to chain. De-duplication keeps the FIRST occurrence of a given
 * key (stable, predictable) and is therefore order-sensitive — pass the more
 * authoritative source first.
 */

/** Merge plugin lists, de-duplicating by `id` (first occurrence wins). */
export function mergePlugins(
  ...lists: ReadonlyArray<ToolManifest["plugins"]>
): ToolManifest["plugins"] {
  return dedupeBy(lists.flat(), (p) => p.id);
}

/** Merge marketplace lists, de-duplicating by `id` (first occurrence wins). */
export function mergeMarketplaces(
  ...lists: ReadonlyArray<ToolManifest["marketplaces"]>
): ToolManifest["marketplaces"] {
  return dedupeBy(lists.flat(), (m) => m.id);
}

/** Merge skill lists, de-duplicating by `name` (first occurrence wins). */
export function mergeSkills(
  ...lists: ReadonlyArray<ToolManifest["skills"]>
): ToolManifest["skills"] {
  return dedupeBy(lists.flat(), (s) => s.name);
}

/** Merge npm-global lists, de-duplicating by `package` (first occurrence wins). */
export function mergeNpmGlobals(
  ...lists: ReadonlyArray<ToolManifest["npmGlobals"]>
): ToolManifest["npmGlobals"] {
  return dedupeBy(lists.flat(), (n) => n.package);
}

/**
 * Merge enabledPlugins maps (id -> enabled). Later maps win on key collisions,
 * matching how successive settings sources should override one another.
 */
export function mergeEnabledPlugins(
  ...maps: ReadonlyArray<ToolManifest["enabledPlugins"]>
): ToolManifest["enabledPlugins"] {
  const out: Record<string, boolean> = {};
  for (const map of maps) {
    for (const key of Object.keys(map)) {
      out[key] = map[key]!;
    }
  }
  return out;
}

/**
 * Assemble a complete, schema-valid ToolManifest from parts. Any omitted part
 * defaults to empty. Each list is de-duplicated via the merge helpers and the
 * whole thing is validated through the schema. Convenience for adapter capture
 * code so it does not have to hand-build the object shape.
 */
export function buildManifest(
  tool: ToolId,
  raw: Partial<{
    plugins: ToolManifest["plugins"];
    marketplaces: ToolManifest["marketplaces"];
    skills: ToolManifest["skills"];
    npmGlobals: ToolManifest["npmGlobals"];
    enabledPlugins: ToolManifest["enabledPlugins"];
    mcpServers: ToolManifest["mcpServers"];
    projectMcpServers: ToolManifest["projectMcpServers"];
    externalTools: ToolManifest["externalTools"];
  }> = {},
): ToolManifest {
  return toolManifestSchema.parse({
    tool,
    plugins: mergePlugins(raw.plugins ?? []),
    marketplaces: mergeMarketplaces(raw.marketplaces ?? []),
    skills: mergeSkills(raw.skills ?? []),
    npmGlobals: mergeNpmGlobals(raw.npmGlobals ?? []),
    enabledPlugins: raw.enabledPlugins ?? {},
    mcpServers: raw.mcpServers ?? {},
    projectMcpServers: raw.projectMcpServers ?? [],
    externalTools: mergeExternalTools([raw.externalTools ?? []]),
  });
}

/**
 * Merge external-tool lists (de-duplicated by `manager:name`, `usedBy` unioned).
 *
 * Re-exported, NOT reimplemented: src/core/externaltools/classify.ts owns the one
 * implementation, and the restore command's cross-tool pass already uses it. Two
 * copies of this merge is exactly how the manifest and the restore plan would
 * start disagreeing about which binaries a pull has to install.
 */
export { mergeExternalTools };

/** De-duplicate an array by a derived string key, keeping the first occurrence. */
function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Deterministic serialization                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Serialize a value to deterministic JSON: 2-space indent, object keys sorted
 * lexicographically (recursively), arrays kept in order, with a trailing
 * newline. Determinism matters because these files are committed to git — stable
 * output means no spurious diffs when only insertion order changed.
 *
 * Semantics mirror JSON.stringify: `undefined` object values are dropped,
 * `undefined` array elements become `null`, and Dates/etc. are not specially
 * handled (callers pass plain JSON-shaped values).
 */
export function serialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

/**
 * Recursively produce a structurally-equal value with every plain-object's keys
 * sorted. Arrays preserve order. Non-plain values (primitives, null) pass
 * through. Keys whose value is `undefined` are omitted so output matches
 * JSON.stringify's treatment of them.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysDeep(v));
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      sorted[key] = sortKeysDeep(v);
    }
    return sorted;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Shared instructions (R9) — single source of truth lives HERE                */
/* -------------------------------------------------------------------------- */

/**
 * Repo path where the single shared instructions file is stored when CLAUDE.md
 * and AGENTS.md are byte-identical. POSIX separators (it is a CapturedFile
 * repoPath).
 */
export const SHARED_INSTRUCTIONS_REPO_PATH = "shared/instructions.md";

/**
 * Decide R9: given the (already-read) contents of CLAUDE.md and AGENTS.md (either
 * may be undefined when the file is absent), return whether they are identical
 * and should therefore be stored once as the shared instructions file.
 *
 * Pure + synchronous (no fs). Only shares when BOTH files exist and their
 * contents are exactly equal. If either is missing, there is nothing to share —
 * each adapter freezes whatever it individually has.
 */
export function shouldShareInstructions(claudeMd?: string, agentsMd?: string): boolean {
  if (claudeMd === undefined || agentsMd === undefined) return false;
  return claudeMd === agentsMd;
}

/** What a run must do with the committed `shared/instructions.md`. */
export type SharedInstructionsUpdate = "write" | "remove" | "keep";

/**
 * Decide what a run may do with the COMMITTED shared instructions file (and with
 * `meta.sharedInstructions`), given the R9 sharing decision and the tools this
 * run actually captured.
 *
 * The rule that matters: when sharing, `shared/instructions.md` is the ONLY copy
 * of CLAUDE.md / AGENTS.md in the repo — both adapters skip their own. So a run
 * on a machine where one producer is missing has NO evidence about that tool's
 * instructions, and must leave the file (and the previously recorded flag)
 * alone. Deleting it there is a laptop quietly amputating the desktop's Codex
 * instructions, visible only on the next pull.
 *
 * Hence: a producer that is still CONFIGURED but did not run here keeps the
 * file. Once every configured producer ran — or a producer was removed from
 * `config.tools` altogether, so the repo no longer carries its instructions at
 * all (see `resolveMetaTools`) — the run decides normally: write when sharing,
 * remove otherwise. Pure + synchronous; shared by `push` and `status` so the
 * two cannot disagree about whether the file would survive a push.
 *
 * A kept file can coexist with the present tool's OWN freshly captured copy (a
 * run that is not sharing does not skip instructions); restore prefers the
 * per-tool copy for that target. Keeping it is still strictly better than
 * deleting the absent tool's only copy.
 */
export function decideSharedInstructionsUpdate(args: {
  /** R9: both instruction files were read this run and are byte-identical. */
  share: boolean;
  /** Tools whose capture actually ran this run. */
  capturedTools: readonly ToolId[];
  /** `config.tools` — a producer the user dropped no longer holds a veto. */
  configuredTools: readonly ToolId[];
}): SharedInstructionsUpdate {
  const captured = new Set<ToolId>(args.capturedTools);
  const configured = new Set<ToolId>(args.configuredTools);
  for (const producer of SHARED_INSTRUCTIONS_PRODUCERS) {
    if (configured.has(producer) && !captured.has(producer)) return "keep";
  }
  return args.share ? "write" : "remove";
}

/** The two tools whose instruction files R9 can fold into one shared file. */
const SHARED_INSTRUCTIONS_PRODUCERS: readonly ToolId[] = ["claude", "codex"];

/**
 * Produce the CapturedFile for the shared instructions (repoPath =
 * SHARED_INSTRUCTIONS_REPO_PATH). The content is the shared text verbatim; it is
 * already user-authored markdown (templating still applies upstream if the
 * caller chooses, but instructions are typically path-free). Callers should only
 * invoke this when shouldShareInstructions() returned true.
 */
export function buildSharedInstructionsFile(content: string): CapturedFile {
  return {
    repoPath: SHARED_INSTRUCTIONS_REPO_PATH,
    content,
  };
}

/**
 * The destinations the single shared instructions file deploys to on restore,
 * expressed relative to each tool's home dir. Claude reads CLAUDE.md; Codex reads
 * AGENTS.md. Cursor User Rules live in Cursor settings, so Arbella does not
 * synthesize a global Cursor rule from this file.
 */
export function sharedInstructionsTargets(): Array<{ tool: ToolId; relPath: string }> {
  return [
    { tool: "claude", relPath: "CLAUDE.md" },
    { tool: "codex", relPath: "AGENTS.md" },
  ];
}
