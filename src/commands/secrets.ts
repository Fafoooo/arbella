/**
 * `arbella secrets` — LOCAL-ONLY encrypted transfer of secret files (R5).
 *
 * Two subcommands:
 *   - `arbella secrets export`  : discover the secret files across every tool
 *     (auth tokens / credentials), prompt for a passphrase, and write a single
 *     encrypted blob the user copies out of band (USB, password manager, etc).
 *   - `arbella secrets import`  : read a blob + passphrase and write the secret
 *     files back onto this machine's tool homes.
 *
 * HARD security rules honored here:
 *   - This flow NEVER touches git. It is completely separate from backup/restore.
 *   - Secret VALUES are never printed, logged, or echoed. The passphrase prompt
 *     uses a masked input; on import we only report file paths, never contents.
 *   - The only artifact that leaves the machine is the opaque encrypted blob; the
 *     only thing written on import is plaintext onto the user's own tool homes
 *     (with restrictive modes, handled by core/secrets).
 *
 * Clock rule: the command layer owns the clock. We mint the
 * `createdAt` ISO string here and pass it inward; core/secrets stays clock-free.
 *
 * The actual crypto + file IO lives in core/secrets; this module is a thin,
 * interactive front-end (flag parsing + clack prompts + friendly reporting).
 */

import path from "node:path";

import type { Command } from "commander";
import * as clack from "@clack/prompts";

import type { SecretRef, ToolId } from "../types.js";
import { TOOL_IDS } from "../types.js";
import {
  applySecretBundle,
  collectSecretFiles,
  decryptBundle,
  encryptBundle,
  gatherSecretRefs,
  type SecretBundle,
} from "../core/secrets/index.js";
import { fs } from "../utils/fs.js";
import { log } from "../utils/log.js";

/* -------------------------------------------------------------------------- */
/* Option shapes (commander passes these in)                                  */
/* -------------------------------------------------------------------------- */

/** Options for `arbella secrets export`. `out` is the blob output file path. */
export interface SecretsExportOptions {
  /** Where to write the encrypted blob (e.g. "arbella-secrets.blob"). */
  out: string;
}

/** Options for `arbella secrets import`. `in` is the blob input file path. */
export interface SecretsImportOptions {
  /** Path to the encrypted blob produced by `secrets export`. */
  in: string;
}

/** Default filename used when the user doesn't pass `--out`/`--in`. */
const DEFAULT_BLOB_FILE = "arbella-secrets.blob";

/* -------------------------------------------------------------------------- */
/* Commander registration                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Attach `arbella secrets export|import` to the program. Kept declarative so
 * the actual work lives in the directly-callable `runExport` / `runImport`
 * (which tests can invoke without spinning up commander).
 */
export function register(program: Command): void {
  const secrets = program
    .command("secrets")
    .description(
      "Move secret files (auth tokens / credentials) between machines via an " +
        "encrypted, passphrase-protected blob. Never uses git.",
    );

  secrets
    .command("export")
    .description(
      "Bundle this machine's secret files into an encrypted blob you copy out of band.",
    )
    .option(
      "-o, --out <file>",
      "File to write the encrypted blob to.",
      DEFAULT_BLOB_FILE,
    )
    .action(async (opts: SecretsExportOptions) => {
      await runExport(opts);
    });

  secrets
    .command("import")
    .description(
      "Decrypt a secrets blob and write the secret files back onto this machine.",
    )
    .option(
      "-i, --in <file>",
      "Encrypted blob file to read (from `secrets export`).",
      DEFAULT_BLOB_FILE,
    )
    .action(async (opts: SecretsImportOptions) => {
      await runImport(opts);
    });
}

/* -------------------------------------------------------------------------- */
/* secrets export                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Discover secret files across all known tools, prompt for a passphrase, encrypt
 * the bundle, and write the opaque blob to `opts.out`.
 *
 * Never prints secret contents. The on-screen summary lists only tool + relative
 * file name (e.g. "claude: .credentials.json") so the user knows what's inside.
 */
export async function runExport(opts: SecretsExportOptions): Promise<void> {
  clack.intro("arbella secrets export");

  // 1) Discover which secret files actually exist on this machine, per tool.
  const refs: SecretRef[] = [];
  for (const tool of TOOL_IDS) {
    const found = await gatherSecretRefs(tool);
    refs.push(...found);
  }

  if (refs.length === 0) {
    clack.note(
      "No secret files were found on this machine. Nothing to export.\n" +
        "(Tools store credentials in files like ~/.claude/.credentials.json or " +
        "~/.codex/auth.json — none are present here.)",
      "Nothing to do",
    );
    clack.outro("No blob written.");
    return;
  }

  // Show metadata ONLY — never the secret values.
  clack.note(formatRefList(refs), `Found ${refs.length} secret file(s)`);

  // 2) Prompt for a passphrase (masked) + confirm it matches.
  const passphrase = await promptNewPassphrase();
  if (passphrase === null) {
    clack.cancel("Export cancelled.");
    return;
  }

  // 3) Collect the real bytes and encrypt. The clock lives here (§0.5).
  const createdAt = new Date().toISOString();
  const bundle: SecretBundle = await collectSecretFiles(refs, createdAt);

  if (bundle.entries.length === 0) {
    // Files disappeared between discovery and read (e.g. a logout). Don't write
    // an empty, useless blob.
    clack.cancel(
      "Secret files vanished before they could be read; nothing to export.",
    );
    return;
  }

  const blob = encryptBundle(bundle, passphrase);

  // 4) Write the blob. fs.write ensures the parent dir exists. 0o600 so the blob
  //    (though encrypted) is not left world-readable.
  const outPath = path.resolve(opts.out);
  await fs.write(outPath, blob + "\n", 0o600);

  clack.note(
    [
      `Wrote encrypted blob to:\n  ${outPath}`,
      "",
      "This blob is safe to copy between machines (it is encrypted with your",
      "passphrase). It NEVER goes through git. On the target machine run:",
      `  arbella secrets import --in ${path.basename(outPath)}`,
      "",
      "Keep your passphrase safe: without it the blob cannot be decrypted.",
    ].join("\n"),
    "Done",
  );
  clack.outro(`Exported ${bundle.entries.length} secret file(s).`);
}

/* -------------------------------------------------------------------------- */
/* secrets import                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read a blob from `opts.in`, prompt for the passphrase, decrypt, and write the
 * secret files back onto this machine's tool homes.
 *
 * A wrong passphrase / tampered blob fails loudly (GCM auth) before any file is
 * touched. Reports only file paths, never contents. Never touches git.
 */
export async function runImport(opts: SecretsImportOptions): Promise<void> {
  clack.intro("arbella secrets import");

  const inPath = path.resolve(opts.in);

  if (!(await fs.exists(inPath))) {
    clack.cancel(
      `No blob found at:\n  ${inPath}\n` +
        "Pass the file you produced with `arbella secrets export` via --in.",
    );
    return;
  }

  let blob: string;
  try {
    blob = (await fs.read(inPath)).trim();
  } catch (err) {
    clack.cancel(`Could not read blob file: ${errMessage(err)}`);
    return;
  }

  if (blob.length === 0) {
    clack.cancel("The blob file is empty.");
    return;
  }

  // Prompt for the passphrase (masked, single entry — we verify by decrypting).
  const passphrase = await promptPassphrase(
    "Enter the passphrase used to create this blob",
  );
  if (passphrase === null) {
    clack.cancel("Import cancelled.");
    return;
  }

  // Decrypt. A wrong passphrase or tampered blob throws here, before any write.
  let bundle: SecretBundle;
  try {
    bundle = decryptBundle(blob, passphrase);
  } catch (err) {
    // core/secrets throws a deliberately secret-free message.
    clack.cancel(errMessage(err));
    return;
  }

  if (bundle.entries.length === 0) {
    clack.note("The blob decrypted but contained no secret files.", "Nothing to write");
    clack.outro("No files written.");
    return;
  }

  // Show what WILL be written (paths only) before touching disk.
  clack.note(
    formatBundleTargets(bundle),
    `Restoring ${bundle.entries.length} secret file(s)`,
  );

  try {
    await applySecretBundle(bundle);
  } catch (err) {
    // e.g. a path-traversal guard tripped, or a write failed.
    clack.cancel(`Failed to write secret files: ${errMessage(err)}`);
    return;
  }

  clack.note(
    "Secret files were written with owner-only permissions.\n" +
      "You should now be authenticated again in the affected tools.",
    "Done",
  );
  clack.outro(`Imported ${bundle.entries.length} secret file(s).`);
}

/* -------------------------------------------------------------------------- */
/* Prompt helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Prompt for a brand-new passphrase, requiring confirmation so a typo doesn't
 * produce a blob the user can never open. Returns `null` if the user cancels
 * (Ctrl-C) at any point.
 */
async function promptNewPassphrase(): Promise<string | null> {
  const first = await promptPassphrase("Choose a passphrase to encrypt the blob");
  if (first === null) return null;

  const second = await clack.password({
    message: "Confirm the passphrase",
    validate(value) {
      if (!value || value.length === 0) return "Passphrase cannot be empty.";
      if (value !== first) return "Passphrases do not match.";
      return undefined;
    },
  });
  if (clack.isCancel(second)) return null;

  return first;
}

/**
 * Single masked passphrase prompt. Returns the entered string, or `null` when
 * the user cancels. Empty input is rejected by the validator.
 */
async function promptPassphrase(message: string): Promise<string | null> {
  const value = await clack.password({
    message,
    validate(v) {
      if (!v || v.length === 0) return "Passphrase cannot be empty.";
      return undefined;
    },
  });
  if (clack.isCancel(value)) return null;
  return value;
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers (metadata only — never secret values)                  */
/* -------------------------------------------------------------------------- */

/** Render a list of discovered secret refs as "tool: relPath — description". */
function formatRefList(refs: SecretRef[]): string {
  return refs
    .map((r) => `${toolLabel(r.tool)}: ${r.source}  (${r.description})`)
    .join("\n");
}

/** Render the destinations a bundle will write to (paths only, no contents). */
function formatBundleTargets(bundle: SecretBundle): string {
  return bundle.entries
    .map((e) => `${toolLabel(e.tool)}: ${e.relPath}`)
    .join("\n");
}

/** Stable display label for a tool id. */
function toolLabel(tool: ToolId): string {
  switch (tool) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "opencode":
      return "opencode";
    case "copilot":
      return "copilot";
    case "kilo":
      return "kilo";
  }
}

/** Extract a safe error message string from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Re-exported so the CLI entry / other commands can reference the plain logger if
 * they want non-interactive output in a piped context. Not used internally beyond
 * keeping a single import surface; clack already writes to stderr.
 */
export { log };
