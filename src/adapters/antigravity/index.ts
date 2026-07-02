/**
 * The Antigravity adapter — implements the Adapter contract for Google Antigravity.
 *
 * Antigravity is a VS Code / Electron-fork IDE (with a bundled `antigravity`/`agy`
 * launcher CLI). Like Cursor it may be entirely absent, and its portable setup is
 * split across roots — but THREE of them (see paths.ts): the ~/.antigravity
 * dotfolder (extension manifest), the VS Code-style User dir (settings, keybindings,
 * snippets), and the shared ~/.gemini agent dir (GEMINI.md, settings.json,
 * antigravity/mcp_config.json, skills/).
 *
 * SECRET SAFETY is the load-bearing property here, because ~/.gemini also holds
 * live Google OAuth tokens. Two guarantees keep them out of the repo:
 *   1. ALLOWLIST — capture only walks the narrow frozen-path lists per root, so
 *      oauth_creds.json / google_accounts.json are never even read.
 *   2. DENYLIST — matchesDeny() drops those files (and *.pb agent state, browser
 *      profile, machine state) even if they ever appeared under a frozen dir.
 * On top of that, every text file is sanitizer-redacted + path-templated before it
 * enters the repo, exactly as the other adapters do.
 *
 * All fs work goes through the injected CoreServices, so the adapter is unit-
 * testable against fixture dirs. Non-fatal problems are surfaced via warnings /
 * log.warn, never thrown — one tool's absence never blocks a multi-tool backup.
 */

import path from "node:path";
import process from "node:process";

import type { Adapter, CaptureContext, RestoreContext, RestoreData } from "../adapter.interface.js";
import type {
  CaptureResult,
  CapturedFile,
  CapturedSymlink,
  EnvVars,
  FsService,
  OS,
  RestoreAction,
  SecretRef,
  ToolManifest,
} from "../../types.js";

import { denylistFor, matchesDeny } from "../../core/sanitizer/denylist.js";
import { cliBinaryName, detectOS, installCommandFor } from "../../platform/os.js";
import { runInstall, which } from "../../platform/install.js";
import { normalizeCapturedSymlinkTarget } from "../../utils/symlink.js";
import { binaryScanViews, decodeForCapture } from "../../utils/capture-bytes.js";

import {
  GEMINI_FROZEN_PATHS,
  GEMINI_REPO_PREFIX,
  HOME_FROZEN_PATHS,
  HOME_REPO_PREFIX,
  USER_FROZEN_PATHS,
  USER_REPO_PREFIX,
  antigravityHomeCandidates,
  antigravityUserDir,
  antigravityUserDirCandidates,
  geminiDir,
  home,
} from "./paths.js";

/* -------------------------------------------------------------------------- */
/* Roots + repo-path mapping                                                   */
/* -------------------------------------------------------------------------- */

type Root = "home" | "user" | "gemini";

const PREFIX_BY_ROOT: Readonly<Record<Root, string>> = {
  home: HOME_REPO_PREFIX,
  user: USER_REPO_PREFIX,
  gemini: GEMINI_REPO_PREFIX,
};

/** Convert an absolute child path under `root` into a POSIX rel path. */
function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Build a repo path for a root-relative POSIX path. */
function repoPathFor(root: Root, rel: string): string {
  return `${PREFIX_BY_ROOT[root]}/${rel}`;
}

type AntigravityTarget = { root: Root; rel: string };

/** Strip the antigravity/{home,user,gemini} prefix and keep which root it uses. */
function targetFromRepoPath(repoPath: string): AntigravityTarget | undefined {
  const norm = repoPath.replace(/\\/g, "/");
  for (const root of ["home", "user", "gemini"] as const) {
    const prefix = `${PREFIX_BY_ROOT[root]}/`;
    if (norm.startsWith(prefix)) return { root, rel: norm.slice(prefix.length) };
  }
  return undefined;
}

/** The absolute dir each root resolves to on THIS machine. */
type RootDirs = Readonly<Record<Root, string>>;

/** First candidate that exists as a dir, else the fallback. */
async function firstExistingDir(
  fs: FsService,
  candidates: readonly string[],
  fallback: string,
): Promise<string> {
  for (const candidate of candidates) {
    if ((await fs.statKind(candidate)) === "dir") return candidate;
  }
  return fallback;
}

/**
 * Resolve the three roots, probing the post-2.0 candidates: the dotfolder may be
 * ~/.antigravity-ide and the User dir "Antigravity IDE" on migrated installs (the
 * IDE-variant is preferred when both exist — it holds the live data there), while
 * the classic names remain the verified default when nothing exists yet.
 */
async function resolveRootDirs(
  fs: FsService,
  toolHome: string,
  os: OS,
  env: EnvVars,
): Promise<RootDirs> {
  return {
    home: await firstExistingDir(fs, antigravityHomeCandidates(toolHome), toolHome),
    user: await firstExistingDir(
      fs,
      antigravityUserDirCandidates(toolHome, os, env),
      antigravityUserDir(toolHome, os, env),
    ),
    gemini: geminiDir(toolHome),
  };
}

/** Resolve an AntigravityTarget onto the target machine's resolved roots. */
function targetAbsFor(dirs: RootDirs, target: AntigravityTarget): string {
  return path.join(dirs[target.root], ...target.rel.split("/").filter(Boolean));
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** An empty manifest for antigravity (it tracks no reinstallable plugins here —
 * the extension list is frozen as a file, not reinstalled from a manifest). */
function emptyManifest(): ToolManifest {
  return {
    tool: "antigravity",
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
  abs: string;
  rel: string;
  repoPath: string;
  files: CapturedFile[];
  secrets: SecretRef[];
  warnings: string[];
}): Promise<void> {
  const { ctx, abs, rel, repoPath, files, secrets, warnings } = args;
  const mode = await readMode(abs);

  let bytes: Buffer;
  try {
    bytes = await ctx.fs.readBytes(abs);
  } catch (err) {
    warnings.push(`antigravity: could not read ${rel}: ${(err as Error).message}`);
    return;
  }

  const decoded = decodeForCapture(bytes);

  if (decoded.kind === "binary") {
    // Fail-safe: a genuinely-binary file must not smuggle a secret past the
    // sanitizer. Scan every lossy view (UTF-8 + UTF-16LE/BE at both alignments)
    // — a NUL-interleaved token is invisible to a UTF-8-only scan. On any hit,
    // DROP the file (never store raw) and record the refs.
    if (!ctx.includeSecrets) {
      for (const view of binaryScanViews(bytes)) {
        const scan = ctx.sanitizer.sanitizeText(view, "antigravity", rel);
        if (!scan.changed) continue;
        warnings.push(`antigravity: skipped ${rel} — binary content with secret-shaped bytes`);
        secrets.push(...scan.found);
        return;
      }
    }
    const file: CapturedFile = { repoPath, content: bytes.toString("base64"), binary: true };
    if (mode !== undefined) file.mode = mode;
    files.push(file);
    return;
  }

  let content = decoded.text;
  if (!ctx.includeSecrets) {
    // Structural JSON redaction (secret-key-aware) for settings.json /
    // mcp_config.json, pattern redaction for GEMINI.md and other text — so any
    // MCP env API key or token-shaped value is redacted before the repo, and the
    // SecretRefs drive the post-restore "re-supply X" reminder. UTF-16 configs
    // are decoded above, so they take THIS text path too — never the raw base64
    // branch that would skip sanitization.
    const sanitized = ctx.sanitizer.sanitizeFile(content, "antigravity", rel);
    content = sanitized.content;
    secrets.push(...sanitized.found);
  }
  const templated = ctx.templater.toTemplate(content, ctx.vars);
  const file: CapturedFile = { repoPath, content: templated };
  if (mode !== undefined) file.mode = mode;
  files.push(file);
}

/** Recursively freeze one root's tree, honoring the denylist + symlinks. */
async function walkFrozen(args: {
  ctx: CaptureContext;
  root: Root;
  rootAbs: string;
  abs: string;
  deny: string[];
  files: CapturedFile[];
  symlinks: CapturedSymlink[];
  secrets: SecretRef[];
  warnings: string[];
}): Promise<void> {
  const { ctx, root, rootAbs, abs, deny, files, symlinks, secrets, warnings } = args;
  const kind = await ctx.fs.statKind(abs);
  if (kind === "missing") return;

  const rel = toRel(rootAbs, abs);
  if (rel && matchesDeny(rel, deny)) {
    ctx.log.debug(`antigravity: skip (denylist) ${rel}`);
    return;
  }

  if (kind === "symlink") {
    const target = normalizeCapturedSymlinkTarget(await ctx.fs.readLink(abs));
    symlinks.push({ repoPath: repoPathFor(root, rel), target });
    ctx.log.debug(`antigravity: symlink ${rel} -> ${target}`);
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

  await captureFile({ ctx, abs, rel, repoPath: repoPathFor(root, rel), files, secrets, warnings });
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

/** One (root, its absolute path, its frozen-path list) triple to process. */
async function captureRoots(
  ctx: CaptureContext,
): Promise<ReadonlyArray<{ root: Root; abs: string; frozen: readonly string[] }>> {
  const dirs = await resolveRootDirs(ctx.fs, ctx.toolHome, ctx.os, ctx.env);
  return [
    { root: "home", abs: dirs.home, frozen: HOME_FROZEN_PATHS },
    { root: "user", abs: dirs.user, frozen: USER_FROZEN_PATHS },
    { root: "gemini", abs: dirs.gemini, frozen: GEMINI_FROZEN_PATHS },
  ];
}

/**
 * Capture Antigravity into a CaptureResult. Graceful when absent: if none of the
 * three roots exist, returns an EMPTY result with a single warning so a backup of
 * the other tools is never blocked.
 */
export async function capture(ctx: CaptureContext): Promise<CaptureResult> {
  const files: CapturedFile[] = [];
  const symlinks: CapturedSymlink[] = [];
  const secrets: SecretRef[] = [];
  const warnings: string[] = [];
  const manifest = emptyManifest();
  const deny = denylistFor("antigravity");

  const roots = await captureRoots(ctx);
  const present: Array<{ root: Root; abs: string; frozen: readonly string[] }> = [];
  for (const r of roots) {
    if ((await ctx.fs.statKind(r.abs)) === "dir") present.push(r);
  }

  if (present.length === 0) {
    warnings.push(
      "antigravity: no ~/.antigravity, Antigravity User data, or ~/.gemini found; " +
        "skipping (Antigravity not installed?).",
    );
    return { tool: "antigravity", files, symlinks, manifest, secrets, warnings };
  }

  for (const r of present) {
    for (const rel of r.frozen) {
      await walkFrozen({
        ctx,
        root: r.root,
        rootAbs: r.abs,
        abs: path.join(r.abs, ...rel.split("/")),
        deny,
        files,
        symlinks,
        secrets,
        warnings,
      });
    }
  }

  if (files.length === 0 && symlinks.length === 0) {
    warnings.push("antigravity: present but nothing portable to capture.");
  }

  return { tool: "antigravity", files, symlinks, manifest, secrets, warnings };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

/** Write one frozen file back onto the right target root, rehydrating {{TOKENS}}. */
async function writeRestoredFile(
  ctx: RestoreContext,
  dirs: RootDirs,
  file: CapturedFile,
): Promise<void> {
  const target = targetFromRepoPath(file.repoPath);
  if (target === undefined) {
    ctx.log.debug(`antigravity: ignoring foreign repoPath ${file.repoPath}`);
    return;
  }
  const dest = targetAbsFor(dirs, target);

  if (ctx.sourceOfTruth === "local" && (await ctx.fs.exists(dest))) {
    ctx.log.debug(`antigravity: keep local ${file.repoPath} (sourceOfTruth=local)`);
    return;
  }

  if (file.binary) {
    await ctx.fs.writeBytes(dest, Buffer.from(file.content, "base64"), file.mode);
    return;
  }
  const expanded = ctx.templater.fromTemplate(file.content, ctx.vars);
  await ctx.fs.write(dest, expanded, file.mode);
}

/** Recreate one captured symlink under the right target root. */
async function writeRestoredSymlink(
  ctx: RestoreContext,
  dirs: RootDirs,
  link: CapturedSymlink,
): Promise<void> {
  const target = targetFromRepoPath(link.repoPath);
  if (target === undefined) {
    ctx.log.debug(`antigravity: ignoring foreign symlink ${link.repoPath}`);
    return;
  }
  const dest = targetAbsFor(dirs, target);

  if (ctx.sourceOfTruth === "local" && (await ctx.fs.statKind(dest)) !== "missing") {
    ctx.log.debug(`antigravity: keep local symlink ${link.repoPath} (sourceOfTruth=local)`);
    return;
  }
  await ctx.fs.symlink(link.target, dest);
}

/**
 * Build the restore actions WITHOUT executing them (for --dry-run). Honors
 * sourceOfTruth: when local wins, an existing destination is kept (action omitted).
 */
export async function planActions(ctx: RestoreContext, data: RestoreData): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];
  const dirs = await resolveRootDirs(ctx.fs, ctx.toolHome, ctx.os, ctx.env);

  for (const file of data.files) {
    const target = targetFromRepoPath(file.repoPath);
    if (target === undefined) continue;
    const targetPath = targetAbsFor(dirs, target);
    const overwrites = await ctx.fs.exists(targetPath);
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-file",
      tool: "antigravity",
      targetPath,
      description: `Write ${target.root}/${target.rel}`,
      overwrites,
    });
  }

  for (const link of data.symlinks) {
    const target = targetFromRepoPath(link.repoPath);
    if (target === undefined) continue;
    const targetPath = targetAbsFor(dirs, target);
    const overwrites = (await ctx.fs.statKind(targetPath)) !== "missing";
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-symlink",
      tool: "antigravity",
      targetPath,
      description: `Link ${target.root}/${target.rel} -> ${link.target}`,
      overwrites,
    });
  }

  return actions;
}

/**
 * Restore Antigravity: place frozen files/symlinks back onto the three target
 * roots, rehydrating {{TOKENS}}. Honors ctx.dryRun (plan only). Best-effort +
 * graceful: a single failed write is logged, never thrown.
 */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  if (ctx.dryRun) {
    const actions = await planActions(ctx, data);
    for (const action of actions) ctx.log.step(action.description);
    return;
  }

  const dirs = await resolveRootDirs(ctx.fs, ctx.toolHome, ctx.os, ctx.env);

  for (const file of data.files) {
    try {
      await writeRestoredFile(ctx, dirs, file);
    } catch (err) {
      ctx.log.warn(`antigravity: failed to write ${file.repoPath}: ${(err as Error).message}`);
    }
  }

  for (const link of data.symlinks) {
    try {
      await writeRestoredSymlink(ctx, dirs, link);
    } catch (err) {
      ctx.log.warn(`antigravity: failed to create symlink ${link.repoPath}: ${(err as Error).message}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Detect / CLI                                                                */
/* -------------------------------------------------------------------------- */

/** Local existence-as-dir probe via the default fs service (no ctx needed). */
async function fsExistsDir(p: string): Promise<boolean> {
  const { fs } = await import("../../utils/fs.js");
  return (await fs.statKind(p)) === "dir";
}

/**
 * True if Antigravity's setup is present: either dotfolder variant
 * (~/.antigravity or the post-2.0 ~/.antigravity-ide), either VS Code-style User
 * dir variant ("Antigravity" or "Antigravity IDE"), or the antigravity subtree
 * under the shared ~/.gemini. (Plain ~/.gemini alone is NOT enough — that can be
 * a Gemini-CLI-only install.)
 */
async function detect(): Promise<boolean> {
  const toolHome = home();
  const candidates = [
    ...antigravityHomeCandidates(toolHome),
    ...antigravityUserDirCandidates(toolHome, detectOS(), process.env),
    path.join(geminiDir(toolHome), "antigravity"),
  ];
  for (const candidate of candidates) {
    if (await fsExistsDir(candidate)) return true;
  }
  return false;
}

/** True if the `antigravity` launcher resolves on PATH. */
async function isCliInstalled(): Promise<boolean> {
  return which(cliBinaryName("antigravity"));
}

/**
 * "Install" Antigravity for the given OS. It is a desktop IDE with no package-
 * manager install (installCommandFor returns null on every OS), so this warns with
 * the download URL and skips — never throws.
 */
async function installCli(os: OS): Promise<void> {
  const cmd = installCommandFor("antigravity", os);
  if (cmd === null) {
    const { log } = await import("../../utils/log.js");
    log.warn(
      "antigravity: no headless install available — download Antigravity from https://antigravity.google.",
    );
    return;
  }
  await runInstall(cmd);
}

/* -------------------------------------------------------------------------- */
/* The Adapter object                                                          */
/* -------------------------------------------------------------------------- */

export const antigravityAdapter: Adapter = {
  id: "antigravity",
  displayName: "Antigravity",
  detect,
  isCliInstalled,
  installCli,
  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    return capture(ctx);
  },
  async restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
    return restore(ctx, data);
  },
};

export default antigravityAdapter;
