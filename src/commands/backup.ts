/**
 * `arbella push` — capture the local AI dev setup and push it to the private
 * backup repo (R3). Also the entry point the autobackup SessionStart hook calls
 * with `--auto` (R4), and supports `--dry-run` (R14) to preview without writing.
 *
 * Responsibilities:
 *   1. Load + validate the local config.
 *   2. When `--auto`, gate the whole run through the throttle (quiet no-op when
 *      it is not yet time to back up).
 *   3. Ensure the backup repo is cloned locally (skipped in dry-run, which is
 *      fully side-effect free).
 *   4. Decide the shared-instructions case (R9): if ~/.claude/CLAUDE.md and
 *      ~/.codex/AGENTS.md are byte-identical, store them ONCE under
 *      shared/instructions.md and tell each adapter to skip its own copy.
 *   5. For every configured + present tool, run its capture() to produce a
 *      CaptureResult (frozen files + symlinks + reinstall manifest + secret
 *      refs). All sanitizing/templating happens inside capture via the injected
 *      CoreServices, so secrets are redacted and machine paths are placeheld
 *      BEFORE anything is written.
 *   6. Materialize the repo working tree: per-tool frozen files + symlinks +
 *      manifest.json, the shared instructions file (when sharing), the top-level
 *      arbella.json, a generated README.md, and a defensive .gitignore that
 *      bakes in the secret denylist.
 *   7. Commit + push (R3). Returns quietly with "nothing changed" when the tree
 *      is already up to date.
 *   8. Print a clear summary, including every secret that was deliberately
 *      skipped, so the user knows what they must re-supply elsewhere.
 *
 * SECURITY: this command never reads, prints, copies, or commits a secret VALUE.
 * Whole-file secrets (auth.json, .credentials.json, ...) are excluded by the
 * adapter denylists and only ever surface here as metadata (SecretRef). Value
 * redaction + path templating is performed by the sanitizer/templater inside
 * each adapter's capture(). The generated .gitignore is an additional belt-and-
 * braces guard so a stray secret file can never be committed by accident.
 *
 * CLOCK: only the command layer touches the clock. This
 * module reads `new Date().toISOString()` once and threads it inward (throttle,
 * meta.createdAt, default commit message).
 *
 * Cross-OS: every path is resolved via src/platform/os.ts + node:path; repoPaths
 * are POSIX strings (the on-disk contract) and are split back to native segments
 * when joined onto the local clone.
 */

import path from "node:path";

import type { Command } from "commander";

import type {
  CaptureResult,
  CapturedFile,
  ArbellaConfig,
  SecretRef,
  ToolId,
} from "../types.js";
import type { CaptureContext, CoreServices } from "../adapters/adapter.interface.js";

import { detectOS, toolHomeDir } from "../platform/os.js";
import { fs } from "../utils/fs.js";
import { log } from "../utils/log.js";

import { loadConfig } from "../core/config/index.js";
import { ensureLocalClone, commitAndPush } from "../core/repo/index.js";
import { maybeRunBackup } from "../core/autobackup/index.js";
import { buildRepoAuthHooks } from "./_context.js";
import { ensureDeps } from "./setup.js";
import {
  serialize,
  buildArbellaMeta,
  shouldShareInstructions,
  buildSharedInstructionsFile,
  SHARED_INSTRUCTIONS_REPO_PATH,
} from "../core/manifest/index.js";
import { sanitizer } from "../core/sanitizer/index.js";
import { templater } from "../core/templater/index.js";
import { buildVariables } from "../core/templater/variables.js";
import { denylistFor } from "../core/sanitizer/denylist.js";

// R9 note: capture(ctx, { skipInstructions }) lives on the capture modules, NOT
// on the Adapter interface (Adapter.capture(ctx) takes no opts). We therefore
// import the capture functions directly, and the adapter objects only for their
// detect() probe + display metadata.
import { claudeAdapter } from "../adapters/claude/index.js";
import { codexAdapter } from "../adapters/codex/index.js";
import { cursorAdapter } from "../adapters/cursor/index.js";
import { capture as captureClaude } from "../adapters/claude/capture.js";
import { capture as captureCodex } from "../adapters/codex/capture.js";
import { capture as captureCursor } from "../adapters/cursor/index.js";

import type { Adapter } from "../adapters/adapter.interface.js";

/** arbella version stamped into arbella.json (kept in sync with package.json). */
const ARBELLA_VERSION = "0.1.0";

/* -------------------------------------------------------------------------- */
/* Options + CLI registration                                                  */
/* -------------------------------------------------------------------------- */

/** Flags accepted by `arbella push`. */
export interface BackupOptions {
  /** Preview only: compute + print the plan, write/commit/push nothing (R14). */
  dryRun?: boolean;
  /** Invoked by the autobackup hook: gate through the throttle, stay quiet (R4). */
  auto?: boolean;
  /** Custom commit message (defaults to "arbella push <iso>"). */
  message?: string;
}

/**
 * Attach the `push` subcommand to the root program. Thin: it only parses
 * flags and delegates to {@link run} so the logic stays directly testable.
 *
 * Legacy aliases: `sync` and `backup` are also registered, hidden from `--help`,
 * so auto-hooks installed under the old command names (`arbella sync --auto`,
 * `arbella backup --auto`) keep working until the user re-runs `arbella init`,
 * which rewrites the hook to `arbella push --auto`.
 */
export function register(program: Command): void {
  const configure = (cmd: Command): Command =>
    cmd
      .description(
        "Push your AI dev setup to your private repo (snapshot local changes, then commit + push).",
      )
      .option("--dry-run", "show what would change without writing or pushing")
      .option(
        "--auto",
        "internal: run from the auto hook (throttled, quiet when skipped)",
      )
      .option("-m, --message <message>", "commit message for this push")
      .action(async (opts: BackupOptions) => {
        await run(opts);
      });

  configure(program.command("push"));
  configure(program.command("sync", { hidden: true }));
  configure(program.command("backup", { hidden: true }));
}

/* -------------------------------------------------------------------------- */
/* Capture dispatch (direct, opts-aware functions)                             */
/* -------------------------------------------------------------------------- */

/** A capture entry: the adapter (for detect/metadata) + its opts-aware capture. */
interface ToolCapture {
  adapter: Adapter;
  capture: (
    ctx: CaptureContext,
    opts?: { skipInstructions?: boolean },
  ) => Promise<CaptureResult>;
}

/** Map a ToolId to its adapter + capture function. */
function toolCaptureFor(tool: ToolId): ToolCapture {
  switch (tool) {
    case "claude":
      return { adapter: claudeAdapter, capture: captureClaude };
    case "codex":
      return { adapter: codexAdapter, capture: captureCodex };
    case "cursor":
      return { adapter: cursorAdapter, capture: captureCursor };
  }
}

/* -------------------------------------------------------------------------- */
/* Context assembly                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build the CoreServices bundle for a given tool home. The sanitizer/templater
 * singletons are stateless and shared; vars are rebuilt per tool so TOOL_HOME
 * collapses to its own placeholder ahead of HOME.
 */
function buildCoreServices(toolHome: string): CoreServices {
  return {
    fs,
    log,
    sanitizer,
    templater,
    vars: buildVariables(toolHome),
    os: detectOS(),
  };
}

/** Build the capture context for one tool. */
function buildCaptureContext(
  tool: ToolId,
  config: ArbellaConfig,
  dryRun: boolean,
): CaptureContext {
  const toolHome = toolHomeDir(tool);
  return {
    ...buildCoreServices(toolHome),
    toolHome,
    includeSecrets: config.includeSecrets,
    includeMemories: config.includeMemories,
    dryRun,
  };
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run a backup. See the module header for the full flow. `opts.auto` gates the
 * whole thing through the throttle; `opts.dryRun` makes it a pure preview.
 */
export async function run(opts: BackupOptions = {}): Promise<void> {
  const dryRun = opts.dryRun === true;
  const auto = opts.auto === true;
  // Single clock read at the boundary; threaded inward.
  const nowIso = new Date().toISOString();

  const config = await loadConfig();

  // --- R4: autobackup throttle gate ---------------------------------------
  // When fired by the SessionStart hook we must stay quiet unless it is time.
  // The throttle also records "now" as the last-run stamp when it returns true,
  // so rapid restarts don't hammer the repo.
  if (auto) {
    const go = await maybeRunBackup(config.autoBackup, nowIso);
    if (!go) {
      log.debug("Autobackup throttled or disabled; skipping this run.");
      return;
    }
  }

  // --- Tool selection ------------------------------------------------------
  const requested = config.tools;
  if (requested.length === 0) {
    log.warn("No tools configured for backup (config.tools is empty). Nothing to do.");
    return;
  }

  // Detect which requested tools are actually present on this machine. Absent
  // tools are skipped with a note (graceful absence) and
  // their existing repo subtree is left untouched (it may have been captured on
  // another machine).
  const present: ToolId[] = [];
  for (const tool of requested) {
    const { adapter } = toolCaptureFor(tool);
    if (await adapter.detect()) {
      present.push(tool);
    } else {
      log.warn(`Skipping ${adapter.displayName} (${tool}): not present on this machine.`);
    }
  }

  if (present.length === 0) {
    log.warn("None of the configured tools are present on this machine. Nothing to back up.");
    return;
  }

  // --- R9: shared-instructions decision ------------------------------------
  // Read CLAUDE.md + AGENTS.md (only for present tools) and decide whether they
  // are byte-identical. If so, both adapters skip their own copy and we store a
  // single shared/instructions.md.
  const sharing = await decideSharedInstructions(present);
  const sharedContent = sharing.share ? sharing.content : undefined;
  if (sharing.share) {
    log.debug("CLAUDE.md and AGENTS.md are identical; storing once as shared/instructions.md.");
  }

  // --- Capture each present tool ------------------------------------------
  log.info(dryRun ? "Dry run: capturing setup (nothing will be written)…" : "Capturing setup…");

  const results: CaptureResult[] = [];
  for (const tool of present) {
    const { adapter, capture } = toolCaptureFor(tool);
    const ctx = buildCaptureContext(tool, config, dryRun);
    // Only claude/codex carry CLAUDE.md/AGENTS.md; the flag is a no-op for
    // cursor but passing it uniformly keeps the call site simple.
    const skipInstructions = sharing.share && (tool === "claude" || tool === "codex");
    try {
      const result = await capture(ctx, { skipInstructions });
      results.push(result);
      log.step(
        `${adapter.displayName}: ${result.files.length} file(s), ` +
          `${result.symlinks.length} symlink(s), ${result.secrets.length} secret(s) excluded`,
      );
      for (const w of result.warnings) log.warn(`${tool}: ${w}`);
    } catch (err) {
      // A single tool failing must not abort the whole backup; record + move on.
      log.error(`Capture failed for ${adapter.displayName} (${tool}): ${errMessage(err)}`);
    }
  }

  if (results.length === 0) {
    log.warn("Capture produced no results. Nothing to back up.");
    return;
  }

  const capturedTools = results.map((r) => r.tool);
  const allSecrets = results.flatMap((r) => r.secrets);

  // --- Dry run: report + stop (no clone, no writes, no commit) -------------
  if (dryRun) {
    reportDryRun(results, sharedContent !== undefined, config);
    return;
  }

  // --- Ensure git + the local clone, then materialize the working tree ------
  // git is required to clone/commit/push. In an auto (background) run we must
  // never block on a prompt, so install non-interactively (or skip the prompt).
  await ensureDeps(["git"], { required: true, yes: auto });

  // Auth seams for a PRIVATE repo (gh/glab-first; install-on-demand or device-
  // flow/token fallback). An auto run is non-interactive so it can't prompt: it
  // will reuse a logged-in gh/glab or a stored token, else fail quietly.
  const authHooks = buildRepoAuthHooks({ createdAt: nowIso, interactive: !auto });

  await ensureLocalClone(config.repo, authHooks);
  const repoRoot = config.repo.localPath;

  // Mirror semantics: for each tool we captured, replace its `<tool>/files`
  // subtree wholesale so local deletions propagate to the repo. We deliberately
  // do NOT touch subtrees for tools we did not capture this run.
  for (const result of results) {
    await replaceToolFiles(repoRoot, result);
  }

  // Shared instructions (R9): write once when sharing, otherwise ensure a stale
  // shared file from a previous (sharing) backup is removed.
  if (sharedContent !== undefined) {
    const shared = buildSharedInstructionsFile(sharedContent);
    await writeCapturedFile(repoRoot, shared);
    log.step(`Wrote ${SHARED_INSTRUCTIONS_REPO_PATH} (shared CLAUDE.md == AGENTS.md)`);
  } else {
    await fs.rmrf(repoJoin(repoRoot, SHARED_INSTRUCTIONS_REPO_PATH));
  }

  // Top-level metadata (arbella.json) — createdAt supplied here (clock).
  const meta = buildArbellaMeta({
    arbellaVersion: ARBELLA_VERSION,
    tools: capturedTools,
    config,
    createdAt: nowIso,
    sharedInstructions: sharedContent !== undefined,
  });
  await fs.write(repoJoin(repoRoot, "arbella.json"), serialize(meta));

  // Generated repo scaffolding: restore README + defensive .gitignore.
  await fs.write(repoJoin(repoRoot, "README.md"), renderRepoReadme(meta, nowIso));
  await fs.write(repoJoin(repoRoot, ".gitignore"), renderRepoGitignore(capturedTools));

  // --- Commit + push (auth-aware: sign in on a private-repo push failure) --
  const message = opts.message ?? `arbella push ${nowIso}`;
  log.info("Committing + pushing setup…");
  const changed = await commitAndPush(repoRoot, message, {
    url: config.repo.url,
    auth: authHooks,
  });

  // --- Summary -------------------------------------------------------------
  printSummary({
    changed,
    repoRoot,
    capturedTools,
    results,
    secrets: allSecrets,
    sharing: sharedContent !== undefined,
    includeSecrets: config.includeSecrets,
  });
}

/* -------------------------------------------------------------------------- */
/* R9: shared-instructions decision                                            */
/* -------------------------------------------------------------------------- */

/** Outcome of the shared-instructions check. */
interface SharedDecision {
  share: boolean;
  content?: string;
}

/**
 * Read CLAUDE.md (claude home) and AGENTS.md (codex home) when both tools are
 * present, and decide via the manifest module's pure helper whether they are
 * identical and should be shared. Missing files => no sharing. Read failures are
 * swallowed (treated as "absent") so a transient FS hiccup can't break backup.
 */
async function decideSharedInstructions(present: ToolId[]): Promise<SharedDecision> {
  if (!present.includes("claude") || !present.includes("codex")) {
    return { share: false };
  }

  const claudeMd = await readIfExists(path.join(toolHomeDir("claude"), "CLAUDE.md"));
  const agentsMd = await readIfExists(path.join(toolHomeDir("codex"), "AGENTS.md"));

  if (shouldShareInstructions(claudeMd, agentsMd)) {
    // shouldShareInstructions guarantees both are defined + equal here.
    return { share: true, content: claudeMd };
  }
  return { share: false };
}

/* -------------------------------------------------------------------------- */
/* Repo working-tree materialization                                           */
/* -------------------------------------------------------------------------- */

/** The `<tool>/files` repo-relative prefix for a tool. POSIX separators. */
function toolFilesPrefix(tool: ToolId): string {
  return `${tool}/files`;
}

/**
 * Replace a captured tool's frozen subtree wholesale, then write its fresh files
 * + symlinks + manifest. Removing `<tool>/files` first makes the backup a true
 * mirror: files deleted locally disappear from the repo on the next backup.
 *
 * NOTE: memories (when included) are emitted by the codex adapter under
 * `codex/files/memories/...`, so they live inside the same subtree and are
 * covered by this replace.
 */
async function replaceToolFiles(repoRoot: string, result: CaptureResult): Promise<void> {
  const filesDir = repoJoin(repoRoot, toolFilesPrefix(result.tool));
  await fs.rmrf(filesDir);

  for (const file of result.files) {
    await writeCapturedFile(repoRoot, file);
  }

  for (const link of result.symlinks) {
    const linkPath = repoJoin(repoRoot, link.repoPath);
    // Preserve the link target verbatim: restore reads it
    // back exactly. fs.symlink removes any pre-existing entry first.
    await fs.symlink(link.target, linkPath);
  }

  // Per-tool reinstall manifest at `<tool>/manifest.json`.
  const manifestPath = repoJoin(repoRoot, `${result.tool}/manifest.json`);
  await fs.write(manifestPath, serialize(result.manifest));
}

/**
 * Write a single CapturedFile into the repo working tree. Handles the text vs.
 * base64-binary distinction and preserves an explicit file mode (e.g. 0o755 for
 * executable hooks/statusline scripts).
 */
async function writeCapturedFile(repoRoot: string, file: CapturedFile): Promise<void> {
  const dest = repoJoin(repoRoot, file.repoPath);
  if (file.binary === true) {
    const buf = Buffer.from(file.content, "base64");
    await fs.writeBytes(dest, buf, file.mode);
  } else {
    await fs.write(dest, file.content, file.mode);
  }
}

/**
 * Join a POSIX repoPath onto the local clone root using native separators.
 * repoPaths are always "/"-delimited (the on-disk contract); we split them so
 * the result is correct on Windows too.
 */
function repoJoin(repoRoot: string, repoPath: string): string {
  const segments = repoPath.split("/").filter((s) => s.length > 0);
  return path.join(repoRoot, ...segments);
}

/* -------------------------------------------------------------------------- */
/* Generated repo files (README + .gitignore)                                  */
/* -------------------------------------------------------------------------- */

/** Human-friendly tool label for generated docs. */
function toolLabel(tool: ToolId): string {
  switch (tool) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
  }
}

/**
 * Render the auto-generated repo README with restore instructions. Pure string
 * builder — no machine-identifying content, no secrets.
 */
function renderRepoReadme(
  meta: { tools: ToolId[]; createdAt: string; sharedInstructions: boolean; arbellaVersion: string },
  generatedAtIso: string,
): string {
  const toolList = meta.tools.map((t) => `- ${toolLabel(t)} (\`${t}\`)`).join("\n");
  const sharedLine = meta.sharedInstructions
    ? "Your `CLAUDE.md` and `AGENTS.md` were identical and are stored once in " +
      "[`shared/instructions.md`](shared/instructions.md); restore deploys it to both tools.\n"
    : "";

  return `# arbella backup

This is a **private** backup of an AI coding setup, produced by
[arbella](https://github.com/) v${meta.arbellaVersion}.

It contains the *portable* parts of each tool's configuration — settings,
agents, commands, hooks, skills, and a reinstall manifest (plugins,
marketplaces, npm globals). It is safe to keep private and version-controlled.

> Generated: ${generatedAtIso}

## What's inside

${toolList}

Each tool lives under \`<tool>/\`:

- \`<tool>/files/…\` — frozen config files (paths replaced with \`{{HOME}}\`-style
  placeholders, secret values redacted).
- \`<tool>/manifest.json\` — what to reinstall (plugins, marketplaces, skills,
  npm globals) and which plugins to re-enable.

\`arbella.json\` at the root records the schema version, the tools captured, the
options that were active, and when this backup was made.

${sharedLine}
## Set up on a new machine

\`\`\`sh
npm install -g arbella
arbella pull <this-repo-url>
\`\`\`

arbella will (R6/R14) take a timestamped safety copy of any existing tool homes,
auto-install missing CLIs, write the frozen files back (re-expanding placeholders
to this machine's paths), reinstall plugins/marketplaces/skills, and re-enable
plugins.

## Secrets are NOT in this repo

Credentials are intentionally excluded:

- \`~/.claude/.credentials.json\`, \`~/.claude/.claude.json\`
- \`~/.codex/auth.json\`
- any API keys / tokens inside otherwise-safe files (redacted to \`{{REDACTED}}\`)

After restoring you will need to **re-authenticate** each tool (e.g. \`claude\`
login, \`codex\` login). To move secrets between your own machines without ever
committing them, use the encrypted local bundle:

\`\`\`sh
arbella secrets export --out secrets.blob   # on the old machine (prompts for a passphrase)
arbella secrets import --in  secrets.blob   # on the new machine (same passphrase)
\`\`\`

The blob never touches git and is never printed.
`;
}

/**
 * Render a defensive `.gitignore` for the backup repo. Belt-and-braces: even
 * though captured files are already filtered through the denylist, this ensures
 * a stray secret/cruft file dropped into the working tree can never be staged.
 *
 * We translate the per-tool denylist into ignore globs scoped under each tool's
 * `files/` dir, and add a small set of universal cruft rules.
 */
function renderRepoGitignore(tools: ToolId[]): string {
  const lines: string[] = [
    "# Auto-generated by arbella. Do not commit secrets or machine cruft.",
    "",
    "# OS / editor cruft",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "",
    "# Databases / caches (never useful in a portable backup)",
    "*.sqlite",
    "*.sqlite-shm",
    "*.sqlite-wal",
    "*.db",
    "*.db-shm",
    "*.db-wal",
    "*.log",
    "",
    "# Secret files (excluded wholesale on capture; ignored here as a safety net)",
  ];

  // Always ignore the well-known whole-file secrets by basename, anywhere.
  const secretBasenames = [
    ".credentials.json",
    ".claude.json",
    "auth.json",
    "history.jsonl",
    ".env",
    "*.pem",
    "*.key",
  ];
  for (const name of secretBasenames) lines.push(name);

  // Scope each tool's denylist directory patterns under <tool>/files/ so noise
  // dirs (sessions/, cache/, …) cannot sneak in if someone copies a raw home in.
  lines.push("", "# Per-tool excluded directories (scoped under <tool>/files/)");
  const seen = new Set<string>();
  for (const tool of tools) {
    for (const pattern of denylistFor(tool)) {
      // Only directory patterns are useful to scope here; loose globs are already
      // covered by the universal rules above.
      if (!pattern.endsWith("/")) continue;
      const scoped = `${tool}/files/${pattern}`;
      if (seen.has(scoped)) continue;
      seen.add(scoped);
      lines.push(scoped);
    }
  }

  return lines.join("\n") + "\n";
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Print the dry-run plan: per-tool file/symlink counts, the would-be file list,
 * the shared-instructions decision, and the secrets that would be skipped.
 * Writes nothing and commits nothing.
 */
function reportDryRun(
  results: CaptureResult[],
  sharing: boolean,
  config: ArbellaConfig,
): void {
  log.info("Dry run — the following would be backed up (no files written, no commit):");

  for (const result of results) {
    log.step(`${toolLabel(result.tool)} (${result.tool}):`);
    for (const file of result.files) {
      log.step(`  + ${file.repoPath}`);
    }
    for (const link of result.symlinks) {
      log.step(`  → ${link.repoPath} -> ${link.target}`);
    }
    const m = result.manifest;
    log.step(
      `  manifest: ${m.plugins.length} plugin(s), ${m.marketplaces.length} marketplace(s), ` +
        `${m.skills.length} skill(s), ${m.npmGlobals.length} npm global(s)`,
    );
  }

  if (sharing) {
    log.step(`+ ${SHARED_INSTRUCTIONS_REPO_PATH} (shared CLAUDE.md == AGENTS.md)`);
  }
  log.step("+ arbella.json, README.md, .gitignore");

  reportSecrets(results.flatMap((r) => r.secrets), config.includeSecrets);
  log.info("Dry run complete. Re-run without --dry-run to write + push.");
}

/**
 * Print the post-backup summary. Always lists skipped secrets so the user knows
 * what must be re-supplied (e.g. via `arbella secrets import` or a fresh login).
 */
function printSummary(args: {
  changed: boolean;
  repoRoot: string;
  capturedTools: ToolId[];
  results: CaptureResult[];
  secrets: SecretRef[];
  sharing: boolean;
  includeSecrets: boolean;
}): void {
  const { changed, repoRoot, capturedTools, results, secrets, sharing, includeSecrets } = args;

  const totalFiles = results.reduce((n, r) => n + r.files.length, 0);
  const totalLinks = results.reduce((n, r) => n + r.symlinks.length, 0);

  if (changed) {
    log.success(
      `Backed up ${capturedTools.map(toolLabel).join(", ")} ` +
        `(${totalFiles} file(s), ${totalLinks} symlink(s)) and pushed to your repo.`,
    );
  } else {
    log.success("Backup is already up to date — nothing changed, nothing pushed.");
  }
  if (sharing) {
    log.step("Shared instructions stored once (CLAUDE.md == AGENTS.md).");
  }
  log.step(`Local clone: ${repoRoot}`);

  reportSecrets(secrets, includeSecrets);
}

/**
 * Print the secrets summary.
 *
 *  - File-kind secrets (whole credential files: .credentials.json, auth.json) are
 *    ALWAYS excluded by the denylist — never in the repo, regardless of the flag.
 *  - Value-kind secrets (inline values in shareable configs) are REDACTED in place
 *    when includeSecrets is OFF (default), or CARRIED VERBATIM into the private
 *    repo when includeSecrets is ON (the opt-in "risk"). The summary reflects
 *    which actually happened so the wording matches behavior (no dead-flag claim).
 */
function reportSecrets(secrets: SecretRef[], includeSecrets: boolean): void {
  if (secrets.length === 0) {
    log.step("No secrets detected.");
    return;
  }

  // Dedupe identical (tool, source) refs so the summary stays readable.
  const seen = new Set<string>();
  const unique: SecretRef[] = [];
  for (const ref of secrets) {
    const key = `${ref.tool} ${ref.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }

  const fileSecrets = unique.filter((r) => r.kind === "file");
  const valueSecrets = unique.filter((r) => r.kind === "value");

  if (fileSecrets.length > 0) {
    log.warn(
      `${fileSecrets.length} secret file(s) were EXCLUDED (never in the repo):`,
    );
    for (const ref of fileSecrets) {
      log.step(`  [file]  ${ref.tool}: ${ref.source} — ${ref.description}`);
    }
  }

  if (valueSecrets.length > 0) {
    if (includeSecrets) {
      log.warn(
        `${valueSecrets.length} inline secret value(s) were CARRIED VERBATIM into ` +
          "the (private) repo because includeSecrets is ON — keep the repo private:",
      );
    } else {
      log.warn(
        `${valueSecrets.length} inline secret value(s) were REDACTED in place and ` +
          "are NOT in the repo:",
      );
    }
    for (const ref of valueSecrets) {
      log.step(`  [value] ${ref.tool}: ${ref.source} — ${ref.description}`);
    }
  }

  if (!includeSecrets) {
    log.step(
      "Re-authenticate each tool after restore, or move secrets between your own " +
        "machines with `arbella secrets export` / `import` (encrypted, never committed).",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Read a file, returning undefined when it is absent or unreadable. */
async function readIfExists(p: string): Promise<string | undefined> {
  try {
    if (!(await fs.exists(p))) return undefined;
    return await fs.read(p);
  } catch {
    return undefined;
  }
}

/** Best-effort message extraction from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
