/**
 * `arbella update` — update the arbella CLI itself through npm.
 *
 * This intentionally does not update the user's backed-up AI tools. It only
 * reinstalls the published npm package that provides the `arbella` command.
 */

import type { Command } from "commander";

import { getPackageVersion } from "../core/version.js";
import { npmInstallGlobal } from "../platform/install.js";
import { log } from "../utils/log.js";

export interface UpdateOptions {
  /** Install this arbella version/tag instead of latest. */
  version?: string;
  /** Show the command without running npm. */
  dryRun?: boolean;
}

function normalizeVersion(version: string | undefined): string {
  const trimmed = version?.trim();
  if (!trimmed) return "latest";
  if (trimmed.startsWith("arbella@")) return trimmed.slice("arbella@".length);
  return trimmed.replace(/^v(?=\d)/, "");
}

export function packageSpec(version: string | undefined): string {
  return `arbella@${normalizeVersion(version)}`;
}

/** Attach the `update` subcommand to the program. */
export function register(program: Command): void {
  program
    .command("update")
    .description("Update arbella itself through npm")
    .option("--version <version>", "install a specific arbella version or npm tag instead of latest")
    .option("--dry-run", "show the npm command without running it")
    .action(async (opts: UpdateOptions) => {
      await run(opts);
    });
}

/** Execute the self-update flow. Directly callable from tests. */
export async function run(opts: UpdateOptions = {}): Promise<void> {
  const spec = packageSpec(opts.version);

  if (opts.dryRun) {
    log.info(`Would run: npm install -g ${spec}`);
    return;
  }

  log.info(`Updating arbella ${getPackageVersion()} -> ${spec}`);
  await npmInstallGlobal(spec);
  log.success(`arbella updated (${spec}).`);
}
