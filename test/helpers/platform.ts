/**
 * Cross-platform helpers shared by the test suite.
 *
 * The suite runs on Linux, macOS AND windows-latest in CI, and two host facts
 * break assertions that are otherwise perfectly correct:
 *
 *   - POSIX MODE BITS do not exist on Windows. `fs.chmod` is a near no-op there
 *     and `stat().mode & 0o777` reads back 0o666 for every ordinary file, so an
 *     assertion that a captured hook kept its 0o755 (or that ~/.claude.json was
 *     created 0o600) is asserting something the filesystem cannot express. Guard
 *     exactly those lines with {@link isPosixHost}, or the whole test with
 *     {@link itPosixHost} when the mode IS the subject.
 *   - PATH SEPARATORS. `path.join` yields "\" on Windows while the repo-side
 *     contract, the templater's placeholders and most fixtures are POSIX. Run
 *     both sides of such a comparison through {@link toPosix} rather than
 *     skipping the test — the logic under test is host-agnostic and deserves to
 *     run everywhere.
 */

import { it } from "vitest";

/** True when the host filesystem actually implements POSIX permission bits. */
export const isPosixHost = process.platform !== "win32";

/**
 * `it`, except on Windows where it is `it.skip`. For tests whose SUBJECT is a
 * POSIX-only fact (a mode, a `/`-rooted fixture path). Prefer an inline
 * `if (isPosixHost)` around the single mode assertion when the rest of the test
 * is host-agnostic — that keeps the other assertions running on Windows.
 */
export const itPosixHost = isPosixHost ? it : it.skip;

/** A path with native separators rewritten to "/", for separator-blind compares. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** {@link toPosix} over a list, so a whole set of paths compares separator-blind. */
export function toPosixAll(paths: Iterable<string>): string[] {
  return [...paths].map(toPosix);
}
