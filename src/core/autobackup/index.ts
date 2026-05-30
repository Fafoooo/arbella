/**
 * Auto-backup glue (R4).
 *
 * Ties the throttle (when to back up) to the hook installer (how the cadence is
 * triggered) and exposes two small entry points the command layer uses:
 *
 *   - setAutoBackup(mode):        apply a cadence by (un)installing the SessionStart
 *                                 hook in both tools. NOTE: per the build contract,
 *                                 the CALLER is responsible for persisting `mode`
 *                                 into the arbella config (`saveConfig`/
 *                                 `updateConfig`); this function only owns the hook
 *                                 side-effect, so it stays decoupled from the
 *                                 config module.
 *
 *   - maybeRunBackup(mode, now):  the gate used by `arbella push --auto`. Returns
 *                                 true when the throttle says it is time to run, and
 *                                 records `now` as the last-run time when it does so
 *                                 (so the NEXT invocation is correctly throttled).
 *                                 The clock is injected (`nowIso`) for testability;
 *                                 the command passes new Date().toISOString().
 */

import { installHook, uninstallHook } from "./hook.js";
import { readState, writeState, shouldRun } from "./throttle.js";

import type { AutoBackupMode } from "../../types.js";

/**
 * Apply an auto-backup cadence.
 *
 * - "off":            removes our SessionStart hook from both tools.
 * - "session-start":  installs the throttled hook (>= 5 min between runs).
 * - "daily":          installs the throttled hook (>= 24 h between runs).
 *
 * Persisting the chosen mode to config is the caller's job (the command writes the
 * config). Idempotent: safe to call repeatedly with the same mode.
 */
export async function setAutoBackup(mode: AutoBackupMode): Promise<void> {
  if (mode === "off") {
    await uninstallHook();
    return;
  }
  await installHook(mode);
}

/**
 * Decide whether `arbella push --auto` should proceed right now.
 *
 * Reads the persisted last-run stamp, asks the pure `shouldRun` decision, and —
 * only when the answer is "go" — writes the new stamp so subsequent session-start
 * firings are throttled. Returns the decision to the caller, which performs the
 * actual backup when true.
 *
 * @param mode   the configured cadence (config.autoBackup).
 * @param nowIso the current time as an ISO string, injected by the command layer.
 */
export async function maybeRunBackup(
  mode: AutoBackupMode,
  nowIso: string,
): Promise<boolean> {
  if (mode === "off") return false;

  const { lastRunIso } = await readState();
  const go = shouldRun(mode, lastRunIso, nowIso);
  if (go) {
    await writeState(nowIso);
  }
  return go;
}
