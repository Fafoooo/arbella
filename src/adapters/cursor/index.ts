/**
 * The Cursor adapter — implements the Adapter contract for Cursor.
 *
 * Cursor is a desktop app; its CLI may be entirely absent (notably on Linux,
 * where there is no headless install). This adapter is therefore real for the
 * portable parts of Cursor and fully graceful when Cursor does not exist:
 *
 *   - detect():        true if ~/.cursor or Cursor User data exists; false
 *                      cleanly when both are missing.
 *   - isCliInstalled():probes `cursor` on PATH (often false on this kind of box).
 *   - installCli(os):  brew --cask cursor (darwin) / winget (win32); on Linux
 *                      there is no standard install -> warn + skip (no throw).
 *   - capture(ctx):    if Cursor is absent, returns an EMPTY CaptureResult with a
 *                      single warning (so backup of the other tools is never
 *                      blocked). Otherwise freezes global MCP config, Cursor User
 *                      settings/keybindings/snippets, local skills, skills.sh
 *                      symlinks, and extension IDs. Secret values are redacted and
 *                      machine paths are templated before anything enters the repo.
 *   - restore(ctx,d):  writes those files back onto ~/.cursor or Cursor's User
 *                      data dir, rehydrating {{TOKENS}} to this machine's paths.
 *                      It also recreates skill symlinks, best-effort installs
 *                      extensions via `cursor --install-extension`.
 *
 * All fs work goes through the injected CoreServices on the context objects, so
 * the adapter is unit-testable against a fixture dir. No direct node:fs, no clock.
 * Non-fatal problems are surfaced via the warnings array / log.warn, never thrown.
 */

import path from "node:path";
import process from "node:process";

import { execa } from "execa";

import type { Adapter, CaptureContext, RestoreContext, RestoreData } from "../adapter.interface.js";
import type {
  CaptureResult,
  CapturedFile,
  CapturedSymlink,
  OS,
  PluginEntry,
  RestoreAction,
  SecretRef,
  SkillEntry,
} from "../../types.js";

import { denylistFor, matchesDeny } from "../../core/sanitizer/denylist.js";
import { emptyManifest } from "../../core/manifest/index.js";
import { cliBinaryName, detectOS, installCommandFor } from "../../platform/os.js";
import { runInstall, which } from "../../platform/install.js";
import { normalizeCapturedSymlinkTarget } from "../../utils/symlink.js";
import { binaryScanViews, decodeForCapture } from "../../utils/capture-bytes.js";
import { resolveContainedTarget } from "../../utils/safe-path.js";
import type { ContainedTarget, ContainedTargetOptions } from "../../utils/safe-path.js";

import {
  FROZEN_PATHS,
  REPO_PREFIX,
  USER_REPO_PREFIX,
  cursorUserPaths,
  paths,
} from "./paths.js";

/* -------------------------------------------------------------------------- */
/* Small local helpers (mirroring the Claude/Codex adapter conventions)        */
/* -------------------------------------------------------------------------- */

/** Build the repo path for a tool-home-relative POSIX path. */
function repoPathFor(rel: string): string {
  return `${REPO_PREFIX}/${rel}`;
}

/** Build the repo path for a Cursor User-data-relative POSIX path. */
function userRepoPathFor(rel: string): string {
  return `${USER_REPO_PREFIX}/${rel}`;
}

/** Convert an absolute child path under `home` into a POSIX rel path. */
function toRel(home: string, abs: string): string {
  return path.relative(home, abs).split(path.sep).join("/");
}

type CursorTarget = { root: "home" | "user"; rel: string };

/** Strip cursor/files or cursor/user from a repo path and keep which root it uses. */
function targetFromRepoPath(repoPath: string): CursorTarget | undefined {
  const norm = repoPath.replace(/\\/g, "/");
  const homePrefix = `${REPO_PREFIX}/`;
  if (norm.startsWith(homePrefix)) return { root: "home", rel: norm.slice(homePrefix.length) };

  const userPrefix = `${USER_REPO_PREFIX}/`;
  if (norm.startsWith(userPrefix)) return { root: "user", rel: norm.slice(userPrefix.length) };

  return undefined;
}

/**
 * Resolve a CursorTarget onto a CHECKED destination on the target machine.
 *
 * The `rel` half is repo-supplied, so it goes through the shared containment
 * gate rather than a bare `path.join`: no `..`/backslash/absolute segment may
 * escape the root, and a symlinked component below it refuses the write instead
 * of redirecting it. Callers decide what a refusal means — the planner drops the
 * action, the writers warn — so plan and execution cannot disagree.
 */
async function targetAbsFor(
  ctx: RestoreContext,
  target: CursorTarget,
  opts: ContainedTargetOptions = {},
): Promise<ContainedTarget> {
  const root =
    target.root === "home" ? ctx.toolHome : cursorUserPaths(ctx.toolHome, ctx.os, ctx.env).userDir;
  return resolveContainedTarget(ctx.fs, root, target.rel, opts);
}


/* -------------------------------------------------------------------------- */
/* Secret discovery in mcp.json                                                */
/* -------------------------------------------------------------------------- */

/**
 * Walk a parsed mcp.json shape and record SecretRefs for any secret VALUES found
 * under each MCP server's `env` / `headers` (the common spots for API keys and
 * tokens). This is METADATA ONLY for the user-facing "you'll need to re-supply"
 * report; the actual file stored in the repo is the sanitizer-redacted text. We
 * use the sanitizer's own JSON pass to decide what counts as secret so the two
 * stay consistent.
 */
function collectMcpSecretRefs(
  ctx: CaptureContext,
  parsed: unknown,
  source: string,
): SecretRef[] {
  const refs: SecretRef[] = [];
  if (parsed === null || typeof parsed !== "object") return refs;

  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== "object") return refs;

  for (const [serverName, rawServer] of Object.entries(servers as Record<string, unknown>)) {
    if (rawServer === null || typeof rawServer !== "object") continue;
    for (const bag of ["env", "headers"] as const) {
      const values = (rawServer as Record<string, unknown>)[bag];
      if (values === null || typeof values !== "object") continue;
      // Let the sanitizer judge each {key: value} object; any redaction it makes
      // means there was a secret value we should report.
      const { found } = ctx.sanitizer.sanitizeJson(values, "cursor", `${source}#mcpServers.${serverName}.${bag}`);
      for (const f of found) {
        refs.push({
          tool: "cursor",
          source: `${source}#mcpServers.${serverName}.${bag}.${f.key}`,
          key: f.key,
          description: `Cursor MCP server "${serverName}" ${bag} value — redacted; re-supply after restore.`,
          kind: "value",
        });
      }
    }
  }
  return refs;
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
  abs: string;
  rel: string;
  repoPath: string;
  files: CapturedFile[];
  secrets: SecretRef[];
  warnings: string[];
  scanMcpSecrets?: boolean;
}): Promise<void> {
  const { ctx, abs, rel, repoPath, files, secrets, warnings, scanMcpSecrets = false } = args;
  const mode = await readMode(abs);

  let bytes: Buffer;
  try {
    bytes = await ctx.fs.readBytes(abs);
  } catch (err) {
    warnings.push(`cursor: could not read ${rel}: ${(err as Error).message}`);
    return;
  }

  const decoded = decodeForCapture(bytes);

  if (decoded.kind === "binary") {
    // Fail-safe: never let a "binary" file smuggle a secret past the sanitizer.
    // Scan every lossy view (UTF-8 + UTF-16LE/BE at both alignments) — a NUL-
    // interleaved token is invisible to a UTF-8-only scan.
    if (!ctx.includeSecrets) {
      for (const view of binaryScanViews(bytes)) {
        const scan = ctx.sanitizer.sanitizeText(view, "cursor", rel);
        if (!scan.changed) continue;
        warnings.push(`cursor: skipped ${rel} — binary content with secret-shaped bytes`);
        secrets.push(...scan.found);
        return;
      }
    }
    const file: CapturedFile = {
      repoPath,
      content: bytes.toString("base64"),
      binary: true,
    };
    if (mode !== undefined) file.mode = mode;
    files.push(file);
    return;
  }

  // UTF-16 configs are decoded to text above (never the raw base64 branch).
  const raw = decoded.text;
  if (scanMcpSecrets) {
    try {
      secrets.push(...collectMcpSecretRefs(ctx, JSON.parse(raw), rel));
    } catch (err) {
      warnings.push(`cursor: could not parse ${rel} for secret scan: ${(err as Error).message}`);
    }
  }

  let content = raw;
  if (!ctx.includeSecrets) {
    const sanitized = ctx.sanitizer.sanitizeFile(raw, "cursor", rel);
    content = sanitized.content;
    secrets.push(...sanitized.found);
  }
  const templated = ctx.templater.toTemplate(content, ctx.vars);
  const file: CapturedFile = { repoPath, content: templated };
  if (mode !== undefined) file.mode = mode;
  files.push(file);
}

/** Recursively freeze a Cursor directory tree. */
async function walkFrozen(
  ctx: CaptureContext,
  root: string,
  abs: string,
  deny: string[],
  repoPathBuilder: (rel: string) => string,
  files: CapturedFile[],
  symlinks: CapturedSymlink[],
  secrets: SecretRef[],
  warnings: string[],
): Promise<void> {
  const kind = await ctx.fs.statKind(abs);
  if (kind === "missing") return;

  const rel = toRel(root, abs);
  if (rel && matchesDeny(rel, deny)) {
    ctx.log.debug(`cursor: skip (denylist) ${rel}`);
    return;
  }

  if (kind === "symlink") {
    const target = normalizeCapturedSymlinkTarget(await ctx.fs.readLink(abs));
    symlinks.push({ repoPath: repoPathBuilder(rel), target });
    ctx.log.debug(`cursor: symlink ${rel} -> ${target}`);
    return;
  }

  if (kind === "dir") {
    const entries = await ctx.fs.list(abs);
    entries.sort();
    for (const name of entries) {
      await walkFrozen(ctx, root, path.join(abs, name), deny, repoPathBuilder, files, symlinks, secrets, warnings);
    }
    return;
  }

  await captureFile({
    ctx,
    abs,
    rel,
    repoPath: repoPathBuilder(rel),
    files,
    secrets,
    warnings,
    scanMcpSecrets: rel === "mcp.json",
  });
}

/** Classify Cursor skills as reinstallable symlinks or frozen local skill dirs. */
async function captureSkills(
  ctx: CaptureContext,
  home: string,
  skillsDir: string,
  deny: string[],
  files: CapturedFile[],
  symlinks: CapturedSymlink[],
  skills: SkillEntry[],
  secrets: SecretRef[],
  warnings: string[],
): Promise<void> {
  if ((await ctx.fs.statKind(skillsDir)) !== "dir") return;

  const entries = await ctx.fs.list(skillsDir);
  entries.sort();

  for (const name of entries) {
    const abs = path.join(skillsDir, name);
    const rel = toRel(home, abs);
    if (matchesDeny(rel, deny)) continue;

    const kind = await ctx.fs.statKind(abs);
    if (kind === "symlink") {
      const target = normalizeCapturedSymlinkTarget(await ctx.fs.readLink(abs));
      symlinks.push({ repoPath: repoPathFor(rel), target });
      skills.push({
        name,
        source: "skills.sh",
        installCommand: `npx skills add ${name}`,
        symlinked: true,
      });
      continue;
    }

    if (kind === "dir") {
      skills.push({ name, source: "frozen", symlinked: false });
      await walkFrozen(ctx, home, abs, deny, repoPathFor, files, symlinks, secrets, warnings);
      continue;
    }

    if (kind === "file") {
      skills.push({ name, source: "frozen", symlinked: false });
      await walkFrozen(ctx, home, abs, deny, repoPathFor, files, symlinks, secrets, warnings);
    }
  }
}

function parseExtensionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) return undefined;
  return trimmed;
}

function parseCursorExtensionEntry(entry: unknown): PluginEntry | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const obj = entry as Record<string, unknown>;
  const identifier = obj.identifier;
  const identifierObj = identifier !== null && typeof identifier === "object"
    ? identifier as Record<string, unknown>
    : {};
  const id = parseExtensionId(identifierObj.id) ?? parseExtensionId(obj.id);
  if (id === undefined) return undefined;
  const version = typeof obj.version === "string" ? obj.version : undefined;
  return {
    id,
    name: id,
    version,
    enabled: true,
    scope: "user",
  };
}

function parseCursorExtensionsJson(raw: string): PluginEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const plugin = parseCursorExtensionEntry(entry);
    if (plugin === undefined || seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    out.push(plugin);
  }
  return out;
}

function parseCursorExtensionLine(line: string): PluginEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const at = trimmed.lastIndexOf("@");
  const id = at > 0 ? trimmed.slice(0, at) : trimmed;
  const version = at > 0 ? trimmed.slice(at + 1) : undefined;
  const parsedId = parseExtensionId(id);
  if (parsedId === undefined) return undefined;
  return {
    id: parsedId,
    name: parsedId,
    version: version && version.length > 0 ? version : undefined,
    enabled: true,
    scope: "user",
  };
}

/** Capture extension IDs without copying extension payloads. */
async function captureExtensions(ctx: CaptureContext, cursorHome: string, warnings: string[]): Promise<PluginEntry[]> {
  const extensionState = path.join(cursorHome, "extensions", "extensions.json");
  if ((await ctx.fs.statKind(extensionState)) === "file") {
    try {
      const fromState = parseCursorExtensionsJson(await ctx.fs.read(extensionState));
      if (fromState.length > 0) return fromState;
    } catch (err) {
      warnings.push(`cursor: could not read extensions metadata: ${(err as Error).message}`);
    }
  }

  if (!(await which(cliBinaryName("cursor")))) return [];

  try {
    const result = await execa(cliBinaryName("cursor"), ["--list-extensions", "--show-versions"], {
      stdin: "ignore",
      stderr: "ignore",
      stdout: "pipe",
      reject: false,
    });
    const plugins = result.stdout
      .split(/\r?\n/)
      .map(parseCursorExtensionLine)
      .filter((plugin): plugin is PluginEntry => plugin !== undefined);
    const seen = new Set<string>();
    return plugins.filter((plugin) => {
      if (seen.has(plugin.id)) return false;
      seen.add(plugin.id);
      return true;
    });
  } catch (err) {
    warnings.push(`cursor: could not list extensions via CLI: ${(err as Error).message}`);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Capture the Cursor setup into a CaptureResult.
 *
 * Exported (like the Claude/Codex capture modules) so the backup command can
 * call it with the R9 `opts` directly; the Adapter.capture wrapper below is the
 * default (no-opts) path.
 *
 * @param opts.skipInstructions accepted for signature parity with the other
 *        adapters (R9). Cursor never emits a CLAUDE.md/AGENTS.md frozen file, so
 *        this flag is a no-op here — the shared rule is deployed on RESTORE.
 */
export async function capture(
  ctx: CaptureContext,
  _opts?: { skipInstructions?: boolean },
): Promise<CaptureResult> {
  const files: CapturedFile[] = [];
  const symlinks: CapturedSymlink[] = [];
  const secrets: SecretRef[] = [];
  const warnings: string[] = [];
  const manifest = emptyManifest("cursor");

  const p = paths(ctx.toolHome);
  const userPaths = cursorUserPaths(p.home, ctx.os, ctx.env);
  const deny = denylistFor("cursor");

  // Graceful absence: Cursor may not be installed at all. Never block the rest
  // of the backup — return an empty result with a single explanatory warning.
  const hasToolHome = (await ctx.fs.statKind(p.home)) === "dir";
  const hasUserDir = (await ctx.fs.statKind(userPaths.userDir)) === "dir";
  if (!hasToolHome && !hasUserDir) {
    warnings.push("cursor: no ~/.cursor or Cursor User data found; skipping (Cursor not installed?).");
    return { tool: "cursor", files, symlinks, manifest, secrets, warnings };
  }

  if (hasToolHome) {
    for (const rel of FROZEN_PATHS) {
      const abs = path.join(p.home, rel);
      if (rel === "skills") {
        await captureSkills(ctx, p.home, abs, deny, files, symlinks, manifest.skills, secrets, warnings);
      } else {
        await walkFrozen(ctx, p.home, abs, deny, repoPathFor, files, symlinks, secrets, warnings);
      }
    }
    manifest.plugins = await captureExtensions(ctx, p.home, warnings);
  }

  if (hasUserDir) {
    const userItems = [userPaths.settingsJson, userPaths.keybindingsJson, userPaths.snippetsDir] as const;
    for (const abs of userItems) {
      await walkFrozen(ctx, userPaths.userDir, abs, deny, userRepoPathFor, files, symlinks, secrets, warnings);
    }
  }

  if (files.length === 0 && symlinks.length === 0 && manifest.plugins.length === 0) {
    warnings.push("cursor: present but nothing portable to capture.");
  }

  return { tool: "cursor", files, symlinks, manifest, secrets, warnings };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write a single CapturedFile onto the target tool home, rehydrating
 * {{TOKENS}} -> machine paths for text content. Respects ctx.sourceOfTruth:
 * when the local machine is the source of truth we do NOT clobber an existing
 * local file (the repo only "wins" when sourceOfTruth === "repo").
 */
async function writeRestoredFile(ctx: RestoreContext, file: CapturedFile): Promise<void> {
  const target = targetFromRepoPath(file.repoPath);
  if (target === undefined) {
    ctx.log.debug(`cursor: ignoring foreign repoPath ${file.repoPath}`);
    return;
  }
  const resolved = await targetAbsFor(ctx, target);
  if (!resolved.ok) {
    ctx.log.warn(`cursor: refusing to write ${file.repoPath} — ${resolved.reason}`);
    return;
  }
  const dest = resolved.path;

  if (ctx.sourceOfTruth === "local" && (await ctx.fs.exists(dest))) {
    ctx.log.debug(`cursor: keep local ${target.rel} (sourceOfTruth=local)`);
    return;
  }

  // Rename-based writers: the containment check and the write cannot be one
  // operation, and a plain write follows a link that appears at the leaf in the
  // gap. `rename` replaces that entry instead.
  if (file.binary) {
    await ctx.fs.writeBytesAtomic(dest, Buffer.from(file.content, "base64"), file.mode);
    return;
  }

  const expanded = ctx.templater.fromTemplate(file.content, ctx.vars);
  await ctx.fs.writeAtomic(dest, expanded, file.mode);
}

/** Recreate a captured symlink under ~/.cursor or Cursor User data. */
async function writeRestoredSymlink(ctx: RestoreContext, link: CapturedSymlink): Promise<void> {
  const target = targetFromRepoPath(link.repoPath);
  if (target === undefined) {
    ctx.log.debug(`cursor: ignoring foreign symlink ${link.repoPath}`);
    return;
  }
  const resolved = await targetAbsFor(ctx, target, { allowLeafSymlink: true });
  if (!resolved.ok) {
    ctx.log.warn(`cursor: refusing to link ${link.repoPath} — ${resolved.reason}`);
    return;
  }
  const dest = resolved.path;

  if (ctx.sourceOfTruth === "local" && (await ctx.fs.statKind(dest)) !== "missing") {
    ctx.log.debug(`cursor: keep local symlink ${target.rel} (sourceOfTruth=local)`);
    return;
  }

  await ctx.fs.symlink(link.target, dest);
}

/** Best-effort Cursor extension reinstall via the `cursor` CLI. */
async function reinstallExtensions(ctx: RestoreContext, plugins: PluginEntry[]): Promise<void> {
  const userPlugins = plugins.filter((plugin) => plugin.scope === "user");
  if (userPlugins.length === 0) return;

  const cursorBin = cliBinaryName("cursor");
  if (!(await which(cursorBin))) {
    ctx.log.warn(
      "cursor CLI not found; extension IDs were restored in manifest.json, but extensions were not installed.",
    );
    return;
  }

  for (const plugin of userPlugins) {
    try {
      const result = await execa(cursorBin, ["--install-extension", plugin.id], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        reject: false,
      });
      if (result.exitCode === 0) {
        ctx.log.step(`cursor: installed extension ${plugin.id}`);
      } else {
        const stderr = result.stderr.trim();
        ctx.log.warn(
          `cursor: failed to install extension ${plugin.id}${stderr ? ` (${stderr})` : ""}`,
        );
      }
    } catch (err) {
      ctx.log.warn(`cursor: failed to install extension ${plugin.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Build the list of restore actions WITHOUT executing them (for --dry-run and
 * safety-backup sizing).
 */
export async function planActions(
  ctx: RestoreContext,
  data: RestoreData,
): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];

  for (const file of data.files) {
    const target = targetFromRepoPath(file.repoPath);
    if (target === undefined) continue;
    const resolved = await targetAbsFor(ctx, target);
    if (!resolved.ok) continue;
    const targetPath = resolved.path;
    const overwrites = await ctx.fs.exists(targetPath);
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-file",
      tool: "cursor",
      targetPath,
      description: `Write ${target.root === "user" ? "User/" : ""}${target.rel}`,
      overwrites,
    });
  }

  for (const link of data.symlinks) {
    const target = targetFromRepoPath(link.repoPath);
    if (target === undefined) continue;
    const resolved = await targetAbsFor(ctx, target, { allowLeafSymlink: true });
    if (!resolved.ok) continue;
    const targetPath = resolved.path;
    const overwrites = (await ctx.fs.statKind(targetPath)) !== "missing";
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-symlink",
      tool: "cursor",
      targetPath,
      description: `Link ${target.root === "user" ? "User/" : ""}${target.rel} -> ${link.target}`,
      overwrites,
    });
  }

  for (const plugin of data.manifest.plugins.filter((p) => p.scope === "user")) {
    actions.push({
      type: "install-plugin",
      tool: "cursor",
      description: `cursor --install-extension ${plugin.id}`,
    });
  }

  return actions;
}

/**
 * Restore Cursor: place frozen files/User data back, recreate symlinks, and
 * best-effort install extensions. Honors ctx.dryRun (plan only). Exported for
 * direct use by the restore command + the Adapter wrapper below.
 */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  if (ctx.dryRun) {
    const actions = await planActions(ctx, data);
    for (const action of actions) ctx.log.step(action.description);
    return;
  }

  for (const file of data.files) {
    try {
      await writeRestoredFile(ctx, file);
    } catch (err) {
      ctx.log.warn(`cursor: failed to write ${file.repoPath}: ${(err as Error).message}`);
    }
  }

  for (const link of data.symlinks) {
    try {
      await writeRestoredSymlink(ctx, link);
    } catch (err) {
      ctx.log.warn(`cursor: failed to create symlink ${link.repoPath}: ${(err as Error).message}`);
    }
  }

  await reinstallExtensions(ctx, data.manifest.plugins);
}

/* -------------------------------------------------------------------------- */
/* Detect / CLI                                                                */
/* -------------------------------------------------------------------------- */

/** True if ~/.cursor or Cursor's application User data exists. */
async function detect(): Promise<boolean> {
  const p = paths();
  return (
    (await fsExistsDir(p.home)) ||
    (await fsExistsDir(cursorUserPaths(p.home, detectOS(), process.env).userDir))
  );
}

/** Local lstat-free existence-as-dir probe via the default fs service. */
async function fsExistsDir(p: string): Promise<boolean> {
  // Use a dynamic import of the default fs service to avoid threading a ctx into
  // detect()/isCliInstalled(), which the Adapter interface calls without a ctx.
  const { fs } = await import("../../utils/fs.js");
  return (await fs.statKind(p)) === "dir";
}

/** True if the `cursor` CLI resolves on PATH. */
async function isCliInstalled(): Promise<boolean> {
  return which(cliBinaryName("cursor"));
}

/**
 * Install the Cursor app/CLI for the given OS. brew --cask cursor (darwin),
 * winget (win32). On Linux there is no standard headless install -> warn + skip
 * (installCommandFor returns null there). Never throws on the unsupported path.
 */
async function installCli(os: OS): Promise<void> {
  const cmd = installCommandFor("cursor", os);
  if (cmd === null) {
    const { log } = await import("../../utils/log.js");
    log.warn("cursor: no headless install available on this OS — install Cursor manually from cursor.com.");
    return;
  }
  await runInstall(cmd);
}

/* -------------------------------------------------------------------------- */
/* The Adapter object                                                          */
/* -------------------------------------------------------------------------- */

export const cursorAdapter: Adapter = {
  id: "cursor",
  displayName: "Cursor",
  detect,
  isCliInstalled,
  installCli,
  // The R9 `skipInstructions` variant is NOT exposed on the Adapter interface
  // (capture(ctx) takes no opts there). The backup command imports the exported
  // `capture(ctx, { skipInstructions })` above directly when shared instructions
  // are active; this wrapper is the default path.
  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    return capture(ctx);
  },
  async restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
    return restore(ctx, data);
  },
};

export default cursorAdapter;
