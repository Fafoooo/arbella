/**
 * The GitHub Copilot CLI adapter — implements the Adapter contract for copilot.
 *
 * copilot is a config-dir CLI: its portable setup is config.json +
 * mcp-config.json + agents/ under ~/.copilot. All capture/restore logic is the
 * shared config-dir engine; this module only declares copilot's paths and wires
 * detect/install. See ../shared/configDir.ts and ./paths.ts.
 *
 *   - detect():        true if the ~/.copilot config dir exists; false cleanly
 *                      when absent (Copilot CLI not installed).
 *   - isCliInstalled():probes `copilot` on PATH.
 *   - installCli(os):  npm i -g @github/copilot (all OSes).
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

const SPEC: ConfigDirSpec = { tool: "copilot", frozenPaths: FROZEN_PATHS };

/** Capture copilot's setup. Exported for direct use by the backup/status commands. */
export async function capture(
  ctx: CaptureContext,
  _opts?: { skipInstructions?: boolean },
): Promise<CaptureResult> {
  return captureConfigDir(ctx, SPEC);
}

/** Restore copilot's setup. Exported for direct use by the restore command. */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  return restoreConfigDir(ctx, data, SPEC);
}

/** True if Copilot CLI's config dir exists on this machine. */
async function detect(): Promise<boolean> {
  const { fs } = await import("../../utils/fs.js");
  return (await fs.statKind(home())) === "dir";
}

/** True if the `copilot` CLI resolves on PATH. */
async function isCliInstalled(): Promise<boolean> {
  return which(cliBinaryName("copilot"));
}

/** Install the Copilot CLI (npm i -g @github/copilot) for the given OS. */
async function installCli(os: OS): Promise<void> {
  await runInstall(installCommandFor("copilot", os));
}

export const copilotAdapter: Adapter = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
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

export default copilotAdapter;
