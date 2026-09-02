/**
 * `shared/home` capture: files that live in $HOME but OUTSIDE every tool home.
 *
 * Three kinds of file reach this module:
 *   1. LINKED SCRIPTS — the hook dispatchers, statusline scripts and MCP server
 *      launchers a tool config points at (`~/.agents/hooks/dispatch.sh`,
 *      `~/.local/bin/serena-mcp-start`). The adapters find them with the pure
 *      scanner (scan.ts) and hand the absolute paths over here.
 *   2. COMPANION FILES — a plugin's own config dir next to a tool home, e.g.
 *      `~/.claude-mem/settings.json`: the plugin reinstalls from the manifest
 *      but its configuration lives outside ~/.claude and would be lost.
 *   3. `config.extraPaths` — anything the user explicitly told arbella to carry.
 *      Unlike the first two, an extraPaths entry MAY point inside a tool home
 *      (e.g. `~/.claude/.agents`, a third-party dir `status` cannot otherwise
 *      carry) — the user named it explicitly, so the usual tool-home exclusion
 *      does not apply to this kind.
 *
 * All three land at `shared/home/<path relative to $HOME>` and restore to
 * `$HOME/<same>` on the target machine (see restore.ts).
 *
 * SECURITY. $HOME is a far more dangerous walk than a tool home, so this module
 * is defensive by construction:
 *   - a path must be UNDER $HOME. A LINKED SCRIPT or COMPANION FILE must also
 *     stay OUT of every tool home (those are already captured by the tool
 *     itself, and duplicating them would double every file) — enforced via
 *     {@link HomeCaptureOptions.excludeRoots}. `extraPaths` is the one
 *     exception (see above): {@link captureExtraPaths} passes `excludeRoots:
 *     []` so it may reach inside a tool home, and instead dedupes against
 *     what the tool ALREADY captured this run via
 *     {@link HomeCaptureOptions.alreadyCaptured} (an absolute-path set the
 *     caller derives from this run's CaptureResults with
 *     {@link computeAlreadyCaptured});
 *   - symlinks are skipped — their targets are machine-specific (WP-C records
 *     the binaries behind them as external tools instead) — and a file whose
 *     PARENT is a symlink is judged by where it REALLY lives: both the
 *     under-$HOME test and the denylist are re-run on the realpath, so
 *     `~/link/.ssh/id_rsa` cannot enter through a link the way `~/.ssh/id_rsa`
 *     cannot enter directly;
 *   - {@link HOME_DENY} is checked BEFORE the file is read, so `.env`, `id_rsa`,
 *     `.netrc`, `.git-credentials` and friends are never even opened;
 *   - 1 MiB per file / 2000 files per tree caps keep a stray `~/Downloads`-sized
 *     directory out of a git repo;
 *   - text content goes through `sanitizeFile` (unless `includeSecrets`), and
 *     binary content is DROPPED when a fail-safe scan finds secret-shaped bytes
 *     — byte-for-byte the same treatment claude/capture.ts gives a tool file.
 *
 * TEMPLATING. Home files are templated WITHOUT `{{TOOL_HOME}}`: they live
 * outside every tool home, so folding a `~/.claude/...` mention inside them to a
 * tool-specific token would make the stored file depend on which adapter
 * happened to capture it. `{{HOME}}` / `{{USER}}` are unambiguous and restore
 * hydrates them with no tool context at all.
 *
 * All I/O goes through the injected CoreServices; the single node:fs use is the
 * documented lstat exception (mode + size in one call, before any read).
 */

import path from "node:path";

import { binaryScanViews, decodeForCapture } from "../../utils/capture-bytes.js";
import type { CoreServices } from "../../adapters/adapter.interface.js";
import type {
  CaptureResult,
  CapturedFile,
  SecretRef,
  TemplateVariables,
  ToolId,
} from "../../types.js";
import { TOOL_IDS } from "../../types.js";
import { toolHomeDir } from "../../platform/os.js";
import { COMMON_DENY, firstMatchingDeny, matchesDeny } from "../sanitizer/denylist.js";

import type { CommandRef } from "./scan.js";
import {
  expandHomePath,
  extractHomePathCandidates,
  homeRelativePosix,
  isUnderHome,
  joinUnderHome,
} from "./scan.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Repo prefix (POSIX) for every file this module emits. */
export const SHARED_HOME_REPO_PREFIX = "shared/home";

/** Hard per-file size cap. A config/script above this is not a config/script. */
export const MAX_HOME_FILE_BYTES = 1024 * 1024;

/** Hard per-tree file cap, so one wrong `extraPaths` entry cannot flood a repo. */
export const MAX_HOME_TREE_FILES = 2000;

/**
 * The denylist for $HOME files. COMMON_DENY (OS cruft, vendored runtimes,
 * databases, backup droppings) plus every credential-shaped filename that lives
 * loose in a home directory. This list is the reason a hook can reference
 * `~/.env` and still never have it captured: the check runs on the path, before
 * the file is opened.
 */
export const HOME_DENY: readonly string[] = [
  ...COMMON_DENY,
  // Whole directories that exist to hold credentials. Denying the DIRECTORY is
  // what makes these safe: their contents are named arbitrarily ("config",
  // "hosts.yml", "known_hosts"), so no filename rule would ever catch them all.
  ".ssh/",
  ".gnupg/",
  ".aws/",
  ".azure/",
  ".kube/",
  ".docker/", // covers .docker/config.json (registry auth)
  ".config/gcloud/",
  ".config/gh/",
  ".config/hub/",
  ".config/rclone/",
  ".password-store/",
  "Library/Keychains/",
  ".local/share/keyrings/",
  // Browser profiles: cookies, saved passwords, session tokens.
  ".mozilla/",
  ".config/google-chrome/",
  ".config/BraveSoftware/",
  // Environment / dotenv files (secrets by convention). "*.env" catches the
  // project-prefixed spelling (`gsc.env`) that ".env"/".env.*" both miss.
  ".env",
  ".env.*",
  "*.env",
  // Keys, certificates and key stores.
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cer",
  "*.p8",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*.gpg",
  "*.asc",
  // SSH private keys, by their conventional ssh-keygen basenames. Explicit
  // per-algorithm instead of a blanket "id_*": that pattern also ate any
  // "id_"-prefixed file a hook might legitimately reference (a lookup script
  // named "id_lookup.sh", say), which is not a key at all. ".ssh/" above
  // already denies the default keychain location wholesale; these patterns
  // catch a key exported or copied somewhere else in $HOME.
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "id_ed25519_sk*",
  "id_ecdsa_sk*",
  // Credential stores.
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".vault-token",
  ".pgpass",
  ".my.cnf",
  ".boto",
  ".s3cfg",
  ".m2/settings.xml",
  "credentials*.json",
  "auth.json",
  ".credentials.json",
  ".claude.json",
  "*.token",
  // Shell/tool history: full of pasted tokens, and worthless in a backup.
  "*_history",
  ".*_history",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".lesshst",
  ".wget-hsts",
  // Databases / logs / vendored trees (belt and braces over COMMON_DENY).
  "*.sqlite*",
  "*.db*",
  "*.log",
  ".venv/",
  "node_modules/",
  ".git/",
  "__pycache__/",
];

/** Mutable view of {@link HOME_DENY} for `matchesDeny`, which takes `string[]`. */
const HOME_DENY_PATTERNS: string[] = [...HOME_DENY];

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** The services this module needs: CoreServices plus the secrets opt-in. */
export interface HomeCaptureContext extends CoreServices {
  /** When true, inline secret VALUES are carried verbatim (config.includeSecrets). */
  includeSecrets: boolean;
}

/** Accumulators a capture pass appends to (mirrors CaptureResult's fields). */
export interface HomeCaptureOut {
  files: CapturedFile[];
  secrets: SecretRef[];
  warnings: string[];
}

/** Knobs the caller must supply explicitly (so tests can inject fixture roots). */
export interface HomeCaptureOptions {
  /**
   * Absolute roots whose contents must NEVER be duplicated into shared/home —
   * every tool home. Passed in rather than derived so a test can point them at
   * fixture dirs; see {@link homeExcludeRoots} for the production value.
   */
  excludeRoots: readonly string[];
  /** Per-tree file cap. Defaults to {@link MAX_HOME_TREE_FILES}. */
  maxFiles?: number;
  /**
   * Absolute paths already carried into the backup by a tool's OWN capture
   * this run (derive with {@link computeAlreadyCaptured}). Only consulted by
   * {@link captureHomeFile} — it is how {@link captureExtraPaths} avoids
   * re-capturing a file the tool itself already froze, now that it is
   * allowed to walk inside a tool home. Absent/undefined for the linked-
   * script and companion-file passes, which rely on `excludeRoots` instead.
   */
  alreadyCaptured?: ReadonlySet<string>;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every tool home on THIS machine, plus the caller's own tool home first.
 *
 * `extra` matters for tests and for any run where the adapter's home was
 * overridden: `toolHomeDir()` always answers for the live machine, so a fixture
 * home would otherwise not be recognized as "already captured".
 */
export function homeExcludeRoots(extra?: string): string[] {
  const roots = TOOL_IDS.map((id) => toolHomeDir(id));
  if (extra !== undefined && extra.trim() !== "" && !roots.includes(extra)) {
    roots.unshift(extra);
  }
  return roots;
}

/** True when `abs` is one of `roots` or lives underneath one of them. */
function isUnderAnyRoot(abs: string, roots: readonly string[]): boolean {
  return roots.some((root) => abs === root || isUnderHome(abs, root));
}

/** The captured content is templated without {{TOOL_HOME}} — see the header. */
function portableVars(vars: TemplateVariables): TemplateVariables {
  const { TOOL_HOME: _toolHome, ...rest } = vars;
  return rest;
}

/** True when a repoPath belongs to the shared/home root. */
export function isSharedHomePath(repoPath: string): boolean {
  return repoPath.startsWith(`${SHARED_HOME_REPO_PREFIX}/`);
}

/**
 * True when `reason` names an EXPLICIT reference to a file — a linked script
 * (`linked:`), a plugin companion config (`companion:`), or a named
 * `config.extraPaths` FILE entry (`extraPaths-file:`) — as opposed to a file
 * merely encountered while walking a directory (`extraPaths:` during a tree
 * walk). Explicit references get a visible warning when the denylist blocks
 * them: the user (or their config) named this exact file, so silently
 * dropping it would leave them wondering why restore doesn't work. A stray
 * `.env` turned up by walking an extraPaths directory was never singled out,
 * so that stays a debug line — see {@link captureHomeFile}.
 */
function isExplicitReference(reason: string): boolean {
  return (
    reason.startsWith("linked:") ||
    reason.startsWith("companion:") ||
    reason.startsWith("extraPaths-file:")
  );
}

/** Strip an explicit-reference reason's category prefix for warning text. */
function describeReasonSource(reason: string): string {
  const idx = reason.indexOf(":");
  return idx === -1 ? reason : reason.slice(idx + 1);
}

/** Keep the FIRST entry for each repoPath, preserving order. */
export function dedupeByRepoPath(files: readonly CapturedFile[]): CapturedFile[] {
  const seen = new Set<string>();
  const out: CapturedFile[] = [];
  for (const file of files) {
    if (seen.has(file.repoPath)) continue;
    seen.add(file.repoPath);
    out.push(file);
  }
  return out;
}

/**
 * Best-effort POSIX mode + byte size for a path, read with a single lstat.
 *
 * This is the documented node:fs exception (FsService intentionally exposes no
 * stat surface). lstat, never stat: the caller has already established the path
 * is a regular file and must not follow anything.
 */
async function lstatInfo(abs: string): Promise<{ mode?: number; size: number }> {
  try {
    const { promises: fsp } = await import("node:fs");
    const st = await fsp.lstat(abs);
    return { mode: st.mode & 0o777, size: st.size };
  } catch {
    return { size: 0 };
  }
}

/* -------------------------------------------------------------------------- */
/* Single file                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Capture ONE file from $HOME into `shared/home/<rel>`.
 *
 * Most rejection paths are quiet-by-design (a debug line): a file merely
 * encountered while walking a tree was never singled out, so its skip is not
 * the user's business. Three rejections ARE surfaced in `out.warnings`: an
 * oversized file, an unreadable one, and a denylist hit on a file the caller
 * explicitly named — a linked script, a companion config, or a named
 * `extraPaths` FILE entry (see {@link isExplicitReference}) — since silently
 * dropping something the user pointed at by name would leave them wondering
 * why restore doesn't work. `reason` explains WHY the file was reached and
 * otherwise appears in the debug log only — CapturedFile deliberately carries
 * no such field, so the repo format stays exactly as it was.
 */
export async function captureHomeFile(
  ctx: HomeCaptureContext,
  abs: string,
  tool: ToolId,
  reason: string,
  out: HomeCaptureOut,
  opts: HomeCaptureOptions,
): Promise<void> {
  const home = ctx.vars.HOME;
  const rel = homeRelativePosix(home, abs);
  if (rel === null) {
    ctx.log.debug(`home: skip ${abs} (not under $HOME) [${reason}]`);
    return;
  }
  if (isUnderAnyRoot(abs, opts.excludeRoots)) {
    ctx.log.debug(`home: skip ${rel} (already captured with its tool) [${reason}]`);
    return;
  }
  if (opts.alreadyCaptured?.has(abs) === true) {
    ctx.log.debug(`home: skip ${rel} (already captured with its tool) [${reason}]`);
    return;
  }

  const repoPath = `${SHARED_HOME_REPO_PREFIX}/${rel}`;
  if (out.files.some((f) => f.repoPath === repoPath)) {
    ctx.log.debug(`home: skip ${rel} (already captured this run) [${reason}]`);
    return;
  }

  const denyMatch = firstMatchingDeny(rel, HOME_DENY_PATTERNS);
  if (denyMatch !== null) {
    if (isExplicitReference(reason)) {
      out.warnings.push(
        `home: not carrying ~/${rel} (matches the home denylist: ${denyMatch}) — ` +
          `referenced by ${describeReasonSource(reason)}`,
      );
    } else {
      ctx.log.debug(`home: skip ${rel} (denylist) [${reason}]`);
    }
    return;
  }

  const kind = await ctx.fs.statKind(abs);
  if (kind === "symlink") {
    // The link target is machine-specific; carrying the link would restore a
    // dangling path. WP-C records the binary behind it as an external tool.
    ctx.log.debug(`home: skip ${rel} (symlink) [${reason}]`);
    return;
  }
  if (kind !== "file") {
    ctx.log.debug(`home: skip ${rel} (${kind}) [${reason}]`);
    return;
  }

  // Everything above judged the path AS WRITTEN. `~/link/x` is an ordinary file
  // whose PARENT is a link — the statKind above says "file" and the deny check
  // above ran on a path that means nothing. So resolve where the file really
  // lives and re-ask both questions there. Realpath on BOTH sides: on macOS
  // $HOME itself routinely sits under a symlinked /var, and comparing a resolved
  // path against an unresolved home would reject every single file.
  const realHome = await ctx.fs.realPath(home);
  const realAbs = await ctx.fs.realPath(abs);
  if (realAbs !== abs || realHome !== home) {
    const realRel = homeRelativePosix(realHome, realAbs);
    if (realRel === null) {
      ctx.log.debug(`home: skip ${rel} (resolves to ${realAbs}, outside $HOME) [${reason}]`);
      return;
    }
    if (matchesDeny(realRel, HOME_DENY_PATTERNS)) {
      ctx.log.debug(`home: skip ${rel} (denylist via real path ${realRel}) [${reason}]`);
      return;
    }
  }

  const { mode, size } = await lstatInfo(abs);
  if (size > MAX_HOME_FILE_BYTES) {
    out.warnings.push(
      `home: skipped ~/${rel} — ${Math.round(size / 1024)} KiB exceeds the ` +
        `${MAX_HOME_FILE_BYTES / 1024} KiB limit for carried home files`,
    );
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await ctx.fs.readBytes(abs);
  } catch (err) {
    out.warnings.push(`home: could not read ~/${rel}: ${(err as Error).message}`);
    return;
  }

  const decoded = decodeForCapture(bytes);

  if (decoded.kind === "binary") {
    // Fail-safe, identical to the tool-file path: scan every lossy view (UTF-8 +
    // UTF-16LE/BE at both alignments) so a NUL-interleaved token cannot ride
    // along inside an opaque blob. Secret-shaped bytes => drop the file.
    if (
      !ctx.includeSecrets &&
      binaryScanViews(bytes).some(
        (view) => ctx.sanitizer.sanitizeText(view, tool, rel).changed,
      )
    ) {
      out.warnings.push(
        `home: skipped ~/${rel} — binary content with secret-shaped bytes`,
      );
      return;
    }
    const file: CapturedFile = { repoPath, content: bytes.toString("base64"), binary: true };
    if (mode !== undefined) file.mode = mode;
    out.files.push(file);
    ctx.log.debug(`home: captured ~/${rel} (binary) [${reason}]`);
    return;
  }

  const raw = decoded.text;
  let content = raw;
  if (!ctx.includeSecrets) {
    const cleaned = ctx.sanitizer.sanitizeFile(raw, tool, rel);
    content = cleaned.content;
    out.secrets.push(...cleaned.found);
  }
  const templated = ctx.templater.toTemplate(content, portableVars(ctx.vars));

  const file: CapturedFile = { repoPath, content: templated };
  if (mode !== undefined) file.mode = mode;
  out.files.push(file);
  ctx.log.debug(`home: captured ~/${rel} [${reason}]`);
}

/* -------------------------------------------------------------------------- */
/* Directory tree                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Capture a whole directory under $HOME (an `extraPaths` dir, typically).
 *
 * Same rules as {@link captureHomeFile} per file, plus a hard file-count cap:
 * hitting it warns and STOPS the walk rather than silently truncating, because a
 * partial tree in a backup is worse than a loud one.
 */
export async function captureHomeTree(
  ctx: HomeCaptureContext,
  absRoot: string,
  tool: ToolId,
  reason: string,
  out: HomeCaptureOut,
  opts: HomeCaptureOptions,
): Promise<void> {
  const home = ctx.vars.HOME;
  const rootRel = homeRelativePosix(home, absRoot);
  if (rootRel === null) {
    ctx.log.debug(`home: skip tree ${absRoot} (not under $HOME) [${reason}]`);
    return;
  }
  if (isUnderAnyRoot(absRoot, opts.excludeRoots)) {
    ctx.log.debug(`home: skip tree ${rootRel} (already captured with its tool) [${reason}]`);
    return;
  }
  if ((await ctx.fs.statKind(absRoot)) !== "dir") {
    ctx.log.debug(`home: skip tree ${rootRel} (not a directory) [${reason}]`);
    return;
  }
  if (matchesDeny(`${rootRel}/`, HOME_DENY_PATTERNS)) {
    ctx.log.debug(`home: skip tree ${rootRel} (denylist) [${reason}]`);
    return;
  }

  const limit = opts.maxFiles ?? MAX_HOME_TREE_FILES;
  const before = out.files.length;
  let stopped = false;

  const walk = async (dir: string): Promise<void> => {
    if (stopped) return;
    const entries = await ctx.fs.list(dir);
    entries.sort();
    for (const name of entries) {
      if (stopped) return;
      if (out.files.length - before >= limit) {
        out.warnings.push(
          `home: stopped walking ~/${rootRel} after ${limit} file(s) — ` +
            "narrow the extraPaths entry to the directory you actually need",
        );
        stopped = true;
        return;
      }
      const child = path.join(dir, name);
      const kind = await ctx.fs.statKind(child);
      if (kind === "dir") {
        const childRel = homeRelativePosix(home, child);
        if (childRel !== null && matchesDeny(`${childRel}/`, HOME_DENY_PATTERNS)) {
          ctx.log.debug(`home: skip ${childRel}/ (denylist) [${reason}]`);
          continue;
        }
        await walk(child);
        continue;
      }
      // captureHomeFile re-applies every single-file rule (symlink, deny, caps).
      await captureHomeFile(ctx, child, tool, reason, out, opts);
    }
  };

  await walk(absRoot);
}

/* -------------------------------------------------------------------------- */
/* Linked scripts (adapters)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Capture every $HOME file the given command references point at.
 *
 * The adapters own WHICH configs produce the refs (settings.json, hooks.json,
 * `[mcp_servers]`, …); this loop owns the uniform "resolve → filter → capture"
 * half so the two adapters cannot drift apart.
 */
export async function captureLinkedHomeFiles(
  ctx: HomeCaptureContext,
  refs: readonly CommandRef[],
  tool: ToolId,
  out: HomeCaptureOut,
  opts: HomeCaptureOptions,
): Promise<void> {
  for (const ref of refs) {
    for (const abs of extractHomePathCandidates(ref, ctx.vars.HOME)) {
      await captureHomeFile(ctx, abs, tool, `linked:${ref.source}`, out, opts);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* extraPaths (commands)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one `config.extraPaths` entry to an absolute path under `home`.
 *
 * `~/x`, `x` and an absolute `/home/me/x` all mean the same thing. Returns null
 * when the entry is empty, names $HOME itself, or resolves outside $HOME — the
 * caller warns and skips (arbella never carries anything from outside the user's
 * own home directory). Pure.
 */
export function resolveExtraPath(entry: string, home: string): string | null {
  const raw = entry.trim();
  if (raw === "" || raw === "~" || raw === "~/") return null;
  const abs = raw.startsWith("~/")
    ? joinUnderHome(home, raw.slice(2))
    : (expandHomePath(raw, home) ?? joinUnderHome(home, raw));
  return isUnderHome(abs, home) ? abs : null;
}

/**
 * Capture every configured `extraPaths` entry (file or directory).
 *
 * `tool` is only the label the sanitizer stamps onto any SecretRef it produces
 * (SecretRef.tool is a ToolId and there is no "system" member); the files
 * themselves are tool-agnostic and land under shared/home like any other.
 *
 * extraPaths is explicit user intent, so it is allowed to reach INSIDE a tool
 * home (e.g. `~/.claude/.agents`) — unlike linked scripts/companions, which
 * must stay out of every tool home. We therefore override `excludeRoots` to
 * empty for every call this function makes; a file the tool itself already
 * captured this run is instead deduped per-file via `opts.alreadyCaptured`
 * (see {@link HomeCaptureOptions}), which the caller computes once with
 * {@link computeAlreadyCaptured} and passes straight through.
 */
export async function captureExtraPaths(
  ctx: HomeCaptureContext,
  entries: readonly string[],
  tool: ToolId,
  out: HomeCaptureOut,
  opts: HomeCaptureOptions,
): Promise<void> {
  const innerOpts: HomeCaptureOptions = { ...opts, excludeRoots: [] };
  for (const entry of entries) {
    const abs = resolveExtraPath(entry, ctx.vars.HOME);
    if (abs === null) {
      out.warnings.push(
        `extraPaths: "${entry}" does not resolve to a path under $HOME; skipped`,
      );
      continue;
    }
    const kind = await ctx.fs.statKind(abs);
    if (kind === "dir") {
      // A tree walk's finds are not individually named by the user — deny
      // skips inside it stay a debug line (see isExplicitReference).
      await captureHomeTree(ctx, abs, tool, `extraPaths:${entry}`, out, innerOpts);
    } else if (kind === "file") {
      // The user named THIS file directly — a deny skip here is explicit.
      await captureHomeFile(ctx, abs, tool, `extraPaths-file:${entry}`, out, innerOpts);
    } else {
      ctx.log.debug(`extraPaths: ${abs} is ${kind} on this machine; skipped`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* alreadyCaptured (commands)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Derive the `alreadyCaptured` set for this run's `extraPaths` pass from the
 * tool CaptureResults already produced this run.
 *
 * Only entries with repoPath `<tool>/files/<rel>` count — that is the ONE
 * root that mirrors a real path under the tool's own home dir. Every other
 * root a tool's capture may emit (`claude/memories/`, `cursor/user/`,
 * `antigravity/user|gemini`, `shared/home/`, ...) is a different on-disk
 * location and is silently ignored: mapping it through `toolHomeFor` would
 * produce a bogus absolute path and a false-positive dedupe.
 *
 * Pure over an injected `toolHomeFor` mapper (rather than calling
 * `toolHomeDir` directly) so a test can point it at a fixture home.
 */
export function computeAlreadyCaptured(
  results: readonly CaptureResult[],
  toolHomeFor: (tool: ToolId) => string,
): Set<string> {
  const out = new Set<string>();
  for (const result of results) {
    const prefix = `${result.tool}/files/`;
    const toolHome = toolHomeFor(result.tool);
    const add = (repoPath: string): void => {
      if (!repoPath.startsWith(prefix)) return;
      const rel = repoPath.slice(prefix.length);
      if (rel === "") return;
      out.add(path.join(toolHome, ...rel.split("/")));
    };
    for (const file of result.files) add(file.repoPath);
    for (const link of result.symlinks) add(link.repoPath);
  }
  return out;
}
