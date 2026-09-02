/**
 * The one path check a restore performs before it writes anywhere: does the
 * destination reach its target THROUGH a symlink?
 *
 * A backup repo decides both the CONTENT and the PATH of everything a pull
 * writes. Path traversal is already handled (repo paths are decomposed into
 * segments and `..` is rejected), but a `~/.local/bin/x` that is perfectly
 * traversal-free still lands wherever `~/.local/bin` happens to point on THIS
 * machine — and `mkdir -p`/`writeFile` follow that link without a word. On a
 * machine where a dotfile manager symlinks `~/.local/bin` into a git checkout,
 * or where an attacker got to plant one link, a restore silently writes outside
 * the tree it believes it owns.
 *
 * So: walk the destination one component at a time from a trusted root, with an
 * lstat at each step, and refuse the whole write when any component below that
 * root is a link. The ROOT itself is never checked — `$HOME` is legitimately a
 * symlink on plenty of systems (and `/var` is one on macOS, which every temp-dir
 * test would trip over) — and a component that does not exist yet ends the walk,
 * since nothing below a missing directory can exist either.
 *
 * Pure over the injected FsService (whose `statKind` is lstat-based, never
 * following), so it is testable against a real temp dir and usable from any
 * restore path.
 */

import path from "node:path";

import type { FsService } from "../types.js";

/**
 * The first component of `dest` below `root` that is a symlink, or null when the
 * whole chain (the leaf included) is safe to write through.
 *
 * Returns `dest` itself when `dest` is not a descendant of `root`: a destination
 * outside the trusted root cannot be validated here, and "cannot validate" must
 * read as "do not write".
 */
export async function findSymlinkComponent(
  fs: FsService,
  root: string,
  dest: string,
): Promise<string | null> {
  const rel = path.relative(root, dest);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return dest;

  let current = root;
  for (const segment of rel.split(path.sep).filter((s) => s.length > 0)) {
    current = path.join(current, segment);
    const kind = await fs.statKind(current);
    if (kind === "symlink") return current;
    // Nothing exists below a component that is itself missing, so the rest of
    // the chain will be created as real directories by the write.
    if (kind === "missing") return null;
  }
  return null;
}

export default findSymlinkComponent;
