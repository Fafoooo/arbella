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
 *   - a pattern starting with "/" is ROOT-ANCHORED: it only matches at the top
 *     level of the relative path. "/ecc/" excludes ~/.claude/ecc without also
 *     excluding the perfectly shareable ~/.claude/rules/ecc/. Use it whenever a
 *     top-level noise dir has a name that can legitimately recur deeper in the
 *     tree.
 *
 * Pure module: no imports, no fs, no clock.
 */

import type { ToolId } from "../../types.js";

/* -------------------------------------------------------------------------- */
/* Denylists                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Patterns that are dangerous/noisy for EVERY tool. Kept intentionally generic:
 * OS cruft, editor cruft, SQLite databases (+ their WAL/SHM sidecars) which are
 * large, binary and frequently hold session/telemetry data, vendored language
 * runtimes (a python venv is machine-specific and huge), and the backup/merge
 * droppings that editors and tools leave next to the real file.
 */
export const COMMON_DENY: readonly string[] = [
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".git/",
  "node_modules/",
  // Vendored runtimes: never portable, always huge.
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
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
  // Backup / merge droppings ("settings.json.bak-routing-20260829", "x.js.orig").
  "*.bak",
  "*.bak-*",
  "*.orig",
  "*.rej",
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
  // Top-level noise dirs. ROOT-ANCHORED on purpose: `rules/ecc/...` and a skill
  // called `feedback/` are legitimate content, only the ~/.claude/<name> ones are
  // machine state. security/ holds a python venv, ecc/ a state.db, feedback/ raw
  // session feedback, plugins/ clones + caches that the manifest reinstalls,
  // .pi/ another tool's local state.
  "/security/",
  "/ecc/",
  "/feedback/",
  "/plugins/",
  "/.pi/",
  // Server-pushed policy/catalog caches: refetched on first run, never portable.
  "remote-settings.json",
  "policy-limits.json",
  "plugin-catalog-cache.json",
  "blocklist.json",
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
  // Cursor CLI (cursor-agent) runtime git worktree checkouts — machine-local.
  "worktrees/",
  "worktrees.json",
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
 * GitHub Copilot CLI (~/.copilot) EXCLUDE list. The adapter freezes only the
 * user-authored config (settings.json, mcp-config.json, lsp-config.json,
 * copilot-instructions.md, instructions/, agents/, hooks/); this list is the
 * defense-in-depth exclusion of everything else. Crucially config.json is auto-
 * managed state holding auth data (loggedInUsers) + plugin metadata — restoring a
 * stale one would clobber the target's sign-in, so it is hard-denied. The MCP
 * OAuth/secret stores, saved permission decisions, session/history/log/ide state,
 * the cross-session SQLite db, and reinstallable plugin trees are excluded too.
 */
export const COPILOT_DENY: readonly string[] = [
  // Auto-managed internal state: authentication data + installed-plugin metadata.
  "config.json",
  // MCP OAuth tokens + local secret fallback storage (never leave the machine).
  "mcp-oauth-config/",
  "mcp-secrets/",
  // Saved per-project tool/directory permission decisions (absolute local paths).
  "permissions-config.json",
  // Session / history / logs / IDE integration state.
  "session-state/",
  "session-store.db",
  "command-history-state/",
  "command-history-state.json",
  "logs/",
  "ide/",
  "restart/",
  // Reinstallable plugin artifacts + the skills/ tree (skills is not a Copilot
  // CLI concept; kept defensively).
  "installed-plugins/",
  "plugin-data/",
  "skills/",
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

/**
 * Google Antigravity EXCLUDE list, applied across all three roots the adapter
 * walks (~/.antigravity, the VS Code User dir, and the shared ~/.gemini). The
 * adapter is allowlist-based so these are mostly defense-in-depth — but the
 * ~/.gemini OAuth/account files are load-bearing: they must NEVER leave the
 * machine. Also drops VS Code machine state, agent session/memory protobufs, the
 * browser sub-agent profile, and machine-id/local-path bookkeeping.
 */
export const ANTIGRAVITY_DENY: readonly string[] = [
  // ~/.gemini live Google OAuth tokens + signed-in account identity (SECRET/PII).
  "oauth_creds.json",
  "google_accounts.json",
  // Machine identity / local state / local workspace paths.
  "installation_id",
  "state.json",
  "trustedFolders.json",
  "projects.json",
  // Agent session/memory state (protobuf), chat history, browser sub-agent profile.
  "*.pb",
  "history/",
  "antigravity-browser-profile/",
  // VS Code machine-local state (never portable).
  "globalStorage/",
  "workspaceStorage/",
  "History/",
  // ~/.antigravity runtime bits: Electron flags (carry a crash-reporter id) + the
  // regenerated launcher symlinks.
  "argv.json",
  "bin/",
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
    case "antigravity":
      return [...COMMON_DENY, ...ANTIGRAVITY_DENY];
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
 *   - leading "/"   -> ROOT-ANCHORED: the pattern must match starting at the
 *                       first segment (the whole path for a file pattern, a
 *                       leading run for a dir pattern). Everything else below is
 *                       depth-agnostic.
 *   - trailing "/"  -> directory prefix match: the named directory itself OR
 *                       anything underneath it, at any depth.
 *   - contains "/"  -> path-suffix match: the pattern's segments must appear as
 *                       a contiguous tail of the path's segments (each compared
 *                       with single-segment wildcard rules). Lets callers write
 *                       e.g. "User/globalStorage/".
 *   - single token  -> segment OR basename match at any depth.
 */
export function matchesDeny(relativePath: string, patterns: string[]): boolean {
  return firstMatchingDeny(relativePath, patterns) !== null;
}

/**
 * Like {@link matchesDeny}, but returns the FIRST pattern (verbatim, as given
 * in `patterns`) that matched instead of a boolean — for callers that need to
 * tell the user WHY a path was excluded, not just THAT it was. Returns null
 * when nothing matches. Pure; shares matchesDeny's exact matching semantics
 * (matchesDeny is defined in terms of this function, so the two can never
 * drift apart).
 */
export function firstMatchingDeny(relativePath: string, patterns: string[]): string | null {
  const segs = toSegments(relativePath);
  if (segs.length === 0) return null;

  for (const raw of patterns) {
    if (!raw) continue;
    const anchored = raw.startsWith("/");
    const isDir = raw.endsWith("/");
    const pattern = isDir ? raw.slice(0, -1) : raw;
    const patSegs = toSegments(pattern);
    if (patSegs.length === 0) continue;

    if (anchored) {
      // Root-anchored: match from segment 0. A dir pattern also covers the
      // subtree below it; a file pattern must consume the whole path.
      if (matchesHead(segs, patSegs) && (isDir || patSegs.length === segs.length)) {
        return raw;
      }
      continue;
    }

    if (isDir) {
      // Directory prefix: find the pattern's segment sequence anywhere such that
      // the path either IS that dir or continues beneath it.
      if (containsSequence(segs, patSegs, /* requireMore */ false)) return raw;
      continue;
    }

    if (patSegs.length > 1) {
      // Multi-segment exact-ish pattern: must appear as a contiguous tail.
      if (matchesTail(segs, patSegs)) return raw;
      continue;
    }

    // Single-segment pattern: match against ANY segment (covers basename too).
    const p = patSegs[0]!;
    if (segs.some((s) => segmentMatches(p, s))) return raw;
  }

  return null;
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

/** True if `patSegs` matches the leading segments of `segs` (a path prefix). */
function matchesHead(segs: string[], patSegs: string[]): boolean {
  if (patSegs.length > segs.length) return false;
  for (let j = 0; j < patSegs.length; j++) {
    if (!segmentMatches(patSegs[j]!, segs[j]!)) return false;
  }
  return true;
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
