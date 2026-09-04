/**
 * External-tool collection (WP-C): turn the command references a capture has
 * ALREADY found into `manifest.externalTools` entries.
 *
 * The adapters know which configs produce {@link CommandRef}s (settings.json
 * hooks, statusLine, `~/.claude.json#mcpServers`, Codex's hooks.json and
 * `[mcp_servers]`); WP-B's scanner turns those refs into the $HOME FILES that
 * ride along in `shared/home`. This module answers the other half of the same
 * question:
 *
 *     "which of these commands is a BINARY that some package manager installed,
 *      and would therefore be missing on a fresh machine?"
 *
 * The pipeline per ref is deliberately small and every step can only ever
 * REMOVE a candidate:
 *
 *   1. take the command's executable (its first token — arguments are never
 *      binaries the restore has to install);
 *   2. drop interpreters/launchers ({@link isRuntimeCommand}: `npx`, `python3`,
 *      `uvx`, …) — the tool they run is the interesting one, not them;
 *   3. expand `~` / `$HOME`, then resolve: an absolute path must exist, a bare
 *      name is looked up on PATH. Anything that does not resolve is dropped —
 *      arbella never records a tool it could not see;
 *   4. drop what this very backup already carries ({@link
 *      CollectExternalToolsOptions.capturedPaths}) — a hook dispatcher under
 *      `shared/home` or a statusline script inside the tool home is restored as
 *      a FILE, not installed as a package;
 *   5. drop OS-provided binaries (`/bin`, `/usr/bin`, `C:\Windows\…`): no
 *      package manager installs `cat`, and recording one would make the
 *      post-restore reminder lie about what the user has to do;
 *   6. classify the realpath ({@link classifyBinaryPath}); `null` means npm
 *      owns it and `manifest.npmGlobals` already covers it.
 *
 * COST. Capture must stay fast, so every distinct executable is resolved at
 * most ONCE per call (a `command -v` per distinct name, no matter how many
 * hooks or MCP servers name it). Dry runs resolve too: `--dry-run` and `status`
 * must produce the same manifest a real push would.
 *
 * Never throws: a failing resolver, realpath or classification simply yields no
 * entry for that ref. `resolve`/`realpath` are injected (defaulting to the
 * platform layer) so unit tests exercise the whole pipeline with no PATH
 * lookups and no filesystem at all.
 */

import path from "node:path";

import { realPathOrSelf, resolveBinaryPath } from "../../platform/install.js";
import { SHARED_HOME_REPO_PREFIX } from "../homefiles/capture.js";
import type { CommandRef } from "../homefiles/scan.js";
import { expandHomePath, isAbsolutePath, tokenizeCommand } from "../homefiles/scan.js";

import type { ExternalToolRef } from "./classify.js";
import {
  classifyBinaryPath,
  isRuntimeCommand,
  isSafeToolName,
  mergeExternalTools,
} from "./classify.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything {@link collectExternalTools} needs, all injected. */
export interface CollectExternalToolsOptions {
  /** The user's home directory (`ctx.vars.HOME`). */
  home: string;
  /**
   * Absolute paths of every file THIS capture already carries — the tool home
   * tree AND `shared/home`. A command pointing at one of them is a script the
   * backup restores by itself and must never be reported as a package to
   * install. Build it with {@link capturedAbsolutePaths}.
   */
  capturedPaths: ReadonlySet<string>;
  /**
   * Resolve an executable (bare name or absolute path) to an absolute path, or
   * `null` when it does not exist / is not on PATH.
   * Default: {@link resolveBinaryPath}.
   */
  resolve?: (name: string) => Promise<string | null>;
  /** Resolve symlinks to the real install location. Default: {@link realPathOrSelf}. */
  realpath?: (binaryPath: string) => Promise<string>;
  /** Fold machine paths to `{{TOKENS}}` — `s => ctx.templater.toTemplate(s, ctx.vars)`. */
  toTemplate: (value: string) => string;
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * basename of a command or path, tolerant of BOTH separator flavors regardless
 * of the host OS (a captured command may be shaped for another platform), with
 * a win32 `.exe`/`.cmd` suffix stripped.
 *
 * Used on the restore side to probe whether the BINARY (`serena`) is already on
 * PATH — which is a different string from the PACKAGE that provides it
 * (`serena-agent`, the name a manager installs).
 */
export function commandBaseName(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const base = segments.length > 0 ? (segments[segments.length - 1] as string) : normalized;
  return base.replace(/\.(exe|cmd)$/i, "");
}

/**
 * The executable a command line invokes, or `null` when the first token is not
 * one: empty, or carrying shell syntax (a pipeline, a subshell, inline code).
 * Quote-aware via the WP-B tokenizer, so `"/Users/me/my tools/x" --flag` yields
 * the quoted path rather than its first word.
 */
export function executableToken(command: string): string | null {
  const first = tokenizeCommand(command)[0];
  if (first === undefined) return null;
  const text = first.text.trim();
  if (text === "") return null;
  // A first token containing shell syntax is not a program name we can resolve.
  if (/[|;&()<>\n]/.test(text)) return null;
  return text;
}

/**
 * Directories whose contents ship WITH the operating system. Nothing in them is
 * installable by brew/uv/pipx, so a command resolving here is not an external
 * tool — it is `cat`, `sed`, `/usr/bin/git`. Matched on the REALPATH, so a
 * Homebrew binary merely linked from `/usr/local/bin` still classifies as brew
 * (its realpath points into the Cellar).
 */
const SYSTEM_BINARY_DIRS: readonly string[] = [
  "/bin/",
  "/sbin/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/libexec/",
];

/** True when `realPath` lives in an OS-owned binary directory. */
function isSystemBinary(realPath: string): boolean {
  const normalized = realPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/windows\//i.test(normalized)) return true;
  return SYSTEM_BINARY_DIRS.some((dir) => normalized.startsWith(dir));
}

/**
 * The absolute paths a CaptureResult's files correspond to on THIS machine.
 *
 * `<filesPrefix>/<rel>` (e.g. `claude/files/hooks/x.py`) restores under the tool
 * home; `shared/home/<rel>` restores under $HOME. Every other prefix (memories,
 * shared instructions) names something that is not a referenced binary and is
 * ignored. Pure.
 */
export function capturedAbsolutePaths(
  files: ReadonlyArray<{ repoPath: string }>,
  opts: { home: string; toolHome: string; filesPrefix: string },
): Set<string> {
  const out = new Set<string>();
  const roots: ReadonlyArray<[string, string]> = [
    [`${opts.filesPrefix}/`, opts.toolHome],
    [`${SHARED_HOME_REPO_PREFIX}/`, opts.home],
  ];

  for (const file of files) {
    const repoPath = file.repoPath.replace(/\\/g, "/");
    for (const [prefix, base] of roots) {
      if (!repoPath.startsWith(prefix)) continue;
      out.add(path.join(base, ...repoPath.slice(prefix.length).split("/")));
      break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/** A successfully located binary: where the lookup landed, and its realpath. */
interface ResolvedBinary {
  /** What `resolve` returned (a PATH hit, or the absolute path as written). */
  resolved: string;
  /** {@link ResolvedBinary.resolved} with symlinks followed. */
  real: string;
}

/**
 * Locate one executable, never throwing. `null` means "not on this machine" —
 * which is also what any resolver/realpath failure degrades to, since a tool we
 * cannot see is a tool we must not record.
 */
async function locate(
  lookup: string,
  resolve: (name: string) => Promise<string | null>,
  realpath: (binaryPath: string) => Promise<string>,
): Promise<ResolvedBinary | null> {
  try {
    const resolved = await resolve(lookup);
    if (resolved === null || resolved.trim() === "") return null;
    const real = await realpath(resolved);
    return { resolved, real: real.trim() === "" ? resolved : real };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The collector                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Collect the external tools referenced by `refs`, deduped by `manager:name`
 * with their `usedBy` provenance unioned (the same binary is routinely started
 * by several MCP servers) and deterministically ordered.
 *
 * See the module header for the per-ref pipeline and its cost guarantees.
 */
export async function collectExternalTools(
  refs: readonly CommandRef[],
  opts: CollectExternalToolsOptions,
): Promise<ExternalToolRef[]> {
  const resolve = opts.resolve ?? resolveBinaryPath;
  const realpath = opts.realpath ?? realPathOrSelf;

  /** lookup string -> located binary (or null). One probe per distinct command. */
  const probed = new Map<string, ResolvedBinary | null>();
  const found: ExternalToolRef[] = [];

  for (const ref of refs) {
    const token = executableToken(ref.command);
    if (token === null || isRuntimeCommand(token)) continue;

    // `~/x` and `$HOME/x` become absolute; a bare name stays a PATH lookup. A
    // RELATIVE path (`./bin/x`) is dropped: it only means something next to a
    // working directory we do not know, so resolving it would be a guess.
    const lookup = expandHomePath(token, opts.home) ?? token;
    if (!isAbsolutePath(lookup) && /[\\/]/.test(lookup)) continue;

    if (!probed.has(lookup)) probed.set(lookup, await locate(lookup, resolve, realpath));
    const binary = probed.get(lookup) ?? null;
    if (binary === null) continue;

    // A file this backup already carries, or an OS binary: not installable.
    if (opts.capturedPaths.has(binary.resolved) || opts.capturedPaths.has(binary.real)) continue;
    if (isSystemBinary(binary.real)) continue;

    // null => npm owns it; manifest.npmGlobals already reinstalls it.
    const classified = classifyBinaryPath(binary.real, opts.home);
    if (classified === null) continue;
    // A name derived from a path segment could be anything a filesystem allows;
    // the manifest is read back on another machine and turned into `brew install
    // <name>`, so an unusable name is dropped HERE rather than written out and
    // filtered on the way back in.
    if (!isSafeToolName(classified.name)) continue;

    found.push({
      name: classified.name,
      manager: classified.manager,
      command: opts.toTemplate(token),
      resolvedPath: opts.toTemplate(binary.real),
      usedBy: [ref.source],
    });
  }

  return mergeExternalTools([found]);
}

export default collectExternalTools;
