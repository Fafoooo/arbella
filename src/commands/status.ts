/**
 * `arbella status` — show what a backup *would* change (R3 status).
 *
 * Read-only. Never writes to the tool homes or the repo working tree, never
 * commits, never installs anything. It answers one question: "if I ran
 * `arbella push` right now, what would change in the backup repo?"
 *
 * Strategy:
 *   1. loadConfig() to learn the repo location, the in-scope tools, and options.
 *   2. ensureLocalClone() so there is a working copy to diff against (clone-only;
 *      it does not pull/commit). If the repo has never been backed up, every
 *      would-be file shows as "added".
 *   3. Read CLAUDE.md + AGENTS.md and decide R9 sharing exactly as backup does,
 *      so the shared/instructions.md vs per-tool CLAUDE.md/AGENTS.md split lines
 *      up with what a real backup would produce (otherwise the instructions file
 *      would always look "removed").
 *   4. For each detected tool run adapter.capture(ctx, { skipInstructions }) with
 *      dryRun:true. capture() never writes; it just computes the would-be frozen
 *      files + symlinks + reinstall manifest + secret refs.
 *   5. Diff the would-be repo paths against what is committed on disk under
 *      repo.localPath: classify each as added / changed / unchanged, and find
 *      committed tool files that are no longer produced (removed).
 *   6. Diff each tool's would-be manifest against the committed manifest.json to
 *      surface plugin / marketplace / skill / npm-global / enabled-plugin drift.
 *   7. Print a human table to STDERR (via log), or a machine-readable JSON report
 *      to STDOUT when --json (so the JSON payload stays clean).
 *
 * No clock is used for any library decision; status only reads. (The only time
 * facts here come from the filesystem, not Date.now().)
 */

import path from "node:path";
import process from "node:process";

import type { Command } from "commander";

import type {
  CapturedFile,
  CapturedSymlink,
  CaptureResult,
  MarketplaceEntry,
  NpmGlobalEntry,
  PluginEntry,
  SecretRef,
  SkillEntry,
  ToolId,
  ToolManifest,
} from "../types.js";
import type { CaptureContext } from "../adapters/adapter.interface.js";

import { fs } from "../utils/fs.js";
import { log } from "../utils/log.js";
import { detectOS, toolHomeDir } from "../platform/os.js";

import { loadConfig } from "../core/config/index.js";
import { ensureLocalClone } from "../core/repo/index.js";
import { buildVariables } from "../core/templater/variables.js";
import { sanitizer } from "../core/sanitizer/index.js";
import { templater } from "../core/templater/index.js";
import {
  parseManifest,
  serialize,
  shouldShareInstructions,
  buildSharedInstructionsFile,
  SHARED_INSTRUCTIONS_REPO_PATH,
} from "../core/manifest/index.js";

import { claudeAdapter } from "../adapters/claude/index.js";
import { codexAdapter } from "../adapters/codex/index.js";
import { cursorAdapter } from "../adapters/cursor/index.js";
import { opencodeAdapter } from "../adapters/opencode/index.js";
import { copilotAdapter } from "../adapters/copilot/index.js";
import { kiloAdapter } from "../adapters/kilo/index.js";

// The R9 `skipInstructions` capture variant is NOT exposed on the Adapter
// interface (Adapter.capture(ctx) takes no opts). Mirror the backup command and
// import each tool's standalone capture module fn, which accepts the opts.
import { capture as captureClaude } from "../adapters/claude/capture.js";
import { capture as captureCodex } from "../adapters/codex/capture.js";
import { capture as captureCursor } from "../adapters/cursor/index.js";
import { capture as captureOpencode } from "../adapters/opencode/index.js";
import { capture as captureCopilot } from "../adapters/copilot/index.js";
import { capture as captureKilo } from "../adapters/kilo/index.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface StatusOptions {
  /** Emit a machine-readable JSON report on stdout instead of a human table. */
  json?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Report shapes (also the JSON payload contract)                              */
/* -------------------------------------------------------------------------- */

/** Classification of a single would-be repo file relative to what's committed. */
export type FileChangeKind = "added" | "changed" | "removed" | "unchanged";

export interface FileChange {
  /** Repo-relative POSIX path (e.g. "claude/files/settings.json"). */
  repoPath: string;
  kind: FileChangeKind;
  /** True for a symlink entry rather than a regular file. */
  symlink?: boolean;
}

/** A drift entry for a manifest collection (plugins, marketplaces, ...). */
export interface ManifestDrift {
  /** Which manifest collection drifted. */
  category:
    | "plugins"
    | "marketplaces"
    | "skills"
    | "npmGlobals"
    | "enabledPlugins";
  /** Items present locally but not in the committed manifest. */
  added: string[];
  /** Items present in the committed manifest but no longer produced locally. */
  removed: string[];
  /** Items present in both but whose recorded details differ. */
  changed: string[];
}

export interface ToolStatus {
  tool: ToolId;
  /** False when the tool is configured but not present on this machine. */
  present: boolean;
  /** File-level changes (added/changed/removed only; unchanged are omitted). */
  files: FileChange[];
  /** Manifest collection drift (only categories that actually differ). */
  manifest: ManifestDrift[];
  /** Secrets that would be excluded/redacted (metadata only — never values). */
  secrets: Array<{ source: string; key: string; kind: SecretRef["kind"]; description: string }>;
  /** Non-fatal warnings surfaced by capture (missing optional files, etc.). */
  warnings: string[];
}

export interface StatusReport {
  /** Absolute path to the local backup-repo working copy. */
  repoPath: string;
  /** True when the working copy has at least one commit / existing content. */
  repoInitialized: boolean;
  /** R9: whether CLAUDE.md and AGENTS.md are shared as one file this run. */
  sharedInstructions: boolean;
  /** Whether secrets are being carried into the repo (config.includeSecrets). */
  includeSecrets: boolean;
  /** Per-tool status. */
  tools: ToolStatus[];
  /** Repo-level (non-tool) file changes, e.g. shared/instructions.md. */
  shared: FileChange[];
  /** True when nothing at all would change. */
  clean: boolean;
}

/* -------------------------------------------------------------------------- */
/* Adapter lookup (commands may import the three adapters directly)            */
/* -------------------------------------------------------------------------- */

/** Standalone capture fn signature (accepts the R9 skipInstructions opt). */
type CaptureFn = (
  ctx: CaptureContext,
  opts?: { skipInstructions?: boolean },
) => Promise<CaptureResult>;

/** Per-tool wiring: the Adapter (for detect) + its opts-aware capture fn. */
const ADAPTERS: Record<ToolId, { adapter: import("../adapters/adapter.interface.js").Adapter; capture: CaptureFn }> = {
  claude: { adapter: claudeAdapter, capture: captureClaude },
  codex: { adapter: codexAdapter, capture: captureCodex },
  cursor: { adapter: cursorAdapter, capture: captureCursor },
  opencode: { adapter: opencodeAdapter, capture: captureOpencode },
  copilot: { adapter: copilotAdapter, capture: captureCopilot },
  kilo: { adapter: kiloAdapter, capture: captureKilo },
};

/* -------------------------------------------------------------------------- */
/* Command registration                                                        */
/* -------------------------------------------------------------------------- */

export function register(program: Command): void {
  program
    .command("status")
    .description(
      "Show what a push would change: files added/changed/removed, plugin drift, excluded secrets.",
    )
    .option("--json", "Output a machine-readable JSON report on stdout.")
    .action(async (opts: StatusOptions) => {
      await run(opts);
    });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export async function run(opts: StatusOptions): Promise<void> {
  const config = await loadConfig();

  // Make sure there's a working copy to compare against. ensureLocalClone is
  // clone-only (it never pulls/commits), so this stays read-only for our needs.
  await ensureLocalClone(config.repo);

  const repoRoot = config.repo.localPath;
  const repoInitialized = await isRepoInitialized(repoRoot);

  // --- R9 decision (mirror backup) -----------------------------------------
  // Read the live CLAUDE.md / AGENTS.md to decide whether the two instruction
  // files would be stored once (shared/instructions.md) or per-tool.
  const claudeMd = await readIfExists(path.join(toolHomeDir("claude"), "CLAUDE.md"));
  const agentsMd = await readIfExists(path.join(toolHomeDir("codex"), "AGENTS.md"));
  const sharing = shouldShareInstructions(claudeMd, agentsMd);

  // --- Per-tool capture + diff ---------------------------------------------
  const toolStatuses: ToolStatus[] = [];

  for (const tool of config.tools) {
    const wiring = ADAPTERS[tool];
    if (!wiring) continue; // unknown id (schema prevents this, but stay safe)
    const { adapter, capture } = wiring;

    const present = await safeDetect(adapter.detect.bind(adapter));
    if (!present) {
      toolStatuses.push({
        tool,
        present: false,
        files: [],
        manifest: [],
        secrets: [],
        warnings: [`${tool}: not present on this machine; nothing to back up.`],
      });
      continue;
    }

    const ctx = buildCaptureContext(tool, config.includeSecrets, config.includeMemories);
    let result: CaptureResult;
    try {
      // claude/codex captures honor skipInstructions for R9; cursor ignores it.
      result = await capture(ctx, { skipInstructions: sharing });
    } catch (err) {
      // A capture failure for one tool must not abort the whole status run.
      toolStatuses.push({
        tool,
        present: true,
        files: [],
        manifest: [],
        secrets: [],
        warnings: [`${tool}: capture failed: ${errMessage(err)}`],
      });
      continue;
    }

    const fileChanges = await diffFiles(repoRoot, result.files, result.symlinks);
    const removed = await findRemovedToolFiles(
      repoRoot,
      tool,
      expectedRepoPathsForTool(result.files, result.symlinks),
    );
    fileChanges.push(...removed);

    const manifestDrift = await diffManifest(repoRoot, tool, result.manifest);

    toolStatuses.push({
      tool,
      present: true,
      files: sortChanges(fileChanges),
      manifest: manifestDrift,
      secrets: result.secrets.map((s) => ({
        source: s.source,
        key: s.key,
        kind: s.kind,
        description: s.description,
      })),
      warnings: result.warnings,
    });
  }

  // --- Shared instructions (R9) diff ---------------------------------------
  const sharedChanges: FileChange[] = [];
  if (sharing && claudeMd !== undefined) {
    const file = buildSharedInstructionsFile(claudeMd);
    const change = await classifyFile(repoRoot, file);
    if (change.kind !== "unchanged") sharedChanges.push(change);
  } else {
    // Not sharing this run: a previously-committed shared file is now stale.
    if (await committedFileExists(repoRoot, SHARED_INSTRUCTIONS_REPO_PATH)) {
      sharedChanges.push({ repoPath: SHARED_INSTRUCTIONS_REPO_PATH, kind: "removed" });
    }
  }

  const clean =
    sharedChanges.length === 0 &&
    toolStatuses.every(
      (t) => t.files.length === 0 && t.manifest.length === 0,
    );

  const report: StatusReport = {
    repoPath: repoRoot,
    repoInitialized,
    sharedInstructions: sharing,
    includeSecrets: config.includeSecrets,
    tools: toolStatuses,
    shared: sharedChanges,
    clean,
  };

  if (opts.json) {
    // Machine-readable payload goes to STDOUT; keep it the ONLY thing on stdout.
    process.stdout.write(serialize(report));
    return;
  }

  printHuman(report);
}

/* -------------------------------------------------------------------------- */
/* Context construction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a CaptureContext for `status`. Inline (we don't own _context.ts): the
 * singleton sanitizer/templater + default fs/log + per-tool variables + the live
 * OS. dryRun is ALWAYS true here — status never writes and never hits npm.
 */
function buildCaptureContext(
  tool: ToolId,
  includeSecrets: boolean,
  includeMemories: boolean,
): CaptureContext {
  const toolHome = toolHomeDir(tool);
  return {
    fs,
    log,
    sanitizer,
    templater,
    vars: buildVariables(toolHome),
    os: detectOS(),
    env: process.env,
    toolHome,
    includeSecrets,
    includeMemories,
    dryRun: true,
  };
}

/* -------------------------------------------------------------------------- */
/* File diffing                                                                */
/* -------------------------------------------------------------------------- */

/** Diff captured files + symlinks against the committed working copy. */
async function diffFiles(
  repoRoot: string,
  files: CapturedFile[],
  symlinks: CapturedSymlink[],
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  for (const file of files) {
    const change = await classifyFile(repoRoot, file);
    if (change.kind !== "unchanged") changes.push(change);
  }

  for (const link of symlinks) {
    const change = await classifySymlink(repoRoot, link);
    if (change.kind !== "unchanged") changes.push(change);
  }

  return changes;
}

/**
 * Classify a single would-be file against the committed copy on disk.
 * Binary files are compared by raw bytes; text by exact string equality (the
 * captured content is already sanitized + templated, i.e. exactly what backup
 * would write, so a byte-for-byte match means "no change").
 */
async function classifyFile(
  repoRoot: string,
  file: CapturedFile,
): Promise<FileChange> {
  const abs = repoAbsPath(repoRoot, file.repoPath);
  const kind = await fs.statKind(abs);

  if (kind === "missing") {
    return { repoPath: file.repoPath, kind: "added" };
  }
  // A committed symlink where we now expect a regular file is a real change.
  if (kind === "symlink") {
    return { repoPath: file.repoPath, kind: "changed" };
  }

  try {
    if (file.binary) {
      const existing = await fs.readBytes(abs);
      const incoming = Buffer.from(file.content, "base64");
      const same = existing.length === incoming.length && existing.equals(incoming);
      return { repoPath: file.repoPath, kind: same ? "unchanged" : "changed" };
    }
    const existing = await fs.read(abs);
    return {
      repoPath: file.repoPath,
      kind: existing === file.content ? "unchanged" : "changed",
    };
  } catch {
    // Unreadable on disk but present -> treat as changed (it will be rewritten).
    return { repoPath: file.repoPath, kind: "changed" };
  }
}

/** Classify a would-be symlink against the committed entry. */
async function classifySymlink(
  repoRoot: string,
  link: CapturedSymlink,
): Promise<FileChange> {
  const abs = repoAbsPath(repoRoot, link.repoPath);
  const kind = await fs.statKind(abs);

  if (kind === "missing") {
    return { repoPath: link.repoPath, kind: "added", symlink: true };
  }
  if (kind !== "symlink") {
    // Committed as a real file/dir but we now expect a symlink -> changed.
    return { repoPath: link.repoPath, kind: "changed", symlink: true };
  }
  try {
    const target = await fs.readLink(abs);
    return {
      repoPath: link.repoPath,
      kind: target === link.target ? "unchanged" : "changed",
      symlink: true,
    };
  } catch {
    return { repoPath: link.repoPath, kind: "changed", symlink: true };
  }
}

/**
 * Find files committed under "<tool>/files/**" that the current capture no
 * longer produces — these would be deleted by the next backup. We compare the
 * committed file tree against the set of repo paths this tool just emitted.
 */
async function findRemovedToolFiles(
  repoRoot: string,
  tool: ToolId,
  expectedForTool: Set<string>,
): Promise<FileChange[]> {
  const prefix = `${tool}/files`;
  const baseAbs = repoAbsPath(repoRoot, prefix);
  const committed = await walkRepoFiles(baseAbs, prefix);

  const removed: FileChange[] = [];
  for (const entry of committed) {
    if (!expectedForTool.has(entry.repoPath)) {
      removed.push({
        repoPath: entry.repoPath,
        kind: "removed",
        symlink: entry.symlink || undefined,
      });
    }
  }
  return removed;
}

/** The repo paths (files + symlinks) a single tool's capture produced. */
function expectedRepoPathsForTool(
  files: CapturedFile[],
  symlinks: CapturedSymlink[],
): Set<string> {
  const set = new Set<string>();
  for (const f of files) set.add(f.repoPath);
  for (const s of symlinks) set.add(s.repoPath);
  return set;
}

/* -------------------------------------------------------------------------- */
/* Manifest diffing                                                            */
/* -------------------------------------------------------------------------- */

/** Diff a freshly-captured manifest against the committed manifest.json. */
async function diffManifest(
  repoRoot: string,
  tool: ToolId,
  local: ToolManifest,
): Promise<ManifestDrift[]> {
  const manifestPath = repoAbsPath(repoRoot, `${tool}/manifest.json`);
  let committed: ToolManifest | null = null;

  if (await fs.exists(manifestPath)) {
    try {
      committed = parseManifest(JSON.parse(await fs.read(manifestPath)));
    } catch {
      // Corrupt/old committed manifest: treat every local entry as "added".
      committed = null;
    }
  }

  const drifts: ManifestDrift[] = [];

  const pluginDrift = diffKeyed(
    "plugins",
    (committed?.plugins ?? []) as PluginEntry[],
    local.plugins,
    (p) => p.id,
    pluginSignature,
  );
  if (hasDrift(pluginDrift)) drifts.push(pluginDrift);

  const mpDrift = diffKeyed(
    "marketplaces",
    (committed?.marketplaces ?? []) as MarketplaceEntry[],
    local.marketplaces,
    (m) => m.id,
    marketplaceSignature,
  );
  if (hasDrift(mpDrift)) drifts.push(mpDrift);

  const skillDrift = diffKeyed(
    "skills",
    (committed?.skills ?? []) as SkillEntry[],
    local.skills,
    (s) => s.name,
    skillSignature,
  );
  if (hasDrift(skillDrift)) drifts.push(skillDrift);

  const npmDrift = diffKeyed(
    "npmGlobals",
    (committed?.npmGlobals ?? []) as NpmGlobalEntry[],
    local.npmGlobals,
    (n) => n.package,
    (n) => `${n.package}@${n.version ?? ""}`,
  );
  if (hasDrift(npmDrift)) drifts.push(npmDrift);

  const enabledDrift = diffEnabledPlugins(
    committed?.enabledPlugins ?? {},
    local.enabledPlugins,
  );
  if (hasDrift(enabledDrift)) drifts.push(enabledDrift);

  return drifts;
}

/**
 * Generic keyed diff: compare two lists by a stable key, reporting added /
 * removed (by key) and changed (same key, different signature).
 */
function diffKeyed<T>(
  category: ManifestDrift["category"],
  committed: T[],
  local: T[],
  keyOf: (item: T) => string,
  signatureOf: (item: T) => string,
): ManifestDrift {
  const committedMap = new Map<string, T>();
  for (const item of committed) committedMap.set(keyOf(item), item);
  const localMap = new Map<string, T>();
  for (const item of local) localMap.set(keyOf(item), item);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, item] of localMap) {
    const prev = committedMap.get(key);
    if (!prev) {
      added.push(key);
    } else if (signatureOf(prev) !== signatureOf(item)) {
      changed.push(key);
    }
  }
  for (const key of committedMap.keys()) {
    if (!localMap.has(key)) removed.push(key);
  }

  return {
    category,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

/** enabledPlugins is a Record<string, boolean>; diff key-by-key on the flag. */
function diffEnabledPlugins(
  committed: Record<string, boolean>,
  local: Record<string, boolean>,
): ManifestDrift {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, val] of Object.entries(local)) {
    if (!(key in committed)) added.push(key);
    else if (committed[key] !== val) changed.push(key);
  }
  for (const key of Object.keys(committed)) {
    if (!(key in local)) removed.push(key);
  }

  return {
    category: "enabledPlugins",
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

function hasDrift(d: ManifestDrift): boolean {
  return d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0;
}

/* ---- stable signatures used to detect "same key, different details" ------ */

function pluginSignature(p: PluginEntry): string {
  return [
    p.id,
    p.name,
    p.marketplace ?? "",
    p.version ?? "",
    String(p.enabled),
    p.scope,
    p.projectPath ?? "",
  ].join("");
}

function marketplaceSignature(m: MarketplaceEntry): string {
  return [m.id, m.sourceType, m.source].join("");
}

function skillSignature(s: SkillEntry): string {
  return [s.name, s.source, s.installCommand ?? "", String(s.symlinked)].join("");
}

/* -------------------------------------------------------------------------- */
/* Repo working-copy walking                                                   */
/* -------------------------------------------------------------------------- */

interface RepoFileEntry {
  /** Repo-relative POSIX path. */
  repoPath: string;
  symlink: boolean;
}

/**
 * Recursively list files (and symlinks) under an absolute base dir, returning
 * repo-relative POSIX paths. Skips the .git directory. Tolerant of absence.
 */
async function walkRepoFiles(
  baseAbs: string,
  basePosix: string,
): Promise<RepoFileEntry[]> {
  const out: RepoFileEntry[] = [];
  if (!(await fs.exists(baseAbs))) return out;

  const entries = await fs.list(baseAbs);
  for (const name of entries) {
    if (name === ".git") continue;
    const childAbs = path.join(baseAbs, name);
    const childPosix = `${basePosix}/${name}`;
    const kind = await fs.statKind(childAbs);
    if (kind === "symlink") {
      out.push({ repoPath: childPosix, symlink: true });
    } else if (kind === "dir") {
      out.push(...(await walkRepoFiles(childAbs, childPosix)));
    } else if (kind === "file") {
      out.push({ repoPath: childPosix, symlink: false });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Small filesystem helpers                                                    */
/* -------------------------------------------------------------------------- */

/** Map a repo-relative POSIX path to an absolute OS path under repoRoot. */
function repoAbsPath(repoRoot: string, repoPath: string): string {
  return path.join(repoRoot, ...repoPath.split("/"));
}

/** True if a committed file (regular file or symlink) exists at repoPath. */
async function committedFileExists(repoRoot: string, repoPath: string): Promise<boolean> {
  const kind = await fs.statKind(repoAbsPath(repoRoot, repoPath));
  return kind === "file" || kind === "symlink";
}

/** Read a file's text, or undefined if it does not exist / can't be read. */
async function readIfExists(absPath: string): Promise<string | undefined> {
  if (!(await fs.exists(absPath))) return undefined;
  try {
    return await fs.read(absPath);
  } catch {
    return undefined;
  }
}

/** True when the working copy already has committed content (not a fresh dir). */
async function isRepoInitialized(repoRoot: string): Promise<boolean> {
  if (!(await fs.exists(repoRoot))) return false;
  const entries = await fs.list(repoRoot);
  // Anything beyond an empty/.git-only directory means a prior backup exists.
  return entries.some((e) => e !== ".git");
}

/** Run an adapter detect() defensively; absence must never throw out of status. */
async function safeDetect(detect: () => Promise<boolean>): Promise<boolean> {
  try {
    return await detect();
  } catch {
    return false;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------------- */
/* Ordering + human rendering                                                  */
/* -------------------------------------------------------------------------- */

const KIND_ORDER: Record<FileChangeKind, number> = {
  added: 0,
  changed: 1,
  removed: 2,
  unchanged: 3,
};

/** Stable ordering: by kind (added, changed, removed), then by path. */
function sortChanges(changes: FileChange[]): FileChange[] {
  return [...changes].sort((a, b) => {
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k !== 0) return k;
    return a.repoPath.localeCompare(b.repoPath);
  });
}

const SIGIL: Record<FileChangeKind, string> = {
  added: "+",
  changed: "~",
  removed: "-",
  unchanged: " ",
};

/** Print a human-readable status table to STDERR (stdout stays data-clean). */
function printHuman(report: StatusReport): void {
  log.info(`Backup repo: ${report.repoPath}`);
  if (!report.repoInitialized) {
    log.warn(
      "Backup repo has no prior backup yet — everything below would be added by the first `arbella push`.",
    );
  }
  log.step(
    `Shared instructions (CLAUDE.md == AGENTS.md): ${report.sharedInstructions ? "yes" : "no"}`,
  );
  log.step(`Secrets in repo: ${report.includeSecrets ? "INCLUDED" : "excluded (default)"}`);

  if (report.clean) {
    log.success("Up to date — a backup right now would change nothing.");
  }

  // Repo-level shared file changes (e.g. shared/instructions.md).
  if (report.shared.length > 0) {
    log.info("Shared:");
    for (const c of report.shared) {
      log.step(renderChangeLine(c));
    }
  }

  for (const tool of report.tools) {
    const headerExtras: string[] = [];
    if (!tool.present) headerExtras.push("not present");
    const changedCount = tool.files.length;
    const driftCount = tool.manifest.length;
    if (tool.present && changedCount === 0 && driftCount === 0) {
      headerExtras.push("no changes");
    }
    const suffix = headerExtras.length ? ` (${headerExtras.join(", ")})` : "";
    log.info(`${tool.tool}${suffix}:`);

    for (const c of tool.files) {
      log.step(renderChangeLine(c));
    }

    for (const drift of tool.manifest) {
      const parts: string[] = [];
      if (drift.added.length) parts.push(`+${drift.added.length}`);
      if (drift.changed.length) parts.push(`~${drift.changed.length}`);
      if (drift.removed.length) parts.push(`-${drift.removed.length}`);
      log.step(`${drift.category}: ${parts.join(" ")}`);
      for (const id of drift.added) log.step(`  + ${id}`);
      for (const id of drift.changed) log.step(`  ~ ${id}`);
      for (const id of drift.removed) log.step(`  - ${id}`);
    }

    if (tool.secrets.length > 0) {
      log.step(
        `secrets ${report.includeSecrets ? "redacted" : "excluded"}: ${tool.secrets.length}`,
      );
      for (const s of tool.secrets) {
        log.step(`  ! ${s.source} — ${s.description}`);
      }
    }

    for (const w of tool.warnings) {
      log.warn(`  ${w}`);
    }
  }
}

function renderChangeLine(c: FileChange): string {
  const sigil = SIGIL[c.kind];
  const linkTag = c.symlink ? " (symlink)" : "";
  return `${sigil} ${c.repoPath}${linkTag}`;
}
