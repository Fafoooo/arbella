/**
 * picocolors-based logger. The single concrete Logger implementation injected
 * into adapters and commands. Writes human-facing lines to stderr so that any
 * machine-readable stdout (e.g. JSON status) stays clean.
 */

import pc from "picocolors";

import type { Logger } from "../types.js";

let verbose = false;

/** Enable/disable debug() output (wired from a global --verbose flag). */
export function setVerbose(on: boolean): void {
  verbose = on;
}

function out(line: string): void {
  // All decorative logging goes to stderr; reserve stdout for data payloads.
  process.stderr.write(line + "\n");
}

export const log: Logger = {
  info(msg: string): void {
    out(`${pc.blue("ℹ")} ${msg}`);
  },
  success(msg: string): void {
    out(`${pc.green("✓")} ${msg}`);
  },
  warn(msg: string): void {
    out(`${pc.yellow("⚠")} ${pc.yellow(msg)}`);
  },
  error(msg: string): void {
    out(`${pc.red("✗")} ${pc.red(msg)}`);
  },
  step(msg: string): void {
    out(`  ${pc.dim("›")} ${msg}`);
  },
  debug(msg: string): void {
    if (verbose) out(`${pc.dim("·")} ${pc.dim(msg)}`);
  },
};

export default log;
