/**
 * The opencode adapter — implements the Adapter contract for opencode.
 *
 * opencode is a config-dir CLI: its portable setup is the single config dir
 * (opencode.json/jsonc + agents/ + commands/). All capture/restore logic is the
 * shared config-dir engine; this module only declares opencode's paths and wires
 * detect/install. See ../shared/configDir.ts for the engine and ./paths.ts for
 * the path knowledge.
 *
 *   - detect():        true if the opencode config dir exists; false cleanly when
 *                      absent (opencode not installed).
 *   - isCliInstalled():probes `opencode` on PATH.
 *   - installCli(os):  npm i -g opencode-ai (all OSes).
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

const SPEC: ConfigDirSpec = { tool: "opencode", frozenPaths: FROZEN_PATHS };

/** Capture opencode's setup. Exported for direct use by the backup/status commands. */
export async function capture(
  ctx: CaptureContext,
  _opts?: { skipInstructions?: boolean },
): Promise<CaptureResult> {
  return captureConfigDir(ctx, SPEC);
}

/** Restore opencode's setup. Exported for direct use by the restore command. */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  return restoreConfigDir(ctx, data, SPEC);
}

/** True if opencode's config dir exists on this machine. */
async function detect(): Promise<boolean> {
  const { fs } = await import("../../utils/fs.js");
  return (await fs.statKind(home())) === "dir";
}

/** True if the `opencode` CLI resolves on PATH. */
async function isCliInstalled(): Promise<boolean> {
  return which(cliBinaryName("opencode"));
}

/** Install the opencode CLI (npm i -g opencode-ai) for the given OS. */
async function installCli(os: OS): Promise<void> {
  await runInstall(installCommandFor("opencode", os));
}

export const opencodeAdapter: Adapter = {
  id: "opencode",
  displayName: "opencode",
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

export default opencodeAdapter;
