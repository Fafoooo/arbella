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
}

async function writeBytes(p: string, content: Buffer, mode?: number): Promise<void> {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, content, mode !== undefined ? { mode } : undefined);
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

export const fs: FsService = {
  read,
  readBytes,
  write,
  writeBytes,
  copy,
  ensureDir,
  exists,
  rmrf,
  list,
  isSymlink,
  readLink,
  symlink,
  statKind,
};

export default fs;
