/**
 * The static denylist of path globs/segments that must NEVER leave the machine.
 *
 * This is the FIRST line of defense: any captured path matching the denylist is
 * excluded *wholesale* (the file is never read into the repo at all). Per-tool
 * lists encode the verified reality of ~/.claude and ~/.codex. The matcher is
 * deliberately tiny and dependency-free — no external glob
 * library — so its behavior is deterministic and auditable.
 *
 * Matching model (POSIX paths, relative to a tool home):
 *   - a pattern ending in "/" matches that directory AND everything beneath it,
 *     whether the dir appears as a path segment or as the whole relative path;
 *   - "*" is a SINGLE-segment wildcard (it never crosses "/"). A pattern such as
 *     "*.sqlite" matches any segment ending in ".sqlite";
 *   - an exact (wildcard-free, slash-free) pattern matches if it equals ANY path
 *     segment OR equals the basename. So "auth.json" matches "auth.json" and
 *     "nested/auth.json"; ".DS_Store" matches it at any depth.
 *
 * Pure module: no imports, no fs, no clock.
 */

import type { ToolId } from "../../types.js";

/* -------------------------------------------------------------------------- */
/* Denylists                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Patterns that are dangerous/noisy for EVERY tool. Kept intentionally generic:
 * OS cruft, editor cruft, and SQLite databases (+ their WAL/SHM sidecars) which
 * are large, binary, and frequently hold session/telemetry data.
 */
export const COMMON_DENY: readonly string[] = [
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".git/",
  "node_modules/",
  "*.sqlite",
  "*.sqlite-shm",
  "*.sqlite-wal",
  "*.db",
  "*.db-shm",
  "*.db-wal",
  "*.log",
  "*.lock",
  "*.pid",
  "*.swp",
  "*.tmp",
  ".tmp/",
  "tmp/",
  "cache/",
  ".cache/",
];

/**
 * Claude (~/.claude) EXCLUDE list — verified against the live machine.
 * Covers credentials, the big sanitize-or-skip config, session/telemetry/state
 * dirs, history, caches, and machine-local bookkeeping dotfiles.
 */
export const CLAUDE_DENY: readonly string[] = [
  // Secrets / tokens (NEVER leave the machine).
  ".credentials.json",
  ".claude.json", // 177KB, mode 600: tokens + projects. Default exclude.
  ".caveman-active",
  // Session / history / telemetry / state.
  "history.jsonl",
  "projects/",
  "sessions/",
  "session-env/",
  "shell-snapshots/",
  "statsig/",
  "telemetry/",
  "cost-tally.json",
  "stats-cache.json",
  "mcp-needs-auth-cache.json",
  // Caches & transient working data.
  "paste-cache/",
  "file-history/",
  "downloads/",
  "ide/",
  "debug/",
  "chrome/",
  // arbella-managed / restorable-from-manifest working dirs.
  "backups/",
  "plans/",
  "checkpoints/",
  "tasks/",
  "teams/",
  // Machine-local bookkeeping dotfiles ("." last-run markers etc.).
  ".last-cleanup",
  ".last-update-result.json",
  ".last-*",
];

/**
 * Codex (~/.codex) EXCLUDE list — verified against the live machine.
 * config.toml itself is KEPT (it is sanitized/templated by configToml.ts); only
 * the wholesale-secret / session / cache / machine-id artifacts are excluded.
 */
export const CODEX_DENY: readonly string[] = [
  // Secrets / tokens.
  "auth.json",
  // SQLite databases (goals_*, logs_*, state_*) and their sidecars + dir.
  "sqlite/",
  // (the *.sqlite / -shm / -wal globs in COMMON_DENY catch the loose files)
  // Session / history / logs.
  "history.jsonl",
  "session_index.jsonl",
  "external_agent_session_imports.json",
  "sessions/",
  "shell_snapshots/",
  "log/",
  // Caches.
  "models_cache.json",
  ".tmp/",
  "tmp/",
  // Machine identity / migration / version bookkeeping (machine-specific).
  "installation_id",
  ".codex-global-state.json",
  "version.json",
  ".personality_migration",
];

/**
 * Cursor (~/.cursor) EXCLUDE list. Cursor's global dir is minimal; exclude its
 * local caches/state so only mcp.json (and project rules) ever surface.
 */
export const CURSOR_DENY: readonly string[] = [
  "logs/",
  "sessions/",
  "extensions/",
  "User/globalStorage/",
  "User/workspaceStorage/",
  "machineid",
  "storage.json",
];

/**
 * opencode (~/.config/opencode) EXCLUDE list. Keep only the portable config +
 * agents/commands; drop the plugin-install artifacts (regenerated from the
 * config's plugin list on first run), the large skills/ tree, and any stray
 * credential file. opencode's real auth lives at ~/.local/share/opencode/auth.json
 * (outside this home), but auth.json is listed defensively.
 */
export const OPENCODE_DENY: readonly string[] = [
  "node_modules/",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  ".gitignore",
  "skills/",
  "plugins/",
  "auth.json",
];

/**
 * GitHub Copilot CLI (~/.copilot) EXCLUDE list. Keep config.json, mcp-config.json,
 * and agents/; drop the machine-local session/log/ide state and the history file
 * (which can echo prompts/paths), plus the reinstallable skills/ tree.
 */
export const COPILOT_DENY: readonly string[] = [
  "session-state/",
  "logs/",
  "ide/",
  "restart/",
  "skills/",
  "command-history-state.json",
];

/**
 * Kilo Code CLI (~/.config/kilo) EXCLUDE list. Same shape as opencode: keep the
 * config + agents/rules, drop the plugin-install artifacts and skills/ tree. The
 * CLI's machine-local runtime lives in ~/.kilocode/cli (a different home), so it
 * never reaches this adapter.
 */
export const KILO_DENY: readonly string[] = [
  "node_modules/",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  ".gitignore",
  "skills/",
];

/* -------------------------------------------------------------------------- */
/* Composition + matcher                                                       */
/* -------------------------------------------------------------------------- */

/** The per-tool denylist: COMMON_DENY plus the tool-specific patterns. */
export function denylistFor(tool: ToolId): string[] {
  switch (tool) {
    case "claude":
      return [...COMMON_DENY, ...CLAUDE_DENY];
    case "codex":
      return [...COMMON_DENY, ...CODEX_DENY];
    case "cursor":
      return [...COMMON_DENY, ...CURSOR_DENY];
    case "opencode":
      return [...COMMON_DENY, ...OPENCODE_DENY];
    case "copilot":
      return [...COMMON_DENY, ...COPILOT_DENY];
    case "kilo":
      return [...COMMON_DENY, ...KILO_DENY];
  }
}

/**
 * Normalize a relative path to POSIX form and split into non-empty segments.
 * Tolerates Windows separators and leading "./" so adapters can pass whatever
 * the local fs handed them.
 */
function toSegments(relativePath: string): string[] {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
}

/**
 * Match a single path segment against a single-segment pattern that may contain
 * "*" wildcards. "*" matches any run of characters WITHIN the segment (never
 * crosses a "/", which is guaranteed because we only ever feed it one segment).
 */
function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === segment;
  // Build an anchored regex from the glob, escaping regex metachars and turning
  // "*" into ".*". Anchored so "*.sqlite" does not match "sqlite.txt".
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(segment);
}

/**
 * True if `relativePath` (POSIX, relative to a tool home) matches any pattern.
 *
 * Semantics per pattern:
 *   - trailing "/"  -> directory prefix match: the named directory itself OR
 *                       anything underneath it, at any depth.
 *   - contains "/"  -> path-suffix match: the pattern's segments must appear as
 *                       a contiguous tail of the path's segments (each compared
 *                       with single-segment wildcard rules). Lets callers write
 *                       e.g. "User/globalStorage/".
 *   - single token  -> segment OR basename match at any depth.
 */
export function matchesDeny(relativePath: string, patterns: string[]): boolean {
  const segs = toSegments(relativePath);
  if (segs.length === 0) return false;

  for (const raw of patterns) {
    if (!raw) continue;
    const isDir = raw.endsWith("/");
    const pattern = isDir ? raw.slice(0, -1) : raw;
    const patSegs = toSegments(pattern);
    if (patSegs.length === 0) continue;

    if (isDir) {
      // Directory prefix: find the pattern's segment sequence anywhere such that
      // the path either IS that dir or continues beneath it.
      if (containsSequence(segs, patSegs, /* requireMore */ false)) return true;
      continue;
    }

    if (patSegs.length > 1) {
      // Multi-segment exact-ish pattern: must appear as a contiguous tail.
      if (matchesTail(segs, patSegs)) return true;
      continue;
    }

    // Single-segment pattern: match against ANY segment (covers basename too).
    const p = patSegs[0]!;
    if (segs.some((s) => segmentMatches(p, s))) return true;
  }

  return false;
}

/**
 * True if `patSegs` occurs as a contiguous run inside `segs`. When
 * `requireMore` is false, the run may end exactly at the path's end (the dir
 * itself) or be followed by more segments (something underneath it) — both
 * count, which is exactly the "dir and everything under it" rule.
 */
function containsSequence(segs: string[], patSegs: string[], requireMore: boolean): boolean {
  const limit = segs.length - patSegs.length;
  for (let i = 0; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < patSegs.length; j++) {
      if (!segmentMatches(patSegs[j]!, segs[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const consumedEnd = i + patSegs.length;
    if (!requireMore || consumedEnd < segs.length) return true;
  }
  return false;
}

/** True if `patSegs` matches the final segments of `segs` (a path suffix). */
function matchesTail(segs: string[], patSegs: string[]): boolean {
  if (patSegs.length > segs.length) return false;
  const offset = segs.length - patSegs.length;
  for (let j = 0; j < patSegs.length; j++) {
    if (!segmentMatches(patSegs[j]!, segs[offset + j]!)) return false;
  }
  return true;
}
