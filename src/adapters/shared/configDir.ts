/**
 * Shared capture/restore engine for "config-dir CLI" tools.
 *
 * opencode, GitHub Copilot CLI, and Kilo Code are all terminal CLIs whose
 * portable setup is a single config directory of mostly-text files (a JSON/JSONC
 * config, plus markdown agents/commands and an MCP config). They have no Cursor-
 * style split User-data dir, no VS Code extension payloads, and their secrets
 * live in separate credential files (excluded by the denylist or by living
 * outside the config home entirely). That makes their capture/restore logic
 * identical apart from WHICH paths to freeze — so it lives here once instead of
 * being copy-pasted into three near-identical adapters.
 *
 * Each adapter supplies a {@link ConfigDirSpec} (its ToolId + the relative paths
 * to freeze) and delegates capture()/restore() here. All fs work goes through the
 * injected CoreServices on the context, so this stays unit-testable against a
 * fixture dir. Non-fatal problems are surfaced via warnings / log.warn, never
 * thrown — one tool's absence never blocks a multi-tool backup.
 */

import path from "node:path";

import type { CaptureContext, RestoreContext, RestoreData } from "../adapter.interface.js";
import type {
  CaptureResult,
  CapturedFile,
  CapturedSymlink,
  RestoreAction,
  SecretRef,
  ToolId,
  ToolManifest,
} from "../../types.js";

import { denylistFor, matchesDeny } from "../../core/sanitizer/denylist.js";
import { normalizeCapturedSymlinkTarget } from "../../utils/symlink.js";
import { binaryScanViews, decodeForCapture } from "../../utils/capture-bytes.js";

/** What a config-dir adapter must declare for the shared engine to do its work. */
export interface ConfigDirSpec {
  /** The tool this spec describes. */
  tool: ToolId;
  /**
   * Paths to FREEZE (copy into the repo), relative to the tool's config home, in
   * capture order. Directories are walked recursively. Anything matching the
   * denylist is skipped regardless of its presence here.
   */
  frozenPaths: readonly string[];
}

/** Prefix (POSIX) for every CapturedFile.repoPath: `<tool>/files/...`. */
function repoPrefix(tool: ToolId): string {
  return `${tool}/files`;
}

/** Build the repo path for a config-home-relative POSIX path. */
function repoPathFor(tool: ToolId, rel: string): string {
  return `${repoPrefix(tool)}/${rel}`;
}

/** Convert an absolute child path under `home` into a POSIX rel path. */
function toRel(home: string, abs: string): string {
  return path.relative(home, abs).split(path.sep).join("/");
}

/** Map a `<tool>/files/X` repoPath back to its config-home-relative tail. */
function relFromRepoPath(tool: ToolId, repoPath: string): string | undefined {
  const norm = repoPath.replace(/\\/g, "/");
  const prefix = `${repoPrefix(tool)}/`;
  return norm.startsWith(prefix) ? norm.slice(prefix.length) : undefined;
}


/** An empty manifest for a config-dir tool (these tools track no plugins here:
 * opencode/kilo declare plugins inside their config file, which is captured as a
 * frozen file, so there is nothing to reinstall from a separate manifest). */
function emptyConfigManifest(tool: ToolId): ToolManifest {
  return {
    tool,
    plugins: [],
    marketplaces: [],
    skills: [],
    npmGlobals: [],
    enabledPlugins: {},
  };
}

/** Read mode bits best-effort so executable helper files keep their mode. */
async function readMode(abs: string): Promise<number | undefined> {
  try {
    const { promises: fsp } = await import("node:fs");
    const st = await fsp.stat(abs);
    return st.mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Read + sanitize + template a single file and push a CapturedFile. */
async function captureFile(args: {
  ctx: CaptureContext;
  tool: ToolId;
  abs: string;
  rel: string;
  files: CapturedFile[];
  secrets: SecretRef[];
  warnings: string[];
}): Promise<void> {
  const { ctx, tool, abs, rel, files, secrets, warnings } = args;
  const repoPath = repoPathFor(tool, rel);
  const mode = await readMode(abs);

  let bytes: Buffer;
  try {
    bytes = await ctx.fs.readBytes(abs);
  } catch (err) {
    warnings.push(`${tool}: could not read ${rel}: ${(err as Error).message}`);
    return;
  }

  const decoded = decodeForCapture(bytes);

  if (decoded.kind === "binary") {
    // Fail-safe: never let a "binary" file smuggle a secret past the sanitizer.
    // Scan every lossy view (UTF-8 + UTF-16LE/BE at both alignments) — a NUL-
    // interleaved token is invisible to a UTF-8-only scan. On any hit, DROP the
    // file (never store raw) + record refs.
    if (!ctx.includeSecrets) {
      for (const view of binaryScanViews(bytes)) {
        const scan = ctx.sanitizer.sanitizeText(view, tool, rel);
        if (!scan.changed) continue;
        warnings.push(`${tool}: skipped ${rel} — binary content with secret-shaped bytes`);
        secrets.push(...scan.found);
        return;
      }
    }
    const file: CapturedFile = { repoPath, content: bytes.toString("base64"), binary: true };
    if (mode !== undefined) file.mode = mode;
    files.push(file);
    return;
  }

  // UTF-16 configs are decoded to text above, so a lone NUL byte never routes a
  // secret-bearing config around sanitizeFile.
  const raw = decoded.text;
  let content = raw;
  if (!ctx.includeSecrets) {
    // sanitizeFile structurally redacts JSON/JSONC config (secret-key-aware) and
    // falls back to pattern redaction for other text — so MCP env API keys and
    // token-shaped values never enter the repo, and the SecretRefs it returns
    // drive the post-restore "re-supply X" reminder.
    const sanitized = ctx.sanitizer.sanitizeFile(raw, tool, rel);
    content = sanitized.content;
    secrets.push(...sanitized.found);
  }
  const templated = ctx.templater.toTemplate(content, ctx.vars);
  const file: CapturedFile = { repoPath, content: templated };
  if (mode !== undefined) file.mode = mode;
  files.push(file);
}

/** Recursively freeze a config-dir tree, honoring the denylist + symlinks. */
async function walkFrozen(args: {
  ctx: CaptureContext;
  tool: ToolId;
  home: string;
  abs: string;
  deny: string[];
  files: CapturedFile[];
  symlinks: CapturedSymlink[];
  secrets: SecretRef[];
  warnings: string[];
}): Promise<void> {
  const { ctx, tool, home, abs, deny, files, symlinks, secrets, warnings } = args;
  const kind = await ctx.fs.statKind(abs);
  if (kind === "missing") return;

  const rel = toRel(home, abs);
  if (rel && matchesDeny(rel, deny)) {
    ctx.log.debug(`${tool}: skip (denylist) ${rel}`);
    return;
  }

  if (kind === "symlink") {
    const target = normalizeCapturedSymlinkTarget(await ctx.fs.readLink(abs));
    symlinks.push({ repoPath: repoPathFor(tool, rel), target });
    ctx.log.debug(`${tool}: symlink ${rel} -> ${target}`);
    return;
  }

  if (kind === "dir") {
    const entries = await ctx.fs.list(abs);
    entries.sort();
    for (const name of entries) {
      await walkFrozen({ ...args, abs: path.join(abs, name) });
    }
    return;
  }

  await captureFile({ ctx, tool, abs, rel, files, secrets, warnings });
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Capture a config-dir tool into a CaptureResult. Graceful when the tool is
 * absent: returns an EMPTY result with a single explanatory warning so a backup
 * of the other tools is never blocked.
 */
export async function captureConfigDir(
  ctx: CaptureContext,
  spec: ConfigDirSpec,
): Promise<CaptureResult> {
  const files: CapturedFile[] = [];
  const symlinks: CapturedSymlink[] = [];
  const secrets: SecretRef[] = [];
  const warnings: string[] = [];
  const manifest = emptyConfigManifest(spec.tool);
  const home = ctx.toolHome;
  const deny = denylistFor(spec.tool);

  if ((await ctx.fs.statKind(home)) !== "dir") {
    warnings.push(`${spec.tool}: no ${home} found; skipping (${spec.tool} not installed?).`);
    return { tool: spec.tool, files, symlinks, manifest, secrets, warnings };
  }

  for (const rel of spec.frozenPaths) {
    await walkFrozen({
      ctx,
      tool: spec.tool,
      home,
      abs: path.join(home, rel),
      deny,
      files,
      symlinks,
      secrets,
      warnings,
    });
  }

  if (files.length === 0 && symlinks.length === 0) {
    warnings.push(`${spec.tool}: present but nothing portable to capture.`);
  }

  return { tool: spec.tool, files, symlinks, manifest, secrets, warnings };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

/** Resolve a frozen file's repoPath onto the target machine's config home. */
function destFor(ctx: RestoreContext, tool: ToolId, repoPath: string): string | undefined {
  const rel = relFromRepoPath(tool, repoPath);
  if (rel === undefined) return undefined;
  return path.join(ctx.toolHome, ...rel.split("/").filter(Boolean));
}

/**
 * Build the restore actions WITHOUT executing them (for --dry-run reporting).
 * Honors sourceOfTruth: when local is authoritative an existing destination is
 * kept (the action is omitted) just as the real restore would skip it.
 */
export async function planConfigDirActions(
  ctx: RestoreContext,
  data: RestoreData,
  spec: ConfigDirSpec,
): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];

  for (const file of data.files) {
    const dest = destFor(ctx, spec.tool, file.repoPath);
    if (dest === undefined) continue;
    const overwrites = await ctx.fs.exists(dest);
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-file",
      tool: spec.tool,
      targetPath: dest,
      description: `Write ${relFromRepoPath(spec.tool, file.repoPath)}`,
      overwrites,
    });
  }

  for (const link of data.symlinks) {
    const dest = destFor(ctx, spec.tool, link.repoPath);
    if (dest === undefined) continue;
    const overwrites = (await ctx.fs.statKind(dest)) !== "missing";
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-symlink",
      tool: spec.tool,
      targetPath: dest,
      description: `Link ${relFromRepoPath(spec.tool, link.repoPath)} -> ${link.target}`,
      overwrites,
    });
  }

  return actions;
}

/** Write one frozen file back onto the target home, rehydrating {{TOKENS}}. */
async function writeRestoredFile(
  ctx: RestoreContext,
  tool: ToolId,
  file: CapturedFile,
): Promise<void> {
  const dest = destFor(ctx, tool, file.repoPath);
  if (dest === undefined) {
    ctx.log.debug(`${tool}: ignoring foreign repoPath ${file.repoPath}`);
    return;
  }
  if (ctx.sourceOfTruth === "local" && (await ctx.fs.exists(dest))) {
    ctx.log.debug(`${tool}: keep local ${file.repoPath} (sourceOfTruth=local)`);
    return;
  }
  if (file.binary) {
    await ctx.fs.writeBytes(dest, Buffer.from(file.content, "base64"), file.mode);
    return;
  }
  const expanded = ctx.templater.fromTemplate(file.content, ctx.vars);
  await ctx.fs.write(dest, expanded, file.mode);
}

/** Recreate one captured symlink under the target config home. */
async function writeRestoredSymlink(
  ctx: RestoreContext,
  tool: ToolId,
  link: CapturedSymlink,
): Promise<void> {
  const dest = destFor(ctx, tool, link.repoPath);
  if (dest === undefined) {
    ctx.log.debug(`${tool}: ignoring foreign symlink ${link.repoPath}`);
    return;
  }
  if (ctx.sourceOfTruth === "local" && (await ctx.fs.statKind(dest)) !== "missing") {
    ctx.log.debug(`${tool}: keep local symlink ${link.repoPath} (sourceOfTruth=local)`);
    return;
  }
  await ctx.fs.symlink(link.target, dest);
}

/**
 * Restore a config-dir tool: place frozen files/symlinks back onto the target
 * config home, rehydrating {{TOKENS}}. Honors ctx.dryRun (plan only). Best-effort
 * + graceful: a single failed write is logged, never thrown.
 */
export async function restoreConfigDir(
  ctx: RestoreContext,
  data: RestoreData,
  spec: ConfigDirSpec,
): Promise<void> {
  if (ctx.dryRun) {
    const actions = await planConfigDirActions(ctx, data, spec);
    for (const action of actions) ctx.log.step(action.description);
    return;
  }

  for (const file of data.files) {
    try {
      await writeRestoredFile(ctx, spec.tool, file);
    } catch (err) {
      ctx.log.warn(`${spec.tool}: failed to write ${file.repoPath}: ${(err as Error).message}`);
    }
  }

  for (const link of data.symlinks) {
    try {
      await writeRestoredSymlink(ctx, spec.tool, link);
    } catch (err) {
      ctx.log.warn(
        `${spec.tool}: failed to create symlink ${link.repoPath}: ${(err as Error).message}`,
      );
    }
  }
}
