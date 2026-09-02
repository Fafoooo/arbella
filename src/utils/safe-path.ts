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
 *
 * WHAT THIS DOES NOT CLOSE (deliberate, documented, not a TODO)
 * -------------------------------------------------------------
 * This is a check followed by a write, so there is a window between them:
 *
 *   - THE LEAF is mitigated at the write, not here. The shared/home restore and
 *     the Claude memory restore write through `fs.writeAtomic` /
 *     `fs.writeBytesAtomic`, which create a temp sibling and `rename` it over
 *     the destination. `rename(2)` REPLACES the destination entry, so a symlink
 *     that appears at the leaf in the gap is clobbered rather than followed —
 *     the write cannot be redirected out of the tree.
 *   - INTERMEDIATE DIRECTORIES remain racy. If a component between the root and
 *     the leaf is swapped for a symlink after its lstat and before the write,
 *     the write follows it. Closing that needs an `openat`/`O_NOFOLLOW` walk
 *     holding a directory fd per component, which Node does not expose
 *     portably (`fs.open` has no `openat`, and `O_NOFOLLOW` applies to the leaf
 *     only). A pure-JS re-check cannot help: it would just add another window.
 *
 * The residual risk is bounded by the threat model: a pull writes CONTENT the
 * user's own private backup repo supplies into the user's own $HOME, as the
 * user. An attacker able to win this race already has write access to the home
 * directory being restored into and does not need arbella to use it. The check
 * exists for the far more common non-adversarial case — a dotfile manager that
 * symlinked `~/.local/bin` or `~/.claude/projects` into a git checkout — where
 * following the link would silently write outside the tree arbella believes it
 * owns.
 */

import path from "node:path";

import type { FsService } from "../types.js";

/**
 * True when a `path.relative` result leaves the root, i.e. its FIRST SEGMENT is
 * `..`. A plain `rel.startsWith("..")` also rejects perfectly ordinary names
 * that merely begin with two dots — `$HOME/..config/file` relativizes to
 * "..config/file" — and refusing those makes the restore skip a file it should
 * have written. Only the `..` segment itself counts.
 */
function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../");
}

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
  if (rel === "" || escapesRoot(rel) || path.isAbsolute(rel)) return dest;

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
