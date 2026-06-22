/**
 * The Kilo Code CLI adapter — implements the Adapter contract for kilo.
 *
 * kilo is a config-dir CLI: its portable setup is kilo.jsonc + agents/ + rules/
 * under ~/.config/kilo. All capture/restore logic is the shared config-dir
 * engine; this module only declares kilo's paths and wires detect/install. See
 * ../shared/configDir.ts and ./paths.ts.
 *
 *   - detect():        true if the kilo config dir exists; false cleanly when
 *                      absent (Kilo CLI not installed).
 *   - isCliInstalled():probes `kilo` on PATH.
 *   - installCli(os):  npm i -g @kilocode/cli (all OSes).
 *   - capture/restore: delegated to the shared config-dir engine.
 */

import type { Adapter, CaptureContext, RestoreContext, RestoreData } from "../adapter.interface.js";
import type { CaptureResult, OS } from "../../types.js";

import { cliBinaryName, installCommandFor } from "../../platform/os.js";
import { runInstall, which } from "../../platform/install.js";
import {
  captureConfigDir,
  restoreConfigDir,
  type ConfigDirSpec,
} from "../shared/configDir.js";

import { FROZEN_PATHS, home } from "./paths.js";

const SPEC: ConfigDirSpec = { tool: "kilo", frozenPaths: FROZEN_PATHS };

/** Capture kilo's setup. Exported for direct use by the backup/status commands. */
export async function capture(
  ctx: CaptureContext,
  _opts?: { skipInstructions?: boolean },
): Promise<CaptureResult> {
  return captureConfigDir(ctx, SPEC);
}

/** Restore kilo's setup. Exported for direct use by the restore command. */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  return restoreConfigDir(ctx, data, SPEC);
}

/** True if Kilo's config dir exists on this machine. */
async function detect(): Promise<boolean> {
  const { fs } = await import("../../utils/fs.js");
  return (await fs.statKind(home())) === "dir";
}

/** True if the `kilo` CLI resolves on PATH. */
async function isCliInstalled(): Promise<boolean> {
  return which(cliBinaryName("kilo"));
}

/** Install the Kilo CLI (npm i -g @kilocode/cli) for the given OS. */
async function installCli(os: OS): Promise<void> {
  await runInstall(installCommandFor("kilo", os));
}

export const kiloAdapter: Adapter = {
  id: "kilo",
  displayName: "Kilo Code",
  detect,
  isCliInstalled,
  installCli,
  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    return capture(ctx);
  },
  async restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
    return restore(ctx, data);
  },
};

export default kiloAdapter;
