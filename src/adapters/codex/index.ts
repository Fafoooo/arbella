/**
 * The Adapter object for Codex (OpenAI Codex CLI), wiring together this module's
 * paths/capture/restore. All tool-specific knowledge lives in the sibling files;
 * this file only adapts them to the shared Adapter contract.
 *
 *   id:           "codex"
 *   displayName:  "Codex"
 *   detect:       ~/.codex exists AND (config.toml OR AGENTS.md present)
 *   isCliInstalled: `codex` resolves on PATH
 *   installCli:   runs installCommandFor("codex", os)  (npm i -g @openai/codex)
 *   capture/restore: delegate to ./capture.js and ./restore.js
 *
 * Graceful absence: detect() returns false (never throws) when ~/.codex is
 * missing, so the backup/restore commands cleanly skip a machine without Codex.
 */

import type { OS } from "../../types.js";
import type { Adapter } from "../adapter.interface.js";
import type { CaptureContext, RestoreContext, RestoreData } from "../adapter.interface.js";
import type { CaptureResult } from "../../types.js";

import { cliBinaryName, installCommandFor } from "../../platform/os.js";
import { runInstall, which } from "../../platform/install.js";
import { fs } from "../../utils/fs.js";

import { paths as codexPaths } from "./paths.js";
import { capture as captureCodex } from "./capture.js";
import { restore as restoreCodex } from "./restore.js";

/**
 * True if a Codex setup is present on this machine: the home dir exists and has
 * at least one recognizable config artifact (config.toml or AGENTS.md). Tolerant
 * of a partially-populated dir.
 */
async function detect(): Promise<boolean> {
  const p = codexPaths();
  if (!(await fs.exists(p.home))) return false;
  if (await fs.exists(p.configToml)) return true;
  if (await fs.exists(p.agentsMd)) return true;
  return false;
}

/** True if the `codex` CLI is on PATH. */
async function isCliInstalled(): Promise<boolean> {
  return which(cliBinaryName("codex"));
}

/** Install the Codex CLI for the given OS (npm i -g @openai/codex). */
async function installCli(os: OS): Promise<void> {
  await runInstall(installCommandFor("codex", os));
}

/** Capture delegate (Adapter signature: ctx only; opts handled by the module fn). */
function capture(ctx: CaptureContext): Promise<CaptureResult> {
  return captureCodex(ctx);
}

/** Restore delegate. */
function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  return restoreCodex(ctx, data);
}

/** The Codex adapter. */
export const codexAdapter: Adapter = {
  id: "codex",
  displayName: "Codex",
  detect,
  isCliInstalled,
  installCli,
  capture,
  restore,
};

export default codexAdapter;
