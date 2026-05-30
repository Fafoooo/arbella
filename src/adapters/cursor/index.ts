/**
 * The Cursor adapter — implements the Adapter contract for Cursor.
 *
 * Cursor is a desktop app; its CLI may be entirely absent (notably on Linux,
 * where there is no headless install). This adapter is therefore deliberately
 * MINIMAL but real, and FULLY GRACEFUL when ~/.cursor does not exist:
 *
 *   - detect():        true only if ~/.cursor exists (returns false cleanly,
 *                      never throws, when the dir is missing).
 *   - isCliInstalled():probes `cursor` on PATH (often false on this kind of box).
 *   - installCli(os):  brew --cask cursor (darwin) / winget (win32); on Linux
 *                      there is no standard install -> warn + skip (no throw).
 *   - capture(ctx):    if Cursor is absent, returns an EMPTY CaptureResult with a
 *                      single warning (so backup of the other tools is never
 *                      blocked). Otherwise freezes ~/.cursor/mcp.json, sanitized
 *                      (secret values redacted) + templated (machine paths ->
 *                      {{HOME}}/...). MCP server entries whose env/headers held
 *                      secret values are recorded as SecretRefs (metadata only;
 *                      the redacted file is what gets stored).
 *   - restore(ctx,d):  writes the frozen files back onto ~/.cursor (rehydrating
 *                      {{TOKENS}} -> machine paths). When the backup repo carried
 *                      shared instructions (R9), also materializes a Cursor user
 *                      rule from <repoRoot>/shared/instructions.md so the single
 *                      CLAUDE.md == AGENTS.md content reaches Cursor too.
 *
 * All fs work goes through the injected CoreServices on the context objects, so
 * the adapter is unit-testable against a fixture dir. No direct node:fs, no clock.
 * Non-fatal problems are surfaced via the warnings array / log.warn, never thrown.
 */

import path from "node:path";

import type { Adapter, CaptureContext, RestoreContext, RestoreData } from "../adapter.interface.js";
import type {
  CaptureResult,
  CapturedFile,
  CapturedSymlink,
  OS,
  SecretRef,
  ToolManifest,
} from "../../types.js";

import { denylistFor, matchesDeny } from "../../core/sanitizer/denylist.js";
import { cliBinaryName, installCommandFor } from "../../platform/os.js";
import { runInstall, which } from "../../platform/install.js";

import {
  FROZEN_PATHS,
  REPO_PREFIX,
  SHARED_INSTRUCTIONS_REPO_PATH,
  paths,
  sharedRulePath,
} from "./paths.js";

/* -------------------------------------------------------------------------- */
/* Small local helpers (mirroring the Claude/Codex adapter conventions)        */
/* -------------------------------------------------------------------------- */

/** Build the repo path for a tool-home-relative POSIX path. */
function repoPathFor(rel: string): string {
  return `${REPO_PREFIX}/${rel}`;
}

/** Convert an absolute child path under `home` into a POSIX rel path. */
function toRel(home: string, abs: string): string {
  return path.relative(home, abs).split(path.sep).join("/");
}

/** Strip the leading "cursor/files/" prefix from a repoPath. Returns the POSIX
 * tail relative to the tool home, or undefined if the path is not ours. */
function relFromRepoPath(repoPath: string): string | undefined {
  const norm = repoPath.replace(/\\/g, "/");
  const prefix = `${REPO_PREFIX}/`;
  if (!norm.startsWith(prefix)) return undefined;
  return norm.slice(prefix.length);
}

/** Heuristic: treat a file as binary if its bytes contain a NUL. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** An empty manifest for cursor (all arrays empty). Kept inline so the adapter
 * does not depend on the manifest module's internals. */
function emptyCursorManifest(): ToolManifest {
  return {
    tool: "cursor",
    plugins: [],
    marketplaces: [],
    skills: [],
    npmGlobals: [],
    enabledPlugins: {},
  };
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
  const manifest = emptyCursorManifest();

  const p = paths(ctx.toolHome);
  const deny = denylistFor("cursor");

  // Graceful absence: Cursor may not be installed at all. Never block the rest
  // of the backup — return an empty result with a single explanatory warning.
  if ((await ctx.fs.statKind(p.home)) !== "dir") {
    warnings.push("cursor: ~/.cursor not found; skipping (Cursor not installed?).");
    return { tool: "cursor", files, symlinks, manifest, secrets, warnings };
  }

  for (const rel of FROZEN_PATHS) {
    const abs = path.join(p.home, rel);
    const relPosix = toRel(p.home, abs);

    if (matchesDeny(relPosix, deny)) {
      ctx.log.debug(`cursor: skip (denylist) ${relPosix}`);
      continue;
    }

    const kind = await ctx.fs.statKind(abs);
    if (kind === "missing") {
      ctx.log.debug(`cursor: not present ${relPosix}`);
      continue;
    }
    if (kind !== "file") {
      // The minimal Cursor adapter only freezes top-level files (mcp.json).
      ctx.log.debug(`cursor: skip non-file ${relPosix}`);
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await ctx.fs.readBytes(abs);
    } catch (err) {
      warnings.push(`cursor: could not read ${relPosix}: ${(err as Error).message}`);
      continue;
    }

    if (looksBinary(bytes)) {
      // Unexpected for mcp.json, but stay robust: store as base64.
      files.push({ repoPath: repoPathFor(relPosix), content: bytes.toString("base64"), binary: true });
      continue;
    }

    const raw = bytes.toString("utf8");

    // For mcp.json: discover secret refs from the parsed shape BEFORE redaction,
    // so we can tell the user which MCP server env/header to re-supply.
    if (relPosix === "mcp.json") {
      try {
        secrets.push(...collectMcpSecretRefs(ctx, JSON.parse(raw), relPosix));
      } catch (err) {
        warnings.push(`cursor: could not parse mcp.json for secret scan: ${(err as Error).message}`);
      }
    }

    // Sanitize secret VALUES (unless includeSecrets opts INTO carrying them),
    // then template machine paths to placeholders.
    //
    // sanitizeFile routes mcp.json through the STRUCTURAL key-name-aware sanitizer
    // so an opaque MCP env/header secret stored under a secret KEY NAME (e.g.
    // ACME_API_KEY with a custom-shaped value) is redacted before it is stored,
    // not just values matching a known token regex.
    //
    // When ctx.includeSecrets is ON (opt-in, default OFF), the documented switch
    // carries the real MCP secret values into the PRIVATE repo (we still recorded
    // the SecretRefs above so the user is told which ones are now present).
    const content = ctx.includeSecrets
      ? raw
      : ctx.sanitizer.sanitizeFile(raw, "cursor", relPosix).content;
    const templated = ctx.templater.toTemplate(content, ctx.vars);
    files.push({ repoPath: repoPathFor(relPosix), content: templated });
    ctx.log.debug(`cursor: froze ${relPosix}`);
  }

  if (files.length === 0) {
    warnings.push("cursor: present but nothing portable to capture (no mcp.json).");
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
  const rel = relFromRepoPath(file.repoPath);
  if (rel === undefined) {
    ctx.log.debug(`cursor: ignoring foreign repoPath ${file.repoPath}`);
    return;
  }
  const dest = path.join(ctx.toolHome, ...rel.split("/"));

  if (ctx.sourceOfTruth === "local" && (await ctx.fs.exists(dest))) {
    ctx.log.debug(`cursor: keep local ${rel} (sourceOfTruth=local)`);
    return;
  }

  if (file.binary) {
    await ctx.fs.writeBytes(dest, Buffer.from(file.content, "base64"), file.mode);
    return;
  }

  const expanded = ctx.templater.fromTemplate(file.content, ctx.vars);
  await ctx.fs.write(dest, expanded, file.mode);
}

/**
 * Deploy the shared-instructions (R9) content as a Cursor user rule. Reads
 * <repoRoot>/shared/instructions.md (if present) and writes it under the Cursor
 * rules dir. Best-effort: absence of the shared file is not an error.
 */
async function deploySharedRule(ctx: RestoreContext): Promise<void> {
  const sharedAbs = path.join(ctx.repoRoot, ...SHARED_INSTRUCTIONS_REPO_PATH.split("/"));
  if (!(await ctx.fs.exists(sharedAbs))) {
    ctx.log.debug("cursor: no shared/instructions.md to deploy as a Cursor rule.");
    return;
  }
  const body = await ctx.fs.read(sharedAbs);
  // Cursor `.mdc` rules support frontmatter; `alwaysApply: true` makes the rule
  // global. The instructions content is plain markdown and needs no templating.
  const rule = `---\ndescription: Shared agent instructions (managed by arbella)\nalwaysApply: true\n---\n\n${body}`;
  const dest = sharedRulePath(ctx.toolHome);
  await ctx.fs.write(dest, rule);
  ctx.log.debug(`cursor: wrote shared-instructions rule -> ${dest}`);
}

/**
 * Restore Cursor: place frozen files back, then (if the repo carried shared
 * instructions) materialize the Cursor user rule. Honors ctx.dryRun (plan only).
 * Exported for direct use by the restore command + the Adapter wrapper below.
 */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  if (ctx.dryRun) {
    for (const file of data.files) {
      const rel = relFromRepoPath(file.repoPath);
      if (rel) ctx.log.step(`cursor: would write ${path.join(ctx.toolHome, ...rel.split("/"))}`);
    }
    const sharedAbs = path.join(ctx.repoRoot, ...SHARED_INSTRUCTIONS_REPO_PATH.split("/"));
    if (await ctx.fs.exists(sharedAbs)) {
      ctx.log.step(`cursor: would write shared-instructions rule -> ${sharedRulePath(ctx.toolHome)}`);
    }
    return;
  }

  for (const file of data.files) {
    try {
      await writeRestoredFile(ctx, file);
    } catch (err) {
      ctx.log.warn(`cursor: failed to write ${file.repoPath}: ${(err as Error).message}`);
    }
  }

  // R9: deploy the shared CLAUDE.md == AGENTS.md content as a Cursor rule.
  try {
    await deploySharedRule(ctx);
  } catch (err) {
    ctx.log.warn(`cursor: failed to deploy shared-instructions rule: ${(err as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Detect / CLI                                                                */
/* -------------------------------------------------------------------------- */

/** True if ~/.cursor exists. Graceful: returns false (never throws) if absent. */
async function detect(): Promise<boolean> {
  return fsExistsDir(paths().home);
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
