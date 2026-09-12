/**
 * `shared/home` restore: put the carried $HOME files back on a fresh machine.
 *
 * The mirror image of capture.ts. A file stored at `shared/home/<rel>` is
 * written to `$HOME/<rel>`, with `{{HOME}}`/`{{USER}}` expanded to THIS machine's
 * values and the POSIX mode preserved (the hook dispatchers are executables —
 * losing the +x bit would break every prompt just as surely as losing the file).
 *
 * Safety, in order of importance:
 *   - NEVER writes outside $HOME. The repo path is decomposed into segments and
 *     rejected outright if any segment is `..`, `.` or empty, so a hand-edited
 *     backup repo cannot turn a pull into an arbitrary file write. The same goes
 *     for a destination that only LOOKS like it is under $HOME: every component
 *     from $HOME down to the leaf is lstat'd, and a symlinked one (a
 *     dotfile-manager `~/.local/bin`, say) refuses the write rather than
 *     following the link out of the home directory.
 *   - `sourceOfTruth: "local"` (the default) never clobbers a file that already
 *     exists here; only `"repo"` / `--force` overwrites.
 *   - Every overwrite is preceded by a per-file safety copy under
 *     `dataDir()/safety-backups/home-<stamp>/<rel>` (R14), so an unwanted
 *     overwrite is always recoverable.
 *
 * This module is deliberately unaware of the repo layout on disk: the command
 * layer reads `<repoRoot>/shared/home/**` with the same walker it uses for tool
 * roots and hands the CapturedFile[] over. That keeps the walk in one place and
 * this module trivially testable.
 */

import path from "node:path";

import type { CoreServices } from "../../adapters/adapter.interface.js";
import type { CapturedFile, RestoreAction, SourceOfTruth } from "../../types.js";

import { findSymlinkComponent } from "../../utils/safe-path.js";

import { SHARED_HOME_REPO_PREFIX, isSharedHomePath } from "./capture.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The services a shared/home restore needs. A tool's RestoreContext satisfies
 * this structurally, but shared/home is a SYSTEM-level step with no tool home
 * and no repoToolDir, so it asks for exactly what it uses and nothing more.
 */
export interface HomeRestoreServices extends CoreServices {
  /** R12: "repo" may overwrite an existing local file; "local" never does. */
  sourceOfTruth: SourceOfTruth;
  /** Plan + report only; perform no filesystem action. */
  dryRun: boolean;
}

/** Where a safety copy of an about-to-be-overwritten home file goes (R14). */
export interface HomeRestoreOptions {
  /** Absolute dir, e.g. `<dataDir>/safety-backups/home-<stamp>`. */
  safetyDir: string;
}

/* -------------------------------------------------------------------------- */
/* Path decoding                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The $HOME-relative segments a `shared/home/...` repo path decodes to, or null
 * when the path is not one of ours or is not safe to write.
 *
 * Rejects `..`, `.` and empty segments so the result can only ever name a
 * descendant of $HOME. Pure.
 */
export function homeRelSegments(repoPath: string): string[] | null {
  if (!isSharedHomePath(repoPath)) return null;
  const rest = repoPath.slice(SHARED_HOME_REPO_PREFIX.length + 1);
  const segments = rest.replace(/\\/g, "/").split("/");
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null;
  }
  return segments;
}

/**
 * Absolute destination on this machine for a stored home file, or null when the
 * repo path is not a well-formed (and safe) shared/home path. Pure.
 */
export function homeDestFor(repoPath: string, home: string): string | null {
  const segments = homeRelSegments(repoPath);
  if (segments === null) return null;
  return path.join(home, ...segments);
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The write actions a shared/home restore WOULD perform, without performing any
 * of them — so `--dry-run` lists them next to the per-tool actions. Files kept
 * because the local copy wins are omitted, exactly as the real pass skips them.
 */
export async function planHomeFileActions(
  ctx: HomeRestoreServices,
  files: readonly CapturedFile[],
): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];

  for (const file of files) {
    // One decode per file: the segments ARE the destination and the label, so
    // re-deriving them (and asserting the second call cannot fail) would just be
    // two chances to disagree.
    const segments = homeRelSegments(file.repoPath);
    if (segments === null) continue;
    const dest = path.join(ctx.vars.HOME, ...segments);
    // Same refusal as the real pass, so --dry-run never lists a write that the
    // restore then declines to make.
    if ((await findSymlinkComponent(ctx.fs, ctx.vars.HOME, dest)) !== null) continue;
    const overwrites = await ctx.fs.exists(dest);
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-file",
      tool: "system",
      targetPath: dest,
      description: `Write ~/${segments.join("/")} (shared home file)`,
      overwrites,
    });
  }

  return actions;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Write the carried home files back into $HOME. Returns how many were written.
 *
 * Best-effort per file: one unwritable destination warns and the rest continue
 * (a partially-restored home is recoverable; an aborted restore is not).
 */
export async function restoreHomeFiles(
  ctx: HomeRestoreServices,
  files: readonly CapturedFile[],
  opts: HomeRestoreOptions,
): Promise<number> {
  let written = 0;

  for (const file of files) {
    const segments = homeRelSegments(file.repoPath);
    if (segments === null) {
      ctx.log.warn(
        `restore: refusing ${file.repoPath} — it does not resolve to a safe path under $HOME`,
      );
      continue;
    }
    const rel = segments.join("/");
    const dest = path.join(ctx.vars.HOME, ...segments);

    // Refuse to write THROUGH a link: the repo names ~/<rel>, and a symlinked
    // component would silently redirect the write (and its safety copy) to
    // wherever that link points, outside $HOME entirely.
    const link = await findSymlinkComponent(ctx.fs, ctx.vars.HOME, dest);
    if (link !== null) {
      ctx.log.warn(
        `restore: skipping ~/${rel} — ${link} is a symlink; ` +
          "arbella does not write through links. Resolve it and re-run.",
      );
      continue;
    }

    const exists = await ctx.fs.exists(dest);
    if (ctx.sourceOfTruth === "local" && exists) {
      ctx.log.debug(`home: keep local (sourceOfTruth=local) ${dest}`);
      continue;
    }
    if (ctx.dryRun) {
      ctx.log.step(`Would write ~/${rel}`);
      continue;
    }

    if (exists) {
      // R14: snapshot before the overwrite, mirroring the per-tool safety copy.
      const safetyDest = path.join(opts.safetyDir, ...segments);
      try {
        await ctx.fs.copy(dest, safetyDest);
        ctx.log.debug(`home: safety copy ${dest} -> ${safetyDest}`);
      } catch (err) {
        ctx.log.warn(
          `restore: could not safety-copy ~/${rel} (${(err as Error).message}); skipping it`,
        );
        continue;
      }
    }

    try {
      // Rename-based (see FsService.writeAtomic): the symlink check above and
      // the write below cannot be made one operation, and a plain writeFile
      // FOLLOWS a link that appears in that gap. `rename` replaces the leaf
      // entry instead, so the worst case is a clobbered link, never a write
      // through one to somewhere outside $HOME.
      if (file.binary === true) {
        await ctx.fs.writeBytesAtomic(dest, Buffer.from(file.content, "base64"), file.mode);
      } else {
        const hydrated = ctx.templater.fromTemplate(file.content, ctx.vars);
        await ctx.fs.writeAtomic(dest, hydrated, file.mode);
      }
      written++;
      ctx.log.debug(`home: wrote ~/${rel}`);
    } catch (err) {
      ctx.log.warn(`restore: could not write ~/${rel}: ${(err as Error).message}`);
    }
  }

  return written;
}
