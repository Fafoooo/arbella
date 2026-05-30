/**
 * Auto-backup throttle (R4).
 *
 * Persists the timestamp of the last auto-backup in a small JSON stamp file under
 * dataDir() and answers the question "should we back up right now?" given the
 * configured cadence. This is what keeps `session-start` from hammering the repo
 * on rapid restarts and keeps `daily` to at most once per 24h.
 *
 * The decision function `shouldRun` is PURE: it takes the current time as an ISO
 * string parameter rather than reading the clock, so it is trivially testable.
 * Only the thin I/O helpers (`readState`/`writeState`) and the command layer touch
 * real time. (The contract explicitly allows the autobackup throttle to read the
 * clock, but we still prefer injection.)
 */

import path from "node:path";

import { fs } from "../../utils/fs.js";
import { dataDir } from "../../platform/os.js";

import type { AutoBackupMode } from "../../types.js";

/** Absolute path to the stamp file that records the last auto-backup time. */
export const STAMP_FILE: string = path.join(dataDir(), "autobackup.json");

/** Minimum gap between `session-start` auto-backups (5 minutes). */
export const MIN_SESSION_GAP_MS = 5 * 60 * 1000;

/** Minimum gap between `daily` auto-backups (24 hours). */
export const DAILY_GAP_MS = 24 * 60 * 60 * 1000;

/** Persisted throttle state. */
export interface ThrottleState {
  /** ISO timestamp of the last auto-backup, or null if it has never run. */
  lastRunIso: string | null;
}

/**
 * Read the throttle state from disk. Tolerant of a missing or corrupt stamp file:
 * any read/parse failure is treated as "never run before".
 */
export async function readState(): Promise<ThrottleState> {
  if (!(await fs.exists(STAMP_FILE))) {
    return { lastRunIso: null };
  }
  try {
    const raw = await fs.read(STAMP_FILE);
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "lastRunIso" in parsed &&
      typeof (parsed as { lastRunIso: unknown }).lastRunIso === "string"
    ) {
      return { lastRunIso: (parsed as { lastRunIso: string }).lastRunIso };
    }
  } catch {
    // Corrupt stamp file -> behave as if we have never run.
  }
  return { lastRunIso: null };
}

/**
 * Record `nowIso` as the time of the most recent auto-backup. Creates dataDir()
 * if needed (fs.write ensures the parent directory).
 */
export async function writeState(nowIso: string): Promise<void> {
  const state: ThrottleState = { lastRunIso: nowIso };
  await fs.write(STAMP_FILE, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Pure throttle decision.
 *
 *  - "off":            never back up.
 *  - "session-start":  back up unless the last run was < MIN_SESSION_GAP_MS ago.
 *  - "daily":          back up only if >= DAILY_GAP_MS since the last run (or never).
 *
 * Unparseable/absent `lastRunIso` (null or NaN date) means "never ran" => run.
 * A future-dated last run (clock skew) is treated conservatively as "just ran".
 */
export function shouldRun(
  mode: AutoBackupMode,
  lastRunIso: string | null,
  nowIso: string,
): boolean {
  if (mode === "off") return false;

  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    // We cannot reason about time without a valid "now"; refuse rather than spam.
    return false;
  }

  if (lastRunIso === null) return true;
  const last = Date.parse(lastRunIso);
  if (Number.isNaN(last)) return true; // unparseable previous stamp -> treat as never ran

  const elapsed = now - last;
  if (elapsed < 0) {
    // Last run is in the future relative to now (clock went backwards / skew).
    // Be conservative and do not back up.
    return false;
  }

  if (mode === "session-start") {
    return elapsed >= MIN_SESSION_GAP_MS;
  }
  // mode === "daily"
  return elapsed >= DAILY_GAP_MS;
}
