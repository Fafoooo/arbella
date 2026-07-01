/**
 * The adapter registry — the single place that knows the full set of tool
 * adapters (Claude, Codex, Cursor) and offers small helpers to look them up and
 * probe which are present on this machine.
 *
 * Why this exists: the Adapter contract (adapter.interface.ts) describes the
 * backup/restore lifecycle in terms of a "registry" (registry.detectAll() ->
 * capture, registry.forTools() -> restore). This module is that registry. It is
 * intentionally tiny and dependency-light: it imports only the concrete adapter
 * objects + shared types, so commands and the CLI entry can list/select adapters
 * without each re-deriving the same hard-coded trio.
 *
 * Ordering: adapters are kept in the canonical TOOL_IDS order so any UI that
 * iterates them (status, init, --help-ish summaries) is deterministic.
 */

import type { Adapter } from "./adapter.interface.js";
import type { ToolId } from "../types.js";
import { TOOL_IDS } from "../types.js";

import { claudeAdapter } from "./claude/index.js";
import { codexAdapter } from "./codex/index.js";
import { cursorAdapter } from "./cursor/index.js";
import { opencodeAdapter } from "./opencode/index.js";
import { copilotAdapter } from "./copilot/index.js";
import { kiloAdapter } from "./kilo/index.js";
import { antigravityAdapter } from "./antigravity/index.js";

/**
 * Every adapter arbella ships, keyed by ToolId. The map is the source of truth;
 * the ordered ALL_ADAPTERS array and the lookup helpers below derive from it.
 */
const ADAPTER_BY_ID: Readonly<Record<ToolId, Adapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
  copilot: copilotAdapter,
  kilo: kiloAdapter,
  antigravity: antigravityAdapter,
};

/** All adapters in canonical processing order (claude, codex, cursor). */
export const ALL_ADAPTERS: readonly Adapter[] = TOOL_IDS.map((id) => ADAPTER_BY_ID[id]);

/** Look up a single adapter by its tool id. Throws on an unknown id (the schema
 * constrains ToolId, so this only fires on a genuine programming error). */
export function adapterFor(tool: ToolId): Adapter {
  const adapter = ADAPTER_BY_ID[tool];
  if (!adapter) {
    throw new Error(`No adapter registered for tool "${tool}".`);
  }
  return adapter;
}

/** Adapters for an explicit list of tool ids, preserving the requested order. */
export function forTools(tools: readonly ToolId[]): Adapter[] {
  return tools.map((tool) => adapterFor(tool));
}

/**
 * Probe every adapter's detect() and return the adapters whose tool setup is
 * present on this machine. Detection is graceful per the Adapter contract
 * (detect() returns false rather than throwing when a home dir is absent); we
 * additionally swallow any unexpected throw so one tool can never block the
 * others.
 */
export async function detectAll(): Promise<Adapter[]> {
  const present: Adapter[] = [];
  for (const adapter of ALL_ADAPTERS) {
    let found = false;
    try {
      found = await adapter.detect();
    } catch {
      found = false;
    }
    if (found) present.push(adapter);
  }
  return present;
}

/** A small, side-effect-free summary of an adapter for listing/help output. */
export interface AdapterSummary {
  id: ToolId;
  displayName: string;
}

/** List the registered adapters as {id, displayName} pairs (no I/O). */
export function listAdapters(): AdapterSummary[] {
  return ALL_ADAPTERS.map((a) => ({ id: a.id, displayName: a.displayName }));
}

/** The registry object, mirroring the lifecycle vocabulary used in the Adapter
 * interface docs (registry.detectAll(), registry.forTools(), ...). */
export const registry = {
  all: ALL_ADAPTERS,
  adapterFor,
  forTools,
  detectAll,
  listAdapters,
} as const;

export default registry;
