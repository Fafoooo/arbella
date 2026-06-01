/**
 * arbella — CLI entry point.
 *
 * NOTE: do NOT add a `#!/usr/bin/env node` shebang here — tsup injects it via
 * `banner.js` in tsup.config.ts, and a second one in the source would land on
 * line 2 of the bundle and crash Node with "Invalid or unexpected token".
 *
 * Responsibility: wire commander, declare the global flags, register every
 * subcommand, and dispatch. No business logic lives here — each command module
 * owns its own behavior and exposes a `register(program)` that attaches its
 * subcommand. This file only:
 *
 *   1. Builds the root program (name/version/description + the adapter list in
 *      the help footer, sourced from the adapter registry so it never drifts).
 *   2. Declares the single global option `--verbose`, applied via a preAction
 *      hook so debug logging is enabled BEFORE any subcommand action runs.
 *   3. Registers setup / init / push / pull / status / update / auth / secrets.
 *   4. Parses argv and funnels any thrown error into a single, friendly
 *      top-level handler (log.error + exit 1) so stack traces never leak to the
 *      user. Commander's own --help / --version exits are passed through.
 *
 * VERSION: read from package.json via core/version.ts so release bumps do not
 * drift between the published package and `arbella --version`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import pc from "picocolors";

import { log, setVerbose } from "./utils/log.js";
import { listAdapters } from "./adapters/registry.js";
import { getPackageVersion } from "./core/version.js";

import { register as registerInit } from "./commands/init.js";
import { register as registerSetup } from "./commands/setup.js";
import { register as registerAuth } from "./commands/auth.js";
import { register as registerBackup } from "./commands/backup.js";
import { register as registerRestore } from "./commands/restore.js";
import { register as registerStatus } from "./commands/status.js";
import { register as registerUpdate } from "./commands/update.js";
import { register as registerSecrets } from "./commands/secrets.js";

/** arbella version, sourced from package.json. */
const VERSION = getPackageVersion();

/** Build the configured root program (no parsing yet — easy to unit-test). */
export function buildProgram(): Command {
  const program = new Command();

  // A footer that lists the tools arbella manages, pulled from the registry so
  // adding an adapter surfaces here automatically.
  const supported = listAdapters()
    .map((a) => a.displayName)
    .join(", ");

  program
    .name("arbella")
    .description(
      "Back up and migrate your complete AI dev setup across Linux, macOS, and " +
        "Windows — carry your tools, settings, plugins and skills to any machine.\n\n" +
        `Supported tools: ${supported}.`,
    )
    .version(VERSION, "-v, --version", "print the arbella version and exit")
    .option("--verbose", "print verbose (debug) output", false)
    // Show help (not an error dump) when an unknown command/flag is used.
    .showSuggestionAfterError(true)
    .configureHelp({ showGlobalOptions: true });

  // Apply the global --verbose BEFORE any subcommand action fires. optsWithGlobals
  // merges root + subcommand options so the flag works in any position.
  program.hook("preAction", (thisCommand, actionCommand) => {
    const verbose = Boolean(actionCommand.optsWithGlobals().verbose);
    setVerbose(verbose);
  });

  // Register every subcommand. Each module attaches exactly one command.
  registerInit(program);
  registerSetup(program);
  registerAuth(program);
  registerBackup(program);
  registerRestore(program);
  registerStatus(program);
  registerUpdate(program);
  registerSecrets(program);

  return program;
}

/** Parse argv and run. Centralizes error handling so commands can just throw. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(entry) === modulePath;
  }
}

function handleTopLevelError(err: unknown): never {
  // Commander throws a CommanderError for normal control-flow exits (--help,
  // --version, "unknown command"); it has already written its own output and
  // carries the intended exit code. Honor that code without double-printing.
  if (err && typeof err === "object" && (err as { code?: unknown }).code !== undefined) {
    const code = (err as { exitCode?: unknown }).exitCode;
    process.exit(typeof code === "number" ? code : 1);
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  if (err instanceof Error && err.stack) {
    // Stack only at debug volume; the one-line message is the default surface.
    log.debug(pc.dim(err.stack));
  }
  process.exit(1);
}

if (isDirectRun()) {
  main().catch(handleTopLevelError);
}
