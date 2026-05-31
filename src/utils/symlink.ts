/**
 * Normalize captured symlink metadata into the repo's portable representation.
 *
 * Node may report a relative symlink target with native separators on Windows
 * even when the original target was created with "/". Backup metadata should be
 * deterministic across capture OSes, so store relative-style targets with POSIX
 * separators.
 */
export function normalizeCapturedSymlinkTarget(target: string): string {
  return target.replace(/\\/g, "/");
}
