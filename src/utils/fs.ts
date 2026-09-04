/**
 * Safe filesystem wrappers over node:fs/promises. The single concrete FsService
 * implementation. Adapters use this rather than node:fs directly so behavior
 * (missing-path tolerance, recursive mkdir, mode handling) is uniform.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import type { FsService } from "../types.js";

async function read(p: string): Promise<string> {
  return fsp.readFile(p, "utf8");
}

async function readBytes(p: string): Promise<Buffer> {
  return fsp.readFile(p);
}

async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

async function write(p: string, content: string, mode?: number): Promise<void> {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, content, mode !== undefined ? { mode } : undefined);
  // writeFile only consults `mode` when creating a file and filters it through
  // the process umask. An explicit captured mode must also win for an existing
  // target, so apply it after the contents are safely written on POSIX.
  if (mode !== undefined && process.platform !== "win32") await fsp.chmod(p, mode);
}

async function writeBytes(p: string, content: Buffer, mode?: number): Promise<void> {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, content, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined && process.platform !== "win32") await fsp.chmod(p, mode);
}

/**
 * Write `content` to `p` as one indivisible replacement: a temp file next to the
 * target (same directory, so `rename` stays on one filesystem and is atomic),
 * then a rename over the target.
 *
 * A plain `writeFile` truncates first: any reader that opens the file in that
 * window — Claude Code itself, for ~/.claude.json — sees an empty or partial
 * file, and a crash mid-write leaves it that way for good.
 *
 * Mode: an explicit `mode` is applied; otherwise an EXISTING target's mode is
 * carried onto the replacement (a 0600 credentials-adjacent file must not become
 * 0644 because it was rewritten). The temp file is created 0600 and only widened
 * afterwards, so its contents are never briefly world-readable.
 */
async function writeAtomic(p: string, content: string, mode?: number): Promise<void> {
  await replaceViaRename(p, content, mode);
}

/**
 * The bytes twin of {@link writeAtomic}, with identical semantics. Restores that
 * place binary payloads (base64 in the manifest) need the same rename, for the
 * same reasons — plus the symlink one below.
 */
async function writeBytesAtomic(p: string, content: Buffer, mode?: number): Promise<void> {
  await replaceViaRename(p, content, mode);
}

/**
 * Shared implementation of the two atomic writers.
 *
 * `rename(2)` REPLACES the destination entry: when the leaf is (or becomes) a
 * symlink between the check and the write, the link itself is replaced rather
 * than followed — so a restore cannot be redirected through a leaf planted in
 * the gap. Intermediate directories are a different problem; see the header of
 * src/utils/safe-path.ts.
 */
async function replaceViaRename(
  p: string,
  content: string | Buffer,
  mode?: number,
): Promise<void> {
  await ensureDir(path.dirname(p));

  let target = mode;
  if (target === undefined) {
    try {
      target = (await fsp.stat(p)).mode & 0o777;
    } catch {
      target = undefined; // absent (or unreadable) -> let the default stand.
    }
  }

  const tmp = path.join(
    path.dirname(p),
    `.${path.basename(p)}.arbella-${process.pid}-${Date.now().toString(36)}.tmp`,
  );
  try {
    await fsp.writeFile(tmp, content, { mode: 0o600 });
    if (target !== undefined) await fsp.chmod(tmp, target);
    await fsp.rename(tmp, p);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function copy(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to));
  // cpSync/cp handles files and dirs recursively; preserve nothing special.
  await fsp.cp(from, to, { recursive: true });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function rmrf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

async function list(p: string): Promise<string[]> {
  try {
    return await fsp.readdir(p);
  } catch {
    return [];
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    const st = await fsp.lstat(p);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readLink(p: string): Promise<string> {
  return fsp.readlink(p);
}

async function symlink(target: string, linkPath: string): Promise<void> {
  await ensureDir(path.dirname(linkPath));
  // Remove an existing entry first so re-create is idempotent.
  await fsp.rm(linkPath, { force: true, recursive: false }).catch(() => {});
  await fsp.symlink(target, linkPath);
}

async function statKind(
  p: string,
): Promise<"file" | "dir" | "symlink" | "missing"> {
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    return "file";
  } catch {
    return "missing";
  }
}

/**
 * Resolve every symlink in `p` (parents included), falling back to `p` itself
 * when it cannot be resolved (missing path, permission denied). Never throws:
 * callers use it to ask "where does this really live", and an unanswerable
 * question must not abort a capture.
 */
async function realPath(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

export const fs: FsService = {
  read,
  readBytes,
  write,
  writeAtomic,
  writeBytes,
  writeBytesAtomic,
  copy,
  ensureDir,
  exists,
  rmrf,
  list,
  isSymlink,
  readLink,
  symlink,
  statKind,
  realPath,
};

export default fs;
