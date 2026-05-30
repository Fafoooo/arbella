/**
 * Auto-backup SessionStart hook installer (R4).
 *
 * Writes a throttled `SessionStart` hook into both supported tools so that opening
 * a session triggers `arbella push --auto` in the background. The `--auto` path
 * is itself throttled (see throttle.ts), so the hook firing on every session start
 * is cheap and safe — the actual backup only happens when the cadence allows.
 *
 * Surgical & idempotent: every entry we add carries HOOK_TAG (embedded in the
 * command string), so install is a no-op when ours already exists and uninstall
 * removes ONLY our entries, never the user's other hooks.
 *
 * File shapes (verified against the real machine):
 *
 *   Claude  ~/.claude/settings.json
 *     { ..., "hooks": { "SessionStart": [ { "hooks": [ { "type":"command",
 *       "command":"..." } ] }, ... ], "UserPromptSubmit": [ ... ] } }
 *
 *   Codex   ~/.codex/hooks.json
 *     { "hooks": { "SessionStart": [ { "hooks": [ { "type":"command",
 *       "command":"..." } ] } ] } }
 *
 * Both use the same nested `{ hooks: [ { type:"command", command } ] }` group
 * shape; they differ only in where the top-level event map lives (settings.json's
 * `hooks` field vs hooks.json's `hooks` field).
 *
 * No hardcoded paths: tool homes come from os.ts (toolHomeDir). The command string
 * is OS-resolved (POSIX background `&` vs a Windows `start /b` variant).
 */

import path from "node:path";

import { fs } from "../../utils/fs.js";
import { detectOS, toolHomeDir } from "../../platform/os.js";

import type { AutoBackupMode } from "../../types.js";

/**
 * Marker embedded in the command so we can find/replace our own entries without
 * clobbering user-authored hooks. It is a shell comment, so it is inert when the
 * command runs but unambiguous when we scan for it.
 */
export const HOOK_TAG = "arbella-autobackup";

/** The SessionStart event key used by both Claude and Codex hook maps. */
const EVENT = "SessionStart";

/* -------------------------------------------------------------------------- */
/* Hook command string                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The command the hook runs. It launches `arbella push --auto` detached so the
 * session start is never blocked, discards output, and appends a `# HOOK_TAG`
 * comment so the entry is recognizable for surgical uninstall.
 *
 *   POSIX:  arbella push --auto >/dev/null 2>&1 & # arbella-autobackup
 *   win32:  start /b "" arbella push --auto >NUL 2>&1 :: arbella-autobackup
 *
 * `arbella` is invoked by bare name (it is the installed bin on PATH), so no
 * machine-specific path is baked into the hook — it stays portable across restore.
 */
export function hookCommand(): string {
  if (detectOS() === "win32") {
    // `::` is a batch comment; `start /b` runs detached without a new window.
    return `start /b "" arbella push --auto >NUL 2>&1 :: ${HOOK_TAG}`;
  }
  // POSIX: trailing `&` backgrounds it; the `#` comment carries the tag.
  return `arbella push --auto >/dev/null 2>&1 & # ${HOOK_TAG}`;
}

/* -------------------------------------------------------------------------- */
/* Internal hook-shape helpers                                                  */
/* -------------------------------------------------------------------------- */

/** A single command step inside a hook group. */
interface HookCommandStep {
  type: "command";
  command: string;
  [extra: string]: unknown;
}

/** A hook group: `{ hooks: [ { type:"command", command } ] }`. */
interface HookGroup {
  hooks: HookCommandStep[];
  [extra: string]: unknown;
}

/** True if a value looks like a hook group we can inspect. */
function isHookGroup(value: unknown): value is HookGroup {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { hooks?: unknown }).hooks)
  );
}

/** True if a hook group is one of ours (any step's command carries HOOK_TAG). */
function isOurGroup(group: unknown): boolean {
  if (!isHookGroup(group)) return false;
  return group.hooks.some(
    (step) =>
      !!step &&
      typeof step === "object" &&
      typeof (step as { command?: unknown }).command === "string" &&
      (step as { command: string }).command.includes(HOOK_TAG),
  );
}

/** Build the hook group arbella installs under SessionStart. */
function buildOurGroup(): HookGroup {
  return { hooks: [{ type: "command", command: hookCommand() }] };
}

/**
 * Given the existing array under `event` (possibly undefined), return a new array
 * with all of our prior entries removed and exactly one fresh entry appended.
 * User entries are preserved in order.
 */
function withOurGroupInstalled(existing: unknown): HookGroup[] {
  const kept: HookGroup[] = Array.isArray(existing)
    ? (existing.filter((g) => isHookGroup(g) && !isOurGroup(g)) as HookGroup[])
    : [];
  kept.push(buildOurGroup());
  return kept;
}

/**
 * Given the existing array under `event`, return a new array with our entries
 * removed. Returns the filtered array (may be empty) or null when nothing of ours
 * was present (so the caller can avoid rewriting the file needlessly).
 */
function withOurGroupRemoved(existing: unknown): HookGroup[] | null {
  if (!Array.isArray(existing)) return null;
  const hadOurs = existing.some((g) => isOurGroup(g));
  if (!hadOurs) return null;
  return existing.filter((g) => isHookGroup(g) && !isOurGroup(g)) as HookGroup[];
}

/* -------------------------------------------------------------------------- */
/* JSON file read/write helpers (tolerant of absence + BOM)                     */
/* -------------------------------------------------------------------------- */

/** Read a JSON object from `file`, or return {} when the file is missing/empty/corrupt. */
async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  if (!(await fs.exists(file))) return {};
  try {
    const raw = (await fs.read(file)).replace(/^﻿/, "");
    if (raw.trim() === "") return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable/corrupt JSON: we must not destroy it. Signal by throwing below.
    throw new Error(
      `Cannot modify hooks: ${file} exists but is not valid JSON. Leaving it untouched.`,
    );
  }
  return {};
}

/** Pretty-print + write a JSON object, mirroring the 2-space style the tools use. */
async function writeJsonObject(
  file: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.write(file, JSON.stringify(value, null, 2) + "\n");
}

/* -------------------------------------------------------------------------- */
/* Claude: settings.json -> hooks.SessionStart                                  */
/* -------------------------------------------------------------------------- */

function claudeSettingsPath(): string {
  return path.join(toolHomeDir("claude"), "settings.json");
}

/**
 * Mutate Claude's settings.json `hooks.SessionStart`. When `enable` is true we add
 * our (deduplicated) group; when false we strip it. The rest of settings.json is
 * left byte-for-byte intact aside from the touched event array.
 *
 * Only writes when the tool home actually exists (graceful absence) AND when the
 * content would change. Returns true if a write happened.
 */
async function applyClaude(enable: boolean): Promise<boolean> {
  const home = toolHomeDir("claude");
  // Do not create a Claude config out of thin air; only touch an existing install.
  if (!(await fs.exists(home))) return false;

  const file = claudeSettingsPath();
  const settings = await readJsonObject(file);

  const hooksField = settings.hooks;
  const hooks: Record<string, unknown> =
    hooksField && typeof hooksField === "object" && !Array.isArray(hooksField)
      ? { ...(hooksField as Record<string, unknown>) }
      : {};

  if (enable) {
    hooks[EVENT] = withOurGroupInstalled(hooks[EVENT]);
  } else {
    const removed = withOurGroupRemoved(hooks[EVENT]);
    if (removed === null) return false; // nothing of ours to remove
    if (removed.length === 0) {
      delete hooks[EVENT];
    } else {
      hooks[EVENT] = removed;
    }
  }

  settings.hooks = hooks;
  await writeJsonObject(file, settings);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Codex: hooks.json -> hooks.SessionStart                                      */
/* -------------------------------------------------------------------------- */

function codexHooksPath(): string {
  return path.join(toolHomeDir("codex"), "hooks.json");
}

/**
 * Mutate Codex's hooks.json `hooks.SessionStart`. Codex nests the event map under
 * a top-level `hooks` object: `{ "hooks": { "SessionStart": [...] } }`. We honor
 * that wrapper, creating it if (and only if) we are enabling and the tool home
 * exists. Returns true if a write happened.
 */
async function applyCodex(enable: boolean): Promise<boolean> {
  const home = toolHomeDir("codex");
  if (!(await fs.exists(home))) return false;

  const file = codexHooksPath();
  const root = await readJsonObject(file);

  const hooksField = root.hooks;
  const hooks: Record<string, unknown> =
    hooksField && typeof hooksField === "object" && !Array.isArray(hooksField)
      ? { ...(hooksField as Record<string, unknown>) }
      : {};

  if (enable) {
    hooks[EVENT] = withOurGroupInstalled(hooks[EVENT]);
  } else {
    const removed = withOurGroupRemoved(hooks[EVENT]);
    if (removed === null) return false; // nothing of ours to remove
    if (removed.length === 0) {
      delete hooks[EVENT];
    } else {
      hooks[EVENT] = removed;
    }
  }

  root.hooks = hooks;
  await writeJsonObject(file, root);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Install (or, for `mode==="off"`, remove) the throttled SessionStart hook in both
 * tools. Idempotent: re-running with the same mode leaves a single tagged entry.
 *
 * `mode` of `"off"` is treated as an uninstall so callers can funnel every cadence
 * change through one entry point. `"session-start"` and `"daily"` both install the
 * same hook — the cadence difference is enforced by the throttle when the hook
 * fires, not by the hook itself.
 *
 * Failures on one tool do not abort the other; both are attempted.
 */
export async function installHook(mode: AutoBackupMode): Promise<void> {
  if (mode === "off") {
    await uninstallHook();
    return;
  }
  await Promise.all([applyClaude(true), applyCodex(true)]);
}

/** Remove any arbella-installed SessionStart hook from both tools. Idempotent. */
export async function uninstallHook(): Promise<void> {
  await Promise.all([applyClaude(false), applyCodex(false)]);
}
