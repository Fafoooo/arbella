/**
 * The Adapter object for Claude Code.
 *
 * Thin wiring layer: detection + CLI presence/install + delegation to the
 * capture/restore modules. All tool-specific path/plugin knowledge lives in the
 * sibling modules (paths.ts, plugins.ts, capture.ts, restore.ts).
 *
 * The R9 "skipInstructions" capture variant is NOT exposed on the Adapter
 * interface (capture(ctx) takes no opts there). The backup command imports the
 * capture module's `capture(ctx, { skipInstructions })` directly when shared
 * instructions are active; the Adapter.capture below is the default path.
 */

import type { Adapter, CaptureContext, RestoreContext, RestoreData } from "../adapter.interface.js";
import type { CaptureResult, OS } from "../../types.js";

import { fs } from "../../utils/fs.js";
import { cliBinaryName, installCommandFor } from "../../platform/os.js";
import { which, runInstall } from "../../platform/install.js";

import { paths } from "./paths.js";
import { capture as captureClaude } from "./capture.js";
import { restore as restoreClaude } from "./restore.js";

export const claudeAdapter: Adapter = {
  id: "claude",
  displayName: "Claude Code",

  /**
   * Present if ~/.claude exists AND it has recognizable content: a settings
   * file, a CLAUDE.md, or at least one agent. Graceful: returns false (never
   * throws) when the home dir is absent.
   */
  async detect(): Promise<boolean> {
    const p = paths();
    if (!(await fs.exists(p.home))) return false;
    if (await fs.exists(p.settings)) return true;
    if (await fs.exists(p.settingsLocal)) return true;
    if (await fs.exists(p.claudeMd)) return true;
    const agents = await fs.list(p.agentsDir);
    return agents.length > 0;
  },

  /** True if the `claude` CLI resolves on PATH. */
  async isCliInstalled(): Promise<boolean> {
    return which(cliBinaryName("claude"));
  },

  /** Install Claude Code's CLI for the given OS (npm i -g @anthropic-ai/claude-code). */
  async installCli(os: OS): Promise<void> {
    await runInstall(installCommandFor("claude", os));
  },

  /** Capture ~/.claude into a CaptureResult. */
  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    return captureClaude(ctx);
  },

  /** Restore ~/.claude from repo data. */
  async restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
    return restoreClaude(ctx, data);
  },
};

export default claudeAdapter;
