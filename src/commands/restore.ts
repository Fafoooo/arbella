/**
 * `arbella pull [repoUrl]` — rebuild this machine's AI dev setup from the
 * private repo (R6, R8, R9, R12, R14).
 *
 * High-level flow:
 *   1. Resolve the repo: the positional `[repoUrl]` arg wins; otherwise fall back
 *      to `config.repo`. Clone it if it is not already present locally, else pull
 *      so the working copy is fresh (R12).
 *   2. Parse `arbella.json` (ArbellaMeta) at the repo root.
 *   3. Decide the set of tools to restore: every tool captured in the repo, unless
 *      the user explicitly narrows it with `--tools`.
 *   4. For each tool, load its RestoreData (frozen files + symlinks reconstructed
 *      from <repoRoot>/<tool>/files, manifest via parseManifest) and build the
 *      adapter's planned actions. Probe which CLIs are missing (R6).
 *   5. If `--dry-run`: print the full RestorePlan and STOP (no mutations).
 *   6. Otherwise — R14 SAFETY BACKUP FIRST: copy every existing target tool home
 *      (~/.claude, ~/.codex, ~/.cursor) to a timestamped dir under dataDir()
 *      BEFORE anything is overwritten. Then auto-install any missing CLIs (R6),
 *      and run each adapter's restore() (which places files, recreates symlinks,
 *      reinstalls plugins/marketplaces/skills, re-enables plugins, installs npm
 *      globals — all guarded + best-effort per adapter).
 *   6b. Install the external tools behind the restored MCP/hook commands (WP-C):
 *      the brew/uv/pipx binaries npm globals do not cover. Best-effort; anything
 *      already on PATH is skipped and anything unattributable is reported in the
 *      post-restore reminder instead.
 *   6c. Write the cross-tool `shared/home` files back into $HOME (WP-B): the hook
 *      dispatchers, statusline scripts, MCP launchers, plugin companion configs
 *      and `extraPaths` entries that live outside every tool home. Each overwrite
 *      gets its own safety copy first, and nothing is ever written outside $HOME.
 *   7. Deploy the shared instructions (R9) to Claude + Codex when meta.sharedInstructions
 *      is set: write shared/instructions.md to each sharedInstructionsTargets()
 *      destination.
 *   8. Print a re-auth reminder: secret files (.credentials.json / auth.json) were
 *      NEVER carried, so the user must re-login. Never prints any secret value.
 *
 * SECURITY: this command never reads, prints, copies, or restores secret files —
 * those are excluded by the denylist at capture time and are simply absent from
 * the repo. The only secret-adjacent output is the human re-login reminder.
 *
 * CROSS-OS: every path is resolved via src/platform/os.ts + node:path.join; the
 * templater rehydrates {{HOME}}/{{USER}}/{{TOOL_HOME}} placeholders to THIS
 * machine's values inside each adapter. No machine path is ever hardcoded.
 *
 * The command is thin: it owns flag parsing + the clock
 * (timestamps are passed inward), assembles CoreServices/RestoreContext, and
 * delegates the real work to the adapters + core modules.
 */

import path from "node:path";
import process from "node:process";

import type { Command } from "commander";

import type {
  CapturedFile,
  CapturedSymlink,
  Logger,
  OS,
  RestoreAction,
  RestorePlan,
  ArbellaMeta,
  ToolId,
  ToolManifest,
} from "../types.js";
import { TOOL_IDS } from "../types.js";
import type {
  Adapter,
  CoreServices,
  RestoreContext,
  RestoreData,
} from "../adapters/adapter.interface.js";

import { fs } from "../utils/fs.js";
import { log } from "../utils/log.js";
import { decodeForCapture } from "../utils/capture-bytes.js";
import { resolveContainedTarget } from "../utils/safe-path.js";
import {
  cliBinaryName,
  dataDir,
  detectOS,
  toolHomeDir,
} from "../platform/os.js";
import {
  ensureCli,
  which,
  npmInstallGlobal,
  isForeignPlatformPackage,
  externalToolInstallCommand,
  installExternalTool,
} from "../platform/install.js";
import type { ExternalToolRef } from "../core/externaltools/classify.js";
import { mergeExternalTools } from "../core/externaltools/classify.js";
import { commandBaseName } from "../core/externaltools/collect.js";
import { createSanitizer } from "../core/sanitizer/index.js";
import { createTemplater } from "../core/templater/index.js";
import { buildVariables } from "../core/templater/variables.js";
import { loadConfigOrDefault } from "../core/config/index.js";
import type { RepoConfig } from "../core/config/schema.js";
import { ensureLocalClone, pullWithAuth } from "../core/repo/index.js";
import type { RepoAuthHooks } from "../core/repo/index.js";
import { buildRepoAuthHooks } from "./_context.js";
import { ensureDeps } from "./setup.js";
import * as git from "../core/repo/git.js";
import {
  parseManifest,
  parseMeta,
  emptyManifest,
  sharedInstructionsTargets,
  SHARED_INSTRUCTIONS_REPO_PATH,
} from "../core/manifest/index.js";
import { SHARED_HOME_REPO_PREFIX } from "../core/homefiles/capture.js";
import type { HomeRestoreServices } from "../core/homefiles/restore.js";
import { planHomeFileActions, restoreHomeFiles } from "../core/homefiles/restore.js";

import { claudeAdapter } from "../adapters/claude/index.js";
import { codexAdapter } from "../adapters/codex/index.js";
import { cursorAdapter, planActions as cursorPlanActions } from "../adapters/cursor/index.js";
import { cursorUserPaths } from "../adapters/cursor/paths.js";
import { opencodeAdapter } from "../adapters/opencode/index.js";
import { copilotAdapter } from "../adapters/copilot/index.js";
import { kiloAdapter } from "../adapters/kilo/index.js";
import {
  antigravityAdapter,
  planActions as antigravityPlanActions,
} from "../adapters/antigravity/index.js";
import {
  GEMINI_FROZEN_PATHS,
  antigravityHomeCandidates,
  antigravityUserDirCandidates,
  geminiDir,
} from "../adapters/antigravity/paths.js";
import { planActions as claudePlanActions } from "../adapters/claude/restore.js";
import { planMcpMerge } from "../adapters/claude/mcp.js";
import { planActions as codexPlanActions } from "../adapters/codex/restore.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** CLI options for `arbella pull` (commander fills these from flags). */
export interface RestoreOptions {
  /** Plan + report only; perform no filesystem or install actions (R14). */
  dryRun?: boolean;
  /** Override the repo URL (otherwise the positional arg, then config.repo). */
  repo?: string;
  /** Comma-separated tool subset to restore (intersected with the repo's tools). */
  tools?: string;
  /** Restore even when the local machine is configured as source of truth (R12). */
  force?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Adapter wiring                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Per-tool adapter + its (optional) standalone planActions exporter. The Adapter
 * interface itself only exposes restore(); planActions lives as a sibling module
 * export for the adapters that need tool-specific path mapping.
 */
interface ToolWiring {
  readonly id: ToolId;
  readonly adapter: Adapter;
  /** Compute the action list without executing, when the tool provides one. */
  readonly planActions?: (
    ctx: RestoreContext,
    data: RestoreData,
  ) => Promise<RestoreAction[]>;
}

const WIRING: readonly ToolWiring[] = [
  { id: "claude", adapter: claudeAdapter, planActions: claudePlanActions },
  { id: "codex", adapter: codexAdapter, planActions: codexPlanActions },
  { id: "cursor", adapter: cursorAdapter, planActions: cursorPlanActions },
  // opencode/copilot/kilo are single-root (<tool>/files) config-dir tools, so the
  // command's generic fallbackActions planner covers them — no bespoke planActions.
  { id: "opencode", adapter: opencodeAdapter },
  { id: "copilot", adapter: copilotAdapter },
  { id: "kilo", adapter: kiloAdapter },
  // Antigravity is multi-root (antigravity/files, /user, /gemini), so it ships its
  // own planActions like Cursor — the generic single-root fallback can't map it.
  { id: "antigravity", adapter: antigravityAdapter, planActions: antigravityPlanActions },
];

/** Look up the wiring for a tool id (every ToolId has an entry). */
function wiringFor(id: ToolId): ToolWiring {
  const w = WIRING.find((entry) => entry.id === id);
  if (!w) throw new Error(`No restore wiring for tool "${id}".`);
  return w;
}

/* -------------------------------------------------------------------------- */
/* Service / context assembly                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the injected CoreServices for a given tool home on the TARGET machine.
 * Built inline (this command does not own init.ts, which owns _context.ts):
 * default fs/log singletons, sanitizer/templater factories, live machine vars
 * (so {{TOOL_HOME}} expands to the correct child of {{HOME}}), and detectOS().
 */
function buildCoreServices(toolHome: string, os: OS): CoreServices {
  return {
    fs,
    log,
    sanitizer: createSanitizer(),
    templater: createTemplater(),
    vars: buildVariables(toolHome),
    os,
    env: process.env,
  };
}

/** Assemble the RestoreContext an adapter consumes for one tool. */
function buildRestoreContext(args: {
  toolId: ToolId;
  repoRoot: string;
  sourceOfTruth: "local" | "repo";
  dryRun: boolean;
  os: OS;
}): RestoreContext {
  const toolHome = toolHomeDir(args.toolId);
  const repoToolDir = path.join(args.repoRoot, args.toolId);
  return {
    ...buildCoreServices(toolHome, args.os),
    toolHome,
    repoToolDir,
    repoRoot: args.repoRoot,
    sourceOfTruth: args.sourceOfTruth,
    dryRun: args.dryRun,
  };
}

/**
 * Services for the SYSTEM-level shared/home step. Built with no tool home, so
 * `{{HOME}}`/`{{USER}}` expand and no `{{TOOL_HOME}}` is defined — matching how
 * those files were templated on capture (see core/homefiles/capture.ts).
 */
function buildHomeRestoreServices(args: {
  sourceOfTruth: "local" | "repo";
  dryRun: boolean;
  os: OS;
}): HomeRestoreServices {
  return {
    ...buildCoreServices("", args.os),
    sourceOfTruth: args.sourceOfTruth,
    dryRun: args.dryRun,
  };
}

/* -------------------------------------------------------------------------- */
/* Repo reading: reconstruct RestoreData from <repoRoot>/<tool>/files          */
/* -------------------------------------------------------------------------- */

/**
 * Recursively walk frozen roots inside the cloned repo and reconstruct the
 * CapturedFile[] / CapturedSymlink[] the adapter expects. `repoPath` is rebuilt
 * with the root's canonical prefix (POSIX separators), e.g. "claude/files/..."
 * or "cursor/user/...".
 *
 * Symlinks captured under skills/ are preserved verbatim (their target is the
 * data). Regular files are classified binary vs. text on read. Missing dirs are
 * tolerated (graceful absence) and simply yield nothing.
 */
async function readToolFrozen(
  repoToolDir: string,
  tool: ToolId,
): Promise<{ files: CapturedFile[]; symlinks: CapturedSymlink[] }> {
  return readRepoRoots(frozenRootsForTool(repoToolDir, tool));
}

/** One frozen root inside the cloned repo: where it is, and how it is addressed. */
interface RepoRoot {
  absRoot: string;
  repoPrefix: string;
}

/**
 * Read a set of repo roots into CapturedFile[]/CapturedSymlink[]. Shared by the
 * per-tool frozen roots and by the cross-tool `shared/home` root so both use one
 * walker (identical ordering, binary classification and mode handling). Absent
 * roots are skipped.
 */
async function readRepoRoots(
  roots: readonly RepoRoot[],
): Promise<{ files: CapturedFile[]; symlinks: CapturedSymlink[] }> {
  const files: CapturedFile[] = [];
  const symlinks: CapturedSymlink[] = [];

  /** relParts: POSIX path segments under the frozen root accumulated so far. */
  async function walk(absDir: string, relParts: string[], repoPrefix: string): Promise<void> {
    const entries = await fs.list(absDir);
    // Stable order so dry-run output and writes are deterministic.
    entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const name of entries) {
      const abs = path.join(absDir, name);
      const nextRel = [...relParts, name];
      const relPosix = nextRel.join("/");
      const repoPath = `${repoPrefix}/${relPosix}`;
      const kind = await fs.statKind(abs);

      if (kind === "symlink") {
        let target: string;
        try {
          target = await fs.readLink(abs);
        } catch (err) {
          log.warn(
            `restore: could not read symlink ${repoPath}: ${errMsg(err)}`,
          );
          continue;
        }
        symlinks.push({ repoPath, target });
        continue;
      }

      if (kind === "dir") {
        await walk(abs, nextRel, repoPrefix);
        continue;
      }

      if (kind !== "file") continue;

      let bytes: Buffer;
      try {
        bytes = await fs.readBytes(abs);
      } catch (err) {
        log.warn(`restore: could not read ${repoPath}: ${errMsg(err)}`);
        continue;
      }

      // Preserve the executable bit (hooks/statusline scripts) where the host FS
      // exposes it; harmless on Windows. Captured as the POSIX mode.
      const mode = await fileMode(abs);

      // The SAME classifier capture used (src/utils/capture-bytes.ts), so a pull
      // reads a repo file back exactly as the push wrote it. A NUL-only
      // heuristic disagrees with it on two shapes that really occur: a small
      // NUL-free binary (a favicon, a tiny PNG under `extraPaths`) would be read
      // as "text" and rewritten as mangled UTF-8, and a UTF-16 config would be
      // stored as opaque base64 instead of rehydrated text.
      const decoded = decodeForCapture(bytes);
      if (decoded.kind === "binary") {
        files.push({
          repoPath,
          content: bytes.toString("base64"),
          binary: true,
          ...(mode !== undefined ? { mode } : {}),
        });
      } else {
        files.push({
          repoPath,
          content: decoded.text,
          ...(mode !== undefined ? { mode } : {}),
        });
      }
    }
  }

  for (const root of roots) {
    if ((await fs.statKind(root.absRoot)) !== "dir") continue;
    await walk(root.absRoot, [], root.repoPrefix);
  }
  return { files, symlinks };
}

/**
 * Read the CROSS-TOOL `shared/home` root: the files that live in $HOME outside
 * every tool home (linked hook/statusline/MCP scripts, plugin companion configs,
 * `extraPaths`). Restored by the system-level step, not by any adapter.
 *
 * Symlinks are never captured into shared/home, so any that turn up in the repo
 * are ignored with a debug line rather than recreated blind.
 */
export async function loadHomeFiles(repoRoot: string): Promise<CapturedFile[]> {
  const absRoot = path.join(repoRoot, ...SHARED_HOME_REPO_PREFIX.split("/"));
  const { files, symlinks } = await readRepoRoots([
    { absRoot, repoPrefix: SHARED_HOME_REPO_PREFIX },
  ]);
  for (const link of symlinks) {
    log.debug(`restore: ignoring unexpected symlink ${link.repoPath} in shared/home`);
  }
  return files;
}

function frozenRootsForTool(
  repoToolDir: string,
  tool: ToolId,
): Array<{ absRoot: string; repoPrefix: string }> {
  const roots = [
    { absRoot: path.join(repoToolDir, "files"), repoPrefix: `${tool}/files` },
  ];
  if (tool === "claude") {
    // Per-project memories live in their own repo root (their destination is
    // ~/.claude/projects/<slug>/memory, which the "files" root cannot express).
    roots.push({ absRoot: path.join(repoToolDir, "memories"), repoPrefix: "claude/memories" });
  }
  if (tool === "cursor") {
    roots.push({ absRoot: path.join(repoToolDir, "user"), repoPrefix: "cursor/user" });
  }
  if (tool === "antigravity") {
    // Antigravity's VS Code User dir and shared ~/.gemini agent dir are stored as
    // sibling roots alongside the ~/.antigravity "files" root.
    roots.push({ absRoot: path.join(repoToolDir, "user"), repoPrefix: "antigravity/user" });
    roots.push({ absRoot: path.join(repoToolDir, "gemini"), repoPrefix: "antigravity/gemini" });
  }
  return roots;
}

/**
 * Read a tool's manifest.json from <repoRoot>/<tool>/manifest.json and validate
 * it. A missing manifest is tolerated (returns an empty manifest) so a tool that
 * only has frozen files can still be restored. A PRESENT-but-corrupt manifest
 * throws (via parseManifest) so the user gets a clear error rather than silent
 * data loss.
 */
async function readToolManifest(
  repoToolDir: string,
  tool: ToolId,
): Promise<ToolManifest> {
  const manifestPath = path.join(repoToolDir, "manifest.json");
  if (!(await fs.exists(manifestPath))) {
    log.debug(`restore: no manifest.json for ${tool}; using empty manifest.`);
    return emptyManifest(tool);
  }
  const raw = await fs.read(manifestPath);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Backup repo manifest for ${tool} is not valid JSON ` +
        `(${manifestPath}): ${errMsg(err)}`,
    );
  }
  return parseManifest(json, (name) => {
    // The manifest is repo data, and this name would have become an argv element
    // of `brew install <name>`. The schema already dropped it; say so, because a
    // silent drop looks identical to a tool that simply was not captured.
    log.warn(
      `restore: ignored external tool with unsafe name in ${tool}/manifest.json: ` +
        `${JSON.stringify(name)}`,
    );
  });
}

/** Assemble the full RestoreData (manifest + frozen files/symlinks) for a tool. */
export async function loadRestoreData(
  repoRoot: string,
  tool: ToolId,
): Promise<RestoreData> {
  const repoToolDir = path.join(repoRoot, tool);
  const manifest = await readToolManifest(repoToolDir, tool);
  const { files, symlinks } = await readToolFrozen(repoToolDir, tool);
  return { manifest, files, symlinks };
}

/* -------------------------------------------------------------------------- */
/* Tool selection                                                              */
/* -------------------------------------------------------------------------- */

/** Parse a comma-separated `--tools` value into validated ToolIds (ignores junk). */
function parseToolsFlag(raw: string | undefined): ToolId[] | undefined {
  if (raw === undefined) return undefined;
  const wanted = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const ids = wanted.filter((t): t is ToolId =>
    (TOOL_IDS as readonly string[]).includes(t),
  );
  return ids;
}

/**
 * Decide which tools to restore. Always constrained to what the repo actually
 * captured (`meta.tools`). `--tools` is the only narrowing mechanism: a stale
 * local config on a fresh/old machine must not silently skip tools that are
 * present in the backup repo. Order follows the canonical TOOL_IDS order for
 * deterministic output.
 */
export function selectToolsForRestore(
  meta: ArbellaMeta,
  flagTools: ToolId[] | undefined,
  _configTools: ToolId[],
): ToolId[] {
  const captured = new Set<ToolId>(meta.tools);

  let candidate: Set<ToolId>;
  if (flagTools && flagTools.length > 0) {
    candidate = new Set(flagTools);
  } else {
    candidate = new Set(captured);
  }

  return TOOL_IDS.filter((id) => captured.has(id) && candidate.has(id));
}

/* -------------------------------------------------------------------------- */
/* R14 — pre-restore safety backup                                             */
/* -------------------------------------------------------------------------- */

/** One recorded safety-backup copy: which tool, and where it was copied to. */
interface SafetyBackup {
  tool: ToolId;
  source: string;
  dest: string;
}

/**
 * Make a timestamped safety copy of each existing restore target BEFORE any
 * restore mutation (R14). Destinations live under dataDir()/safety-backups so
 * they never pollute a tool home. Only existing homes are copied; absent ones
 * are skipped. `iso` is supplied by the caller (commands own the clock).
 *
 * Filesystem-safe timestamp: ISO ":"/"." are replaced with "-".
 */
async function safetyBackup(
  tools: ToolId[],
  iso: string,
  os: OS,
): Promise<SafetyBackup[]> {
  const stamp = iso.replace(/[:.]/g, "-");
  const made: SafetyBackup[] = [];

  for (const tool of tools) {
    for (const entry of safetySourcesForTool(tool, os, stamp)) {
      if (!(await fs.exists(entry.source))) {
        log.debug(`restore: no existing ${entry.label} to back up (${entry.source}).`);
        continue;
      }
      try {
        await fs.copy(entry.source, entry.dest);
        made.push({ tool, source: entry.source, dest: entry.dest });
        log.step(`Safety backup: ${entry.source} -> ${entry.dest}`);
      } catch (err) {
        // A failed safety copy is serious: warn loudly but do not abort the whole
        // restore over a single target's snapshot (the others still get protected).
        log.warn(
          `restore: failed to safety-backup ${entry.label} (${entry.source}): ${errMsg(err)}`,
        );
      }
    }
  }
  return made;
}

/**
 * Every local path a tool's restore can WRITE, so the R14 safety backup snapshots
 * each one before a real pull. Multi-root adapters MUST be listed here — a
 * missing root means a repo-wins restore can overwrite it with no local snapshot
 * to fall back to. Exported for the wiring regression test.
 */
export function safetySourcesForTool(
  tool: ToolId,
  os: OS,
  stamp: string,
): Array<{ label: string; source: string; dest: string }> {
  const backupsRoot = path.join(dataDir(), "safety-backups");
  const toolHome = toolHomeDir(tool);
  const sources = [
    {
      label: `${tool} home`,
      source: toolHome,
      dest: path.join(backupsRoot, `${tool}-${stamp}`),
    },
  ];

  if (tool === "claude") {
    // The MCP merge (adapters/claude/mcp.ts) writes ~/.claude.json, which is a
    // SIBLING of the tool home and therefore not covered by the home snapshot
    // above. It holds the user's auth + project history, so a pre-restore copy is
    // mandatory even though the merge only ever rewrites the mcpServers keys.
    sources.push({
      label: "claude global state (~/.claude.json)",
      source: path.join(path.dirname(toolHome), ".claude.json"),
      dest: path.join(backupsRoot, `claude-global-state-${stamp}.json`),
    });
  }

  if (tool === "cursor") {
    sources.push({
      label: "cursor User data",
      source: cursorUserPaths(toolHome, os, process.env).userDir,
      dest: path.join(backupsRoot, `cursor-user-${stamp}`),
    });
  }

  if (tool === "antigravity") {
    // The 2.0 update split Antigravity's dirs on some platforms (classic
    // "Antigravity" + ~/.antigravity vs "Antigravity IDE" + ~/.antigravity-ide),
    // and restore probes both — so snapshot every candidate that exists (missing
    // ones are skipped by the exists() check above). toolHome itself is already
    // sources[0]; add the IDE-variant dotfolder alongside it.
    for (const source of antigravityHomeCandidates(toolHome)) {
      if (source === toolHome) continue;
      sources.push({
        label: `antigravity home (${path.basename(source)})`,
        source,
        dest: path.join(backupsRoot, `antigravity-ide-${stamp}`),
      });
    }
    for (const source of antigravityUserDirCandidates(toolHome, os, process.env)) {
      const appName = path.basename(path.dirname(source));
      const slug = appName.toLowerCase().replace(/\s+/g, "-");
      sources.push({
        label: `antigravity User data (${appName})`,
        source,
        dest: path.join(backupsRoot, `${slug}-user-${stamp}`),
      });
    }
    // ~/.gemini is SHARED with the Gemini CLI and holds large machine-local state
    // (browser profile, session protobufs) plus live OAuth files. Snapshot ONLY
    // the paths a restore can overwrite — never the whole dir.
    const gemini = geminiDir(toolHome);
    for (const rel of GEMINI_FROZEN_PATHS) {
      sources.push({
        label: `antigravity gemini ${rel}`,
        source: path.join(gemini, ...rel.split("/")),
        dest: path.join(backupsRoot, `antigravity-gemini-${stamp}`, ...rel.split("/")),
      });
    }
  }

  return sources;
}

/* -------------------------------------------------------------------------- */
/* Shared instructions (R9) deployment                                         */
/* -------------------------------------------------------------------------- */

/**
 * When the repo stored a single shared instructions file (CLAUDE.md == AGENTS.md
 * at capture, R9), deploy it to BOTH tool targets: ~/.claude/CLAUDE.md and
 * ~/.codex/AGENTS.md (from sharedInstructionsTargets()). Cursor User Rules are
 * stored in Cursor settings, not as global `.mdc` files, so restore does not
 * synthesize a Cursor rule here.
 *
 * Respects `dryRun` (reports only). Best-effort + graceful: a missing shared
 * file is logged, not fatal. Only deploys to a target whose tool is in scope.
 *
 * Three guards, all applied BEFORE the dry-run branch so `--dry-run` cannot
 * promise a write this pass will not make:
 *   - the destination goes through the shared containment gate (a symlinked
 *     component below the tool home refuses the write instead of following it
 *     out of the tree), and lands via the rename-based writer so a link at the
 *     leaf is replaced rather than followed;
 *   - `sourceOfTruth: "local"` keeps an instructions file that is already here,
 *     exactly as every other restore write does. Without it the R9 step was the
 *     one place a "local wins" pull still overwrote the user's own CLAUDE.md.
 *   - a repo that also carries the tool's OWN `<tool>/files/<relPath>` (e.g.
 *     `claude/files/CLAUDE.md`) skips the shared copy for that target: R9 only
 *     stores the shared file when BOTH producers share it, so a per-tool copy
 *     sitting next to it means some later push ran with one producer missing
 *     and captured its own fresh instructions instead of updating the shared
 *     one (see `decideSharedInstructionsUpdate`) — that per-tool copy is by
 *     construction newer than the kept shared text.
 */
export async function deploySharedInstructions(
  repoRoot: string,
  toolsInScope: ToolId[],
  dryRun: boolean,
  sourceOfTruth: "local" | "repo",
  l: Logger = log,
): Promise<void> {
  const sharedAbs = path.join(
    repoRoot,
    ...SHARED_INSTRUCTIONS_REPO_PATH.split("/"),
  );
  if (!(await fs.exists(sharedAbs))) {
    l.warn(
      "restore: meta.sharedInstructions is set but " +
        `${SHARED_INSTRUCTIONS_REPO_PATH} is missing from the repo; skipping ` +
        "shared-instructions deployment.",
    );
    return;
  }

  const inScope = new Set(toolsInScope);
  const content = await fs.read(sharedAbs);

  for (const target of sharedInstructionsTargets()) {
    if (!inScope.has(target.tool)) continue;
    const toolHome = toolHomeDir(target.tool);
    const resolved = await resolveContainedTarget(fs, toolHome, target.relPath);
    if (!resolved.ok) {
      l.warn(
        `restore: refusing to deploy shared instructions into ${toolHome}: ${resolved.reason}`,
      );
      continue;
    }
    const dest = resolved.path;
    if (sourceOfTruth === "local" && (await fs.exists(dest))) {
      l.debug(`restore: keep local ${dest} (sourceOfTruth=local)`);
      continue;
    }
    // A tool that captured its OWN instructions file this push (R9 was not
    // sharing on that machine) is by construction NEWER than a kept shared file:
    // a sharing push removes the per-tool copies, so one being present at all
    // means some later, non-sharing push wrote it. Prefer it over the older
    // shared text rather than overwriting a fresher file with a stale one.
    const ownRepoPath = path.join(repoRoot, target.tool, "files", ...target.relPath.split("/"));
    if (await fs.exists(ownRepoPath)) {
      l.debug(
        `restore: skip shared instructions for ${target.tool} — repo has its own ` +
          `${ownRepoPath}, which is deployed by ${target.tool}'s own restore instead.`,
      );
      continue;
    }
    if (dryRun) {
      l.step(`Would deploy shared instructions -> ${dest}`);
      continue;
    }
    try {
      await fs.writeAtomic(dest, content);
      l.step(`Deployed shared instructions -> ${dest}`);
    } catch (err) {
      l.warn(
        `restore: failed to deploy shared instructions to ${dest}: ${errMsg(err)}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Shared npm-globals install pass (R8)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Collect the UNION of npm global packages across every restored tool's manifest,
 * deduped by package name, in deterministic order.
 *
 * Both adapters capture the same full machine list (listNpmGlobals), so without
 * dedup a multi-tool restore would `npm i -g` the same package once per tool. This
 * is the single source of truth the command uses to both PLAN (system-level
 * install-npm-global actions) and EXECUTE the installs, guaranteeing the dry-run
 * matches reality and each package is installed exactly once — and, critically,
 * that a codex-only restore still installs them (the gap this fixes).
 */
function dedupeNpmGlobals(prepared: PreparedTool[]): string[] {
  const seen = new Set<string>();
  for (const tool of prepared) {
    for (const g of tool.data.manifest.npmGlobals) {
      if (!g.package) continue;
      // Never reinstall arbella itself, and skip platform-specific native builds
      // that only install on their own OS (e.g. *-darwin-arm64 on Linux).
      if (g.package === "arbella" || isForeignPlatformPackage(g.package)) continue;
      seen.add(g.package);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Build the system-level install-npm-global plan actions (one per package). */
function npmGlobalActions(packages: string[]): RestoreAction[] {
  return packages.map((pkg) => ({
    type: "install-npm-global" as const,
    tool: "system" as const,
    description: `npm install -g ${pkg}`,
  }));
}

/**
 * Install the deduped npm globals once each (best-effort). A missing npm or a
 * single failed package is downgraded to a warning so the rest of the restore is
 * never stranded — npm globals are convenience, not correctness. No-op (with a
 * debug line) when there is nothing to install.
 */
async function installSharedNpmGlobals(packages: string[]): Promise<void> {
  if (packages.length === 0) {
    log.debug("restore: no npm globals to install.");
    return;
  }
  log.info(`Installing ${packages.length} npm global(s): ${packages.join(", ")}`);
  for (const pkg of packages) {
    try {
      await npmInstallGlobal(pkg);
      log.step(`npm i -g ${pkg}`);
    } catch (err) {
      log.warn(`restore: npm i -g ${pkg} failed (continuing): ${errMsg(err)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Shared external-tools install pass (WP-C)                                    */
/* -------------------------------------------------------------------------- */

/**
 * The UNION of every restored tool's `externalTools`, deduped by `manager:name`
 * with `usedBy` merged — the same shape (and the same reason) as the npm-globals
 * pass above: Claude and Codex routinely reference the SAME binary, and
 * installing it once per tool would be pure noise.
 */
export function dedupeExternalTools(prepared: readonly PreparedTool[]): ExternalToolRef[] {
  return mergeExternalTools(prepared.map((tool) => tool.data.manifest.externalTools));
}

/**
 * The one-line label for an external tool: the exact install command when we
 * know its manager, otherwise the manual-install phrasing. Used for BOTH the
 * dry-run plan and the success log, so the two can never drift.
 */
function externalToolLabel(tool: ExternalToolRef): string {
  const cmd = externalToolInstallCommand(tool);
  const usedBy = tool.usedBy.length > 0 ? ` (${tool.usedBy.join(", ")})` : "";
  return cmd !== null
    ? `${cmd.cmd} ${cmd.args.join(" ")}${usedBy}`
    : `install ${tool.name} manually${usedBy}`;
}

/**
 * True when this machine ALREADY has the tool's binary on PATH, whichever
 * manager put it there — the single skip decision the plan and the install pass
 * both consult, so `--dry-run` cannot advertise an install the pass then skips.
 *
 * Probed by the BINARY behind the command, not the package name: `serena-agent`
 * ships `serena`.
 */
export async function externalToolOnPath(
  tool: ExternalToolRef,
  whichFn: (bin: string) => Promise<boolean>,
): Promise<boolean> {
  const binary = commandBaseName(tool.command);
  return binary !== "" && (await whichFn(binary));
}

/**
 * Build the system-level install-external-tool plan actions, one per tool that
 * is NOT already on this machine's PATH.
 */
export async function externalToolActions(
  tools: readonly ExternalToolRef[],
  opts: Pick<ExternalToolPassOptions, "which"> = {},
): Promise<RestoreAction[]> {
  const whichFn = opts.which ?? which;
  const actions: RestoreAction[] = [];
  for (const tool of tools) {
    if (await externalToolOnPath(tool, whichFn)) continue;
    actions.push({
      type: "install-external-tool" as const,
      tool: "system" as const,
      description: externalToolLabel(tool),
    });
  }
  return actions;
}

/** Injectable collaborators for {@link installSharedExternalTools} (tests only). */
export interface ExternalToolPassOptions {
  /** PATH probe for the BINARY (not the package). Default: {@link which}. */
  which?: (bin: string) => Promise<boolean>;
  /** Runs one install. Default: {@link installExternalTool}. */
  install?: (
    ref: ExternalToolRef,
  ) => Promise<"installed" | "skipped-manager-missing" | "unsupported" | "rejected-name">;
}

/**
 * Install the deduped external tools (WP-C), best-effort, and return the ones
 * the user still has to install by hand.
 *
 * A tool whose BINARY already resolves on PATH is skipped outright (a debug
 * line) — the machine already has it, whichever manager put it there. Everything
 * else is handed to `installExternalTool`, whose three outcomes map to:
 *   - `installed`               -> done, one step line;
 *   - `skipped-manager-missing` -> the manager itself (brew/uv/pipx) is absent;
 *   - `unsupported`             -> arbella never knew which manager owns it.
 * The last two, and any thrown install failure, are downgraded to a warning and
 * collected for the post-restore reminder: external tools are convenience, and
 * one missing binary must never strand the rest of a restore.
 */
export async function installSharedExternalTools(
  tools: readonly ExternalToolRef[],
  opts: ExternalToolPassOptions = {},
  l: Logger = log,
): Promise<ExternalToolRef[]> {
  const manual: ExternalToolRef[] = [];
  if (tools.length === 0) {
    l.debug("restore: no external tools to install.");
    return manual;
  }

  const whichFn = opts.which ?? which;
  const installFn = opts.install ?? ((ref) => installExternalTool(ref));

  l.info(`Checking ${tools.length} external tool(s) behind MCP/hook commands…`);
  for (const tool of tools) {
    if (await externalToolOnPath(tool, whichFn)) {
      l.debug(
        `restore: ${commandBaseName(tool.command)} is already on PATH; skipping ${tool.name}`,
      );
      continue;
    }
    try {
      const outcome = await installFn(tool);
      if (outcome === "installed") {
        l.step(externalToolLabel(tool));
        continue;
      }
      if (outcome === "rejected-name") {
        // Second-line refusal (the manifest schema drops these on parse). NOT
        // added to `manual`: the reminder tells the user what to install, and
        // arbella will not put an attacker-chosen name in that sentence.
        l.warn(
          `restore: ignored external tool with unsafe name: ${JSON.stringify(tool.name)}`,
        );
        continue;
      }
      l.warn(
        outcome === "unsupported"
          ? `restore: no known install command for ${tool.name} (unrecognized package manager)`
          : `restore: ${tool.manager} is not installed on this machine; cannot install ${tool.name}`,
      );
    } catch (err) {
      l.warn(`restore: could not install ${tool.name} (continuing): ${errMsg(err)}`);
    }
    manual.push(tool);
  }
  return manual;
}

/**
 * The `<server>, <KEY>` pairs the user must re-supply after this restore.
 *
 * Taken from the MCP merge plan built during `buildPlan` — i.e. from the servers
 * that will actually be REGISTERED. A server whose local definition wins keeps
 * its real values, so naming its keys here would send the user chasing a
 * `needs env` warning the adapter never printed.
 */
function mcpNeedsEnv(
  prepared: readonly PreparedTool[],
): Array<{ name: string; key: string }> {
  return prepared.flatMap((tool) => tool.needsEnv);
}

/**
 * Claude project-scope MCP directories skipped because they do not exist on
 * this machine (Claude only; empty for every other tool). Taken from the same
 * MCP merge plan `mcpNeedsEnv` reads, so the warning below can only ever name
 * directories the merge really skipped.
 */
function mcpSkippedProjectDirs(prepared: readonly PreparedTool[]): string[] {
  return prepared.flatMap((tool) => tool.skippedProjectDirs);
}

/**
 * The one-line warning for `mcpSkippedProjectDirs` — shared by the dry-run plan
 * (`printPlan`) and the post-restore reminder (`printReauthReminder`) so the
 * message can never drift between the two.
 */
function skippedProjectDirsWarning(dirs: readonly string[]): string {
  return (
    "claude: skipped MCP servers for project(s) not found on this machine: " +
    `${dirs.join(", ")}. Clone the project(s) here and run \`arbella pull\` ` +
    "again to register their MCP servers."
  );
}

/* -------------------------------------------------------------------------- */
/* Plan building + printing                                                    */
/* -------------------------------------------------------------------------- */

/** Per-tool prepared data + context + planned actions, computed once up front. */
interface PreparedTool {
  id: ToolId;
  adapter: Adapter;
  data: RestoreData;
  actions: RestoreAction[];
  /**
   * MCP env/header keys this tool's restore will leave redacted (Claude only;
   * empty for every other tool). Computed with the plan so the post-restore
   * reminder names exactly the servers the merge decided to write.
   */
  needsEnv: Array<{ name: string; key: string }>;
  /**
   * Claude project-scope MCP server groups skipped because their directory
   * does not exist here (Claude only; empty for every other tool). See
   * McpMergePlan.skippedProjectDirs in src/adapters/claude/mcp.ts.
   */
  skippedProjectDirs: string[];
}

/** Strip the canonical "<tool>/files/" prefix from a reconstructed repoPath. */
function stripFilesPrefix(tool: ToolId, repoPath: string): string {
  const prefix = `${tool}/files/`;
  const norm = repoPath.replace(/\\/g, "/");
  return norm.startsWith(prefix) ? norm.slice(prefix.length) : norm;
}

/**
 * Synthesize a plan fragment for a tool that has no dedicated planActions export.
 * Mirrors the planner shape used by adapter restore modules:
 * one write-file/write-symlink action per frozen artifact, honoring sourceOfTruth
 * (when local is authoritative, an existing destination is kept, not overwritten,
 * so we omit the action just as the real restore would skip it).
 */
async function fallbackActions(
  ctx: RestoreContext,
  tool: ToolId,
  data: RestoreData,
): Promise<RestoreAction[]> {
  const out: RestoreAction[] = [];

  for (const file of data.files) {
    const rel = stripFilesPrefix(tool, file.repoPath);
    const dest = path.join(ctx.toolHome, ...rel.split("/"));
    const overwrites = await ctx.fs.exists(dest);
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    out.push({
      type: "write-file",
      tool,
      targetPath: dest,
      description: `Write ${rel}`,
      overwrites,
    });
  }

  for (const link of data.symlinks) {
    const rel = stripFilesPrefix(tool, link.repoPath);
    const dest = path.join(ctx.toolHome, ...rel.split("/"));
    const overwrites = (await ctx.fs.statKind(dest)) !== "missing";
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    out.push({
      type: "write-symlink",
      tool,
      targetPath: dest,
      description: `Symlink ${rel} -> ${link.target}`,
      overwrites,
    });
  }

  return out;
}

/**
 * Build the full RestorePlan: gather each tool's RestoreData, compute its planned
   * actions (via the tool's planActions when available; otherwise a synthesized
   * file/symlink action list), and probe which tool CLIs are
 * missing on this machine (R6). No mutation happens here.
 *
 * Actions are always computed against a dryRun context so planning is side-effect
 * free regardless of the real run mode.
 */
async function buildPlan(args: {
  repoRoot: string;
  tools: ToolId[];
  sourceOfTruth: "local" | "repo";
  os: OS;
}): Promise<{
  plan: RestorePlan;
  prepared: PreparedTool[];
  npmGlobals: string[];
  externalTools: ExternalToolRef[];
  homeFiles: CapturedFile[];
}> {
  const prepared: PreparedTool[] = [];
  const actions: RestoreAction[] = [];
  const missingClis: ToolId[] = [];

  for (const id of args.tools) {
    const wiring = wiringFor(id);
    const data = await loadRestoreData(args.repoRoot, id);

    // Plan against a dry-run context (pure: no writes, no installs).
    const planCtx = buildRestoreContext({
      toolId: id,
      repoRoot: args.repoRoot,
      sourceOfTruth: args.sourceOfTruth,
      dryRun: true,
      os: args.os,
    });

    // Prefer the tool's own planner. For tools without one, synthesize file/symlink
    // write actions from RestoreData so the dry-run plan is still complete.
    const toolActions = wiring.planActions
      ? await wiring.planActions(planCtx, data)
      : await fallbackActions(planCtx, id, data);
    actions.push(...toolActions);

    // Claude is the only tool that registers MCP servers today. The same
    // decision function the merge applies also reports which env values it will
    // leave redacted, and which project-scope groups it skipped because their
    // directory does not exist here — read both here so the reminder can only
    // ever name servers/directories the merge really decided on.
    let needsEnv: Array<{ name: string; key: string }> = [];
    let skippedProjectDirs: string[] = [];
    if (id === "claude") {
      const mcpPlan = await planMcpMerge(planCtx, data.manifest);
      needsEnv = mcpPlan.needsEnv;
      skippedProjectDirs = mcpPlan.skippedProjectDirs;
    }
    prepared.push({
      id,
      adapter: wiring.adapter,
      data,
      actions: toolActions,
      needsEnv,
      skippedProjectDirs,
    });

    // R6: is the tool's CLI present? (Cursor's CLI is frequently absent; that's
    // fine — installCli degrades gracefully on platforms with no headless path.)
    if (!(await which(cliBinaryName(id)))) {
      missingClis.push(id);
      actions.push({
        type: "install-cli",
        tool: id,
        description: `Install ${id} CLI (missing on this machine)`,
      });
    }
  }

  // WP-B: the cross-tool shared/home root. Planned as system-level write-file
  // actions so `--dry-run` shows exactly which $HOME files a pull would touch.
  const homeFiles = await loadHomeFiles(args.repoRoot);
  actions.push(
    ...(await planHomeFileActions(
      buildHomeRestoreServices({
        sourceOfTruth: args.sourceOfTruth,
        dryRun: true,
        os: args.os,
      }),
      homeFiles,
    )),
  );

  // R8: a SINGLE deduped npm-globals pass across all restored tools. Planned as
  // system-level actions here (matching what installSharedNpmGlobals will run) so
  // the dry-run plan is faithful and no package is double-installed.
  const npmGlobals = dedupeNpmGlobals(prepared);
  actions.push(...npmGlobalActions(npmGlobals));

  // WP-C: the binaries behind MCP/hook commands that npm does NOT own (brew/uv/
  // pipx, or unattributable). Planned like the npm pass so --dry-run shows every
  // install a real pull would attempt — through the SAME PATH probe the install
  // pass uses, so a tool this machine already has is missing from both.
  const externalTools = dedupeExternalTools(prepared);
  actions.push(...(await externalToolActions(externalTools)));

  const plan: RestorePlan = {
    tools: args.tools,
    actions,
    missingClis,
    willBackupExisting: true,
    skippedProjectDirs: mcpSkippedProjectDirs(prepared),
  };
  return { plan, prepared, npmGlobals, externalTools, homeFiles };
}

/** Pretty-print a RestorePlan to the (stderr) logger for --dry-run. */
export function printPlan(
  plan: RestorePlan,
  meta: ArbellaMeta,
  l: Logger = log,
): void {
  l.info(`Restore plan (dry run) — ${plan.tools.length} tool(s)`);
  l.step(
    `Tools: ${plan.tools.length > 0 ? plan.tools.join(", ") : "(none)"}`,
  );
  l.step(
    `A timestamped safety backup of existing restore targets WILL be taken first (R14).`,
  );
  if (plan.missingClis.length > 0) {
    l.step(`CLIs to auto-install: ${plan.missingClis.join(", ")}`);
  } else {
    l.step("All required CLIs already present.");
  }
  if (meta.sharedInstructions) {
    l.step(
      "Shared instructions (R9) will be deployed to CLAUDE.md + AGENTS.md.",
    );
  }
  if (plan.skippedProjectDirs.length > 0) {
    l.warn(skippedProjectDirsWarning(plan.skippedProjectDirs));
  }

  const counts = countByType(plan.actions);
  l.info(`Planned actions: ${plan.actions.length}`);
  for (const [type, n] of counts) {
    l.step(`${type}: ${n}`);
  }
  for (const action of plan.actions) {
    const target = action.targetPath ? ` (${action.targetPath})` : "";
    const ow = action.overwrites ? " [overwrites]" : "";
    l.step(`${action.tool} · ${action.description}${target}${ow}`);
  }

  l.info(
    "Secrets were NOT carried in the repo; after a real restore you will need " +
      "to re-authenticate (see the post-restore reminder).",
  );
}

/** Tally actions by their `type`, preserving first-seen order. */
function countByType(actions: RestoreAction[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const a of actions) {
    map.set(a.type, (map.get(a.type) ?? 0) + 1);
  }
  return [...map.entries()];
}

/* -------------------------------------------------------------------------- */
/* Re-auth reminder (post-restore)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Print the post-restore re-login reminder. Secret files are excluded by the
 * denylist and are therefore never present in the repo, so the user must
 * re-authenticate each restored tool. This prints GUIDANCE ONLY — never any
 * secret value, path-to-secret content, or token.
 */
function printReauthReminder(
  tools: ToolId[],
  extras: {
    /** `<server>, <KEY>` pairs of MCP env values the restore left redacted. */
    mcpNeedsEnv?: ReadonlyArray<{ name: string; key: string }>;
    /** External tools arbella could not install on this machine. */
    manualExternalTools?: readonly ExternalToolRef[];
    /** Claude project-scope MCP dirs skipped (see McpMergePlan.skippedProjectDirs). */
    skippedProjectDirs?: readonly string[];
  } = {},
): void {
  log.info("Restore complete. Secrets were intentionally NOT included.");
  log.step(
    "You will need to re-authenticate the restored tools (no credentials were copied):",
  );
  for (const tool of tools) {
    switch (tool) {
      case "claude":
        log.step(
          "claude: run `claude login` (or `/login` inside Claude Code) to " +
            "re-create ~/.claude/.credentials.json.",
        );
        break;
      case "codex":
        log.step(
          "codex: run `codex login` to re-create ~/.codex/auth.json.",
        );
        break;
      case "cursor":
        log.step(
          "cursor: sign in via the Cursor app; re-add any MCP server API keys " +
            "in ~/.cursor/mcp.json (their values were redacted on backup).",
        );
        break;
      case "opencode":
        log.step(
          "opencode: run `opencode auth login` to re-create " +
            "~/.local/share/opencode/auth.json; re-add any MCP env API keys " +
            "(their values were redacted on backup).",
        );
        break;
      case "copilot":
        log.step(
          "copilot: run `copilot` and sign in (or `gh auth login`); re-add any " +
            "MCP server secrets in ~/.copilot/mcp-config.json (redacted on backup).",
        );
        break;
      case "kilo":
        log.step(
          "kilo: sign in with the Kilo CLI; re-add any provider/MCP API keys in " +
            "~/.config/kilo/kilo.jsonc (their values were redacted on backup).",
        );
        break;
      case "antigravity":
        log.step(
          "antigravity: sign in with your Google account; re-add any MCP server " +
            "secrets in ~/.gemini/antigravity/mcp_config.json (redacted on backup).",
        );
        break;
    }
  }
  const needsEnv = extras.mcpNeedsEnv ?? [];
  if (needsEnv.length > 0) {
    const pairs = [...new Set(needsEnv.map((e) => `${e.name}.${e.key}`))].sort();
    log.step(
      `MCP env values were redacted on backup — re-supply them for: ${pairs.join(", ")}.`,
    );
  }
  const skippedProjectDirs = extras.skippedProjectDirs ?? [];
  if (skippedProjectDirs.length > 0) {
    log.warn(skippedProjectDirsWarning(skippedProjectDirs));
  }
  for (const tool of extras.manualExternalTools ?? []) {
    const usedBy = tool.usedBy.length > 0 ? ` (used by ${tool.usedBy.join(", ")})` : "";
    const where = tool.resolvedPath !== undefined ? ` — was at ${tool.resolvedPath}` : "";
    log.step(`install ${tool.name} manually${usedBy}${where}`);
  }
  log.step(
    "If you also backed up secrets separately, run `arbella secrets import` " +
      "with your passphrase to restore them locally.",
  );
}

/* -------------------------------------------------------------------------- */
/* Repo resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the backup repo to restore from. Precedence: the positional `repoUrl`
 * arg, then `--repo`, then the configured `config.repo`. Returns a RepoConfig
 * with a concrete localPath (clone destination) — falling back to a deterministic
 * path under dataDir() when restoring from an ad-hoc URL that has no configured
 * clone location yet.
 */
async function resolveRepo(
  repoUrl: string | undefined,
  optRepo: string | undefined,
): Promise<RepoConfig> {
  const config = await loadConfigOrDefault();
  const explicit = repoUrl ?? optRepo;

  if (explicit && explicit.trim() !== "") {
    const url = explicit.trim();
    // Reuse the configured clone path only when it matches the same URL;
    // otherwise clone the ad-hoc URL into a stable per-repo dir under dataDir().
    const sameAsConfig =
      config.repo.url.trim() !== "" && config.repo.url.trim() === url;
    const localPath =
      sameAsConfig && config.repo.localPath
        ? config.repo.localPath
        : path.join(dataDir(), "restore", slugForUrl(url));
    return { provider: config.repo.provider, url, localPath };
  }

  // No explicit URL — fall back to the configured repo.
  if (!config.repo.url || config.repo.url.trim() === "") {
    throw new Error(
      "No repo to pull from. Pass a repo URL " +
        "(`arbella pull <repo-url>`) or run `arbella init` first.",
    );
  }
  const localPath =
    config.repo.localPath && config.repo.localPath.trim() !== ""
      ? config.repo.localPath
      : path.join(dataDir(), "restore", slugForUrl(config.repo.url));
  return { provider: config.repo.provider, url: config.repo.url, localPath };
}

/** Derive a filesystem-safe slug from a clone URL for an ad-hoc clone dir. */
function slugForUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  // Keep the last 1-2 path segments (owner/repo) for readability, sanitized.
  const tail = trimmed.split(/[/:]/).filter(Boolean).slice(-2).join("-");
  const safe = tail.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe.length > 0 ? safe : "backup";
}

/**
 * Ensure the repo is present locally and as fresh as possible. Clones when
 * absent (via ensureLocalClone), otherwise pulls (R12 repo-as-source freshness).
 * A pull failure (e.g. offline) is downgraded to a warning so a restore from an
 * already-cloned repo still proceeds with the local copy.
 *
 * AUTH (P5): `auth` carries the interactive sign-in seams (gh/glab-first; install
 * on demand or device-flow/token fallback) threaded down into the clone/pull so a
 * PRIVATE backup repo authenticates automatically, then restore continues.
 */
async function ensureRepoReady(
  repo: RepoConfig,
  auth: RepoAuthHooks,
): Promise<void> {
  const alreadyCloned = await git.isGitRepo(repo.localPath);
  await ensureLocalClone(repo, auth);
  if (alreadyCloned) {
    try {
      log.step(`Updating backup repo at ${repo.localPath}`);
      await pullWithAuth(repo, auth);
    } catch (err) {
      log.warn(
        `restore: could not update repo (using local copy): ${errMsg(err)}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run the restore. `repoUrl` is the optional positional arg; `opts` are the
 * parsed flags. This is the single directly-callable entrypoint (commander's
 * action handler delegates here, and tests call it without commander).
 */
export async function run(
  repoUrl: string | undefined,
  opts: RestoreOptions,
): Promise<void> {
  const os = detectOS();
  const dryRun = opts.dryRun === true;

  // ---- 0. Ensure git is available before we touch any repo (P3 on-demand) --
  //         A dry run only reads an already-cloned repo, so don't force-install
  //         git just to plan; the real run needs it to clone/pull.
  if (!dryRun) {
    await ensureDeps(["git"], { required: true });
  }

  // ---- 1. Resolve + ready the repo (gh/glab-first auth on private repos) ---
  const repo = await resolveRepo(repoUrl, opts.repo);
  log.info(`Restoring from ${repo.url}`);
  // Interactive auth seams (skipped for a pure dry run, which shouldn't prompt).
  const authHooks = buildRepoAuthHooks({
    createdAt: new Date().toISOString(),
    interactive: !dryRun,
  });
  await ensureRepoReady(repo, authHooks);
  const repoRoot = repo.localPath;

  // ---- 2. Parse arbella.json (ArbellaMeta) ------------------------------
  const metaPath = path.join(repoRoot, "arbella.json");
  if (!(await fs.exists(metaPath))) {
    throw new Error(
      `Not a arbella backup repo: ${metaPath} is missing. ` +
        "Did you point restore at the right repository?",
    );
  }
  let meta: ArbellaMeta;
  try {
    meta = parseMeta(JSON.parse(await fs.read(metaPath)));
  } catch (err) {
    throw new Error(
      `Could not read ${metaPath} (corrupt arbella.json?): ${errMsg(err)}`,
    );
  }

  // ---- 3. Decide which tools to restore -----------------------------------
  const config = await loadConfigOrDefault();
  const flagTools = parseToolsFlag(opts.tools);
  const tools = selectToolsForRestore(meta, flagTools, config.tools);
  if (tools.length === 0) {
    log.warn(
      "No tools to restore (the repo + your selection have no overlap). " +
        `Repo captured: ${meta.tools.join(", ") || "(none)"}.`,
    );
    return;
  }

  // Source-of-truth direction (R12). `--force` forces repo-wins so existing
  // local files are overwritten even when the config says local is authoritative.
  const sourceOfTruth: "local" | "repo" = opts.force
    ? "repo"
    : config.sourceOfTruth;
  log.debug(
    `restore: tools=[${tools.join(", ")}] sourceOfTruth=${sourceOfTruth} ` +
      `dryRun=${dryRun}`,
  );

  // ---- 4. Build the plan (no mutation) ------------------------------------
  const { plan, prepared, npmGlobals, externalTools, homeFiles } = await buildPlan({
    repoRoot,
    tools,
    sourceOfTruth,
    os,
  });

  // ---- 5. Dry run: print the plan and STOP --------------------------------
  if (dryRun) {
    printPlan(plan, meta);
    log.info("Dry run: no changes were made.");
    return;
  }

  // ---- 6. R14 safety backup BEFORE any overwrite --------------------------
  const iso = new Date().toISOString();
  log.info("Creating safety backups of existing tool homes (R14)…");
  const backups = await safetyBackup(tools, iso, os);
  if (backups.length === 0) {
    log.debug("restore: no existing tool homes needed backing up.");
  }

  // ---- 7. Auto-install missing CLIs (R6) ----------------------------------
  if (plan.missingClis.length > 0) {
    log.info(`Installing missing CLIs: ${plan.missingClis.join(", ")}`);
    for (const id of plan.missingClis) {
      try {
        await ensureCli(id, os);
      } catch (err) {
        log.warn(
          `restore: could not install ${id} CLI (continuing): ${errMsg(err)}`,
        );
      }
    }
  }

  // ---- 8. Restore each tool -----------------------------------------------
  for (const tool of prepared) {
    log.info(`Restoring ${tool.id}…`);
    const ctx = buildRestoreContext({
      toolId: tool.id,
      repoRoot,
      sourceOfTruth,
      dryRun: false,
      os,
    });
    try {
      await tool.adapter.restore(ctx, tool.data);
      log.success(`${tool.id}: restored`);
    } catch (err) {
      // One tool failing must not strand the others (the safety backup is the
      // user's recovery path). Surface it and keep going.
      log.error(`restore: ${tool.id} failed: ${errMsg(err)}`);
    }
  }

  // ---- 8b. Shared npm-globals pass (R8): install each package ONCE across all
  //          restored tools (deduped). Runs after the adapters so any tool-CLI
  //          install above is already on PATH. ------------------------------
  await installSharedNpmGlobals(npmGlobals);

  // ---- 8c. Shared external-tools pass (WP-C): the brew/uv/pipx binaries the
  //          restored MCP servers and hooks invoke. Runs right after the npm
  //          pass (same "install once across all tools" shape); anything that
  //          cannot be installed here is reported in the reminder below. -----
  const manualExternalTools = await installSharedExternalTools(externalTools);

  // ---- 8d. shared/home (WP-B): the $HOME files that live outside every tool
  //          home — linked hook/statusline/MCP scripts, plugin companion
  //          configs, extraPaths. Written AFTER the adapters so a script and the
  //          config referencing it land in the same pass, each overwrite guarded
  //          by its own safety copy (R14). --------------------------------
  let homeWritten = 0;
  if (homeFiles.length > 0) {
    log.info(`Restoring ${homeFiles.length} shared home file(s)…`);
    homeWritten = await restoreHomeFiles(
      buildHomeRestoreServices({ sourceOfTruth, dryRun: false, os }),
      homeFiles,
      {
        safetyDir: path.join(
          dataDir(),
          "safety-backups",
          `home-${iso.replace(/[:.]/g, "-")}`,
        ),
      },
    );
  }

  // ---- 9. Deploy shared instructions (R9) to both tools -------------------
  if (meta.sharedInstructions) {
    log.info("Deploying shared instructions to Claude + Codex (R9)…");
    await deploySharedInstructions(repoRoot, tools, false, sourceOfTruth);
  }

  // ---- 10. Re-auth reminder ----------------------------------------------
  if (homeFiles.length > 0) {
    log.step(
      `Shared home files: ${homeWritten} of ${homeFiles.length} written into your ` +
        "home directory (the rest already existed and local is the source of truth).",
    );
  }
  printReauthReminder(tools, {
    mcpNeedsEnv: mcpNeedsEnv(prepared),
    manualExternalTools,
    skippedProjectDirs: mcpSkippedProjectDirs(prepared),
  });
  if (backups.length > 0) {
    log.info(
      `Previous tool homes were safely backed up under ${path.join(
        dataDir(),
        "safety-backups",
      )} (restore them manually if anything looks wrong).`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* commander registration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Attach the `pull` subcommand to the program. The command is intentionally
 * thin: it parses flags, then delegates to {@link run}. The top-level error
 * handler in src/index.ts turns a thrown error into a non-zero exit.
 *
 * Legacy alias: `restore` is also registered, hidden from `--help`, so old
 * habits, scripts, and previously generated repo READMEs (`arbella restore <url>`)
 * keep working. `pull` is "clone if needed, then apply" — not a bare `git pull`.
 */
export function register(program: Command): void {
  const configure = (cmd: Command): Command =>
    cmd
      .description(
        "Pull your AI dev setup from your private repo (installs missing CLIs, " +
          "places files, reinstalls plugins/skills, deploys shared instructions).",
      )
      .argument(
        "[repo-url]",
        "Repo URL to pull from (defaults to the configured repo).",
      )
      .option(
        "--dry-run",
        "Preview the pull: show what would change without writing anything.",
      )
      .option(
        "--repo <url>",
        "Repo URL (alternative to the positional argument).",
      )
      .option(
        "--tools <list>",
        "Comma-separated subset of tools to pull (e.g. claude,codex).",
      )
      .option(
        "--force",
        "Overwrite existing local files even when local is the source of truth.",
      )
      .action(async (repoArg: string | undefined, opts: RestoreOptions) => {
        await run(repoArg, opts);
      });

  configure(program.command("pull"));
  configure(program.command("restore", { hidden: true }));
}

/* -------------------------------------------------------------------------- */
/* internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Best-effort message extraction from an unknown thrown value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort POSIX file mode for a path, used to preserve the executable bit on
 * hooks/statusline scripts during restore. Returns undefined when the mode can't
 * be read (e.g. unusual host FS) so the writer falls back to its default.
 *
 * Uses node:fs/promises.lstat directly (not the FsService, which intentionally
 * exposes no stat-mode surface). Read-only; touches nothing.
 */
async function fileMode(abs: string): Promise<number | undefined> {
  try {
    const { promises: fsp } = await import("node:fs");
    const st = await fsp.lstat(abs);
    // Permission bits ONLY. Deliberately NOT 0o7777: setuid/setgid/sticky come
    // out of a git checkout (git itself stores only the +x bit, so anything
    // above 0o777 here was put in the working tree by something else) and a
    // restore must never hand a $HOME script an elevated mode.
    return st.mode & 0o777;
  } catch {
    return undefined;
  }
}

export default run;
