/**
 * External-tool classification (WP-C).
 *
 * "External tools" are binaries referenced by an MCP server or hook command
 * that were installed by something OTHER than npm — typically `uv tool
 * install`, `pipx install`, or Homebrew. arbella cannot `npm install -g` these
 * on restore, so it needs to know which package manager owns them (or admit it
 * doesn't know) so the restore layer can offer the right install command.
 *
 * Pure module: no fs, no clock, no process, no imports. Every function here is
 * a deterministic string transform so it is trivially unit-testable and safe to
 * call from both capture (classifying a resolved realpath) and restore
 * (planning an install command) without any I/O of its own. The actual
 * filesystem/PATH probing (`resolveBinaryPath`, `realPathOrSelf`,
 * `installExternalTool`) lives in `src/platform/install.ts`, which is the ONE
 * place allowed to shell out.
 */

/**
 * The package manager arbella believes owns an external tool's binary.
 * "unknown" means none of the recognized install-layout markers matched —
 * arbella still records the tool (for the post-restore reminder) but cannot
 * suggest an install command for it.
 */
export type ExternalToolManager = "brew" | "uv" | "pipx" | "unknown";

/**
 * One external tool referenced by an MCP server or hook command.
 *
 * Mirrors the manifest schema's `externalTools` array entry
 * (src/core/manifest/schema.ts) field-for-field — keep the two definitions in
 * sync so capture/restore code can pass values between them without an adapter
 * layer in between.
 */
export interface ExternalToolRef {
  /** Package name to install (e.g. "serena-agent", "greppy"). */
  name: string;
  /** Package manager that owns the binary, or "unknown". */
  manager: ExternalToolManager;
  /** The command as written in the referencing config (templated). */
  command: string;
  /** realpath of the resolved binary (templated), informational only. */
  resolvedPath?: string;
  /** Where this tool is referenced from, e.g. ["mcp:serena", "hook:PreToolUse"]. */
  usedBy: string[];
}

/* -------------------------------------------------------------------------- */
/* Name safety                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY shape a package name may have to reach an install command.
 *
 * `externalTools[].name` comes out of a backup repo and is handed to `brew
 * install <name>` / `uv tool install <name>` / `pipx install <name>` as an argv
 * element. argv means no shell, so a name can never inject a second COMMAND —
 * but it can still inject an OPTION or a LOCATION, which is just as bad:
 * `--cask`, `-f`, `git+https://evil/x`, `https://evil/x.rb`, `./local/formula`
 * all change what a package manager installs and from where.
 *
 * So the name must start with an alphanumeric (killing every leading `-`) and
 * may then hold only the characters real package names use. That leaves `/`,
 * `:`, `@`, whitespace and every URL shape outside the alphabet entirely.
 */
export const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Upper bound on a package name — well past any real one, short of an essay. */
export const MAX_TOOL_NAME_LENGTH = 128;

/**
 * True when `name` is safe to pass to a package manager as a package name.
 *
 * The single predicate every layer shares: the manifest schema drops entries
 * that fail it, the collector never emits one, and the installer refuses one —
 * three independent lines, one definition, so they cannot disagree.
 */
export function isSafeToolName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_TOOL_NAME_LENGTH &&
    SAFE_TOOL_NAME.test(name)
  );
}

/* -------------------------------------------------------------------------- */
/* Runtime commands (never external tools themselves)                          */
/* -------------------------------------------------------------------------- */

/**
 * Bare command names that are interpreters/launchers/runtimes rather than the
 * actual tool being invoked (e.g. an MCP server started as `uvx serena-agent`
 * or a hook run as `python3 hook.py`). These are skipped by the collector —
 * they are either already covered elsewhere (npm globals, the CLI itself) or
 * are so universally present that recording them as an "external tool" would
 * just be noise.
 */
export const RUNTIME_COMMANDS: ReadonlySet<string> = new Set([
  "npx",
  "node",
  "python",
  "python3",
  "bash",
  "sh",
  "zsh",
  "uvx",
  "uv",
  "pipx",
  "arbella",
  "docker",
  "env",
  "cmd",
  "powershell",
  // Shell builtins. These have no binary a package manager could install (and
  // where one exists — /bin/test, /bin/echo — it ships with the OS), so a hook
  // written as `cd "$dir" && ...` or `source ~/.agents/env.sh` must not be
  // reported as a missing package.
  "cd",
  "type",
  "echo",
  "test",
  "[",
  "source",
  ".",
  "export",
  "exec",
  "eval",
  "set",
  "true",
  "false",
  "printf",
  "command",
  "builtin",
]);

/**
 * basename of a path, tolerant of BOTH POSIX (`/`) and win32 (`\`) separators
 * regardless of the host OS running this code (a captured command may name a
 * path shaped for a different OS than the one currently classifying it).
 */
function basename(commandPath: string): string {
  const normalized = commandPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : normalized;
}

/** Strip a trailing `.exe` or `.cmd` (case-insensitive — win32 extensions). */
function stripWindowsExeExt(name: string): string {
  return name.replace(/\.(exe|cmd)$/i, "");
}

/**
 * True when `command` (a bare name or a path) names one of {@link
 * RUNTIME_COMMANDS}. Compares on the basename only (so `/usr/bin/python3`
 * matches `python3`), after stripping a win32 `.exe`/`.cmd` suffix, and
 * case-insensitively — win32 filesystems and PATH lookups are case-insensitive
 * (`Node.exe`, `CMD`), and a case-sensitive compare would buy nothing on POSIX
 * since every listed runtime name is already lowercase.
 */
export function isRuntimeCommand(command: string): boolean {
  const stripped = stripWindowsExeExt(basename(command));
  return RUNTIME_COMMANDS.has(stripped.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Binary path classification                                                  */
/* -------------------------------------------------------------------------- */

/** First match wins; each entry is `[regex over the normalized path, manager]`. */
const MANAGER_MARKERS: ReadonlyArray<{
  pattern: RegExp;
  manager: Exclude<ExternalToolManager, "unknown">;
}> = [
  // `uv tool install <name>` links its shims under .../uv/tools/<name>/...
  { pattern: /\/uv\/tools\/([^/]+)\//, manager: "uv" },
  // `pipx install <name>` creates an isolated venv under .../pipx/venvs/<name>/...
  { pattern: /\/pipx\/venvs\/([^/]+)\//, manager: "pipx" },
  // Homebrew's actual formula store on macOS (Intel + Apple Silicon prefixes
  // both contain a literal "Cellar" segment): .../Cellar/<name>/<version>/...
  { pattern: /\/Cellar\/([^/]+)\//, manager: "brew" },
  // Linuxbrew / some Homebrew installs expose formulas via an "opt" symlink
  // farm instead of (or alongside) Cellar: .../homebrew/opt/<name>/...
  { pattern: /\/homebrew\/opt\/([^/]+)\//, manager: "brew" },
  // macOS Homebrew's default opt symlink farm: /usr/local/opt/<name>/...
  // (Apple Silicon's default prefix is /opt/homebrew, caught by the rule above.)
  { pattern: /\/usr\/local\/opt\/([^/]+)\//, manager: "brew" },
];

/** A `node_modules/<pkg>` segment, `<pkg>` optionally scoped (`@scope/pkg`). */
const NODE_MODULES_MARKER = /\/node_modules\/(?:@[^/]+\/)?[^/]+\//;

/**
 * Classify a resolved binary by the package manager whose install layout
 * produced it, from its realpath alone (pure string matching — no filesystem
 * access). `realPath` is normalized (`\` -> `/`) first so a win32 path
 * (`C:\Users\x\.local\share\uv\tools\serena-agent\...`) matches the same
 * markers as a POSIX one. `home` is accepted for signature symmetry with the
 * collector's call site; every marker below is an absolute install-root
 * fragment, so classification does not need to know the caller's home dir.
 *
 * Rules, first match wins:
 *  - `/uv/tools/<name>/`                                    -> uv
 *  - `/pipx/venvs/<name>/`                                  -> pipx
 *  - `/Cellar/<name>/`, `/homebrew/opt/<name>/`,
 *    `/usr/local/opt/<name>/`                                -> brew
 *  - `/node_modules/<pkg>/` (scoped `@scope/pkg` aware)      -> null (npm
 *    globals already cover it — this is not an "external" tool)
 *  - anything else                                           -> `{manager:
 *    "unknown", name: <basename, .exe/.cmd stripped>}`
 */
export function classifyBinaryPath(
  realPath: string,
  home: string,
): { manager: ExternalToolManager; name: string } | null {
  void home; // reserved for signature symmetry — see doc comment above.
  const normalized = realPath.replace(/\\/g, "/");

  for (const { pattern, manager } of MANAGER_MARKERS) {
    const match = pattern.exec(normalized);
    if (match) return { manager, name: match[1] as string };
  }

  if (NODE_MODULES_MARKER.test(normalized)) return null;

  return { manager: "unknown", name: stripWindowsExeExt(basename(normalized)) };
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                     */
/* -------------------------------------------------------------------------- */

/** Unique, sorted copy of `values`. Never mutates the input array. */
function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Merge several lists of {@link ExternalToolRef} (e.g. one per tool/adapter)
 * into one deduplicated, deterministically ordered list.
 *
 *  - Dedupe key: `${manager}:${name}`.
 *  - `usedBy` is unioned across every occurrence of a key, then sorted+deduped.
 *  - Every other field (`command`, `resolvedPath`) comes from the FIRST
 *    occurrence of a key — later occurrences only contribute to `usedBy`.
 *  - Output is sorted by dedupe key.
 *
 * Pure: never mutates `lists`, any of its nested arrays, or any `ExternalToolRef`
 * within them — every returned ref (and its `usedBy` array) is a fresh object.
 */
export function mergeExternalTools(
  lists: ReadonlyArray<ReadonlyArray<ExternalToolRef>>,
): ExternalToolRef[] {
  const byKey = new Map<string, ExternalToolRef>();

  for (const list of lists) {
    for (const ref of list) {
      const key = `${ref.manager}:${ref.name}`;
      const existing = byKey.get(key);
      const usedBy = uniqueSorted([...(existing?.usedBy ?? []), ...ref.usedBy]);
      byKey.set(key, existing ? { ...existing, usedBy } : { ...ref, usedBy });
    }
  }

  return Array.from(byKey.keys())
    .sort()
    .map((key) => byKey.get(key) as ExternalToolRef);
}
