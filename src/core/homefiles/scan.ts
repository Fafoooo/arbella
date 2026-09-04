/**
 * Command → $HOME path scanner: the pure half of `shared/home` capture.
 *
 * A restored settings.json is only useful if the scripts it POINTS AT come with
 * it. Hooks, statusline commands and MCP server commands routinely reference
 * files that live in $HOME but OUTSIDE every tool home — `~/.agents/hooks/
 * dispatch.sh`, `~/.local/bin/serena-mcp-start`, `~/.agents/router/ensure.sh`.
 * Restoring the config without those files leaves a setup that fails on every
 * prompt. This module answers one question, deterministically and without ever
 * touching the filesystem:
 *
 *     "given this command line, which $HOME-relative files does it reference?"
 *
 * Two exports carry the work:
 *   - {@link collectCommandRefs} walks any JSON-ish config value and yields one
 *     {@link CommandRef} per object that has a string `command` (hooks entries,
 *     statusLine, MCP server defs — the shape is the same everywhere). WHICH
 *     files/subtrees to feed it stays in the adapters; this module knows nothing
 *     about Claude or Codex.
 *   - {@link extractHomePathCandidates} tokenizes one ref (quote-aware) and
 *     returns the absolute, under-$HOME paths it mentions.
 *
 * Deliberately conservative: a token that is not clearly a path (shell operators,
 * inline `node -e "…"` code, anything outside $HOME, anything with a ".." escape)
 * is dropped rather than guessed at. A missed script is a warning in the user's
 * log; a wrong one would be a file copied into a backup repo for no reason.
 *
 * Pure module: no fs, no clock, no process, no injected services.
 */

import { isPlainObject } from "../../utils/object.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** One command line found in a tool config, with where it came from. */
export interface CommandRef {
  /** The command as written, e.g. `bash ~/.agents/hooks/dispatch.sh --json`. */
  command: string;
  /** Separately-listed arguments (MCP server defs use these). */
  args?: string[];
  /** Provenance label, e.g. "claude:settings.json#hooks.PreToolUse[1].hooks[0]". */
  source: string;
}

/* -------------------------------------------------------------------------- */
/* Path primitives (shared with capture/restore)                               */
/* -------------------------------------------------------------------------- */

/** Prefixes that stand in for the user's home directory in a config value. */
const HOME_PREFIXES = ["~/", "$HOME/", "${HOME}/"] as const;

/** Normalize any separator flavor to POSIX and drop a trailing slash. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True for `/x`, `C:\x`, `C:/x`, and UNC `\\server\share`. */
export function isAbsolutePath(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

/**
 * Join a home-relative remainder onto `home`, using whichever separator flavor
 * `home` itself is written in (so a win32 home yields a win32 path).
 */
export function joinUnderHome(home: string, rest: string): string {
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const parts = rest.split(/[\\/]/).filter((s) => s.length > 0);
  return [home.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/**
 * True when `candidate` is a real descendant of `home`. Comparison is
 * case-SENSITIVE (a case-insensitive match would let `~/.ENV` slip past a
 * denylist entry) and separator-agnostic. A path containing a ".." segment is
 * rejected outright: it can climb back out of $HOME after the prefix check.
 */
export function isUnderHome(candidate: string, home: string): boolean {
  const c = toPosix(candidate);
  const h = toPosix(home);
  if (h === "" || c.length <= h.length + 1) return false;
  if (!c.startsWith(`${h}/`)) return false;
  return !c.split("/").includes("..");
}

/**
 * The POSIX path of `abs` relative to `home`, or null when `abs` is not a
 * descendant of `home`. The result is what `shared/home/<rel>` is built from.
 */
export function homeRelativePosix(home: string, abs: string): string | null {
  if (!isUnderHome(abs, home)) return null;
  return toPosix(abs).slice(toPosix(home).length + 1);
}

/**
 * Expand a config token into an absolute path, or null when it is not one.
 * Handles `~/`, `$HOME/`, `${HOME}/` and already-absolute paths; everything
 * else (a bare command name, a flag, a literal) yields null.
 */
export function expandHomePath(token: string, home: string): string | null {
  for (const prefix of HOME_PREFIXES) {
    if (token.startsWith(prefix)) return joinUnderHome(home, token.slice(prefix.length));
  }
  return isAbsolutePath(token) ? token : null;
}

/* -------------------------------------------------------------------------- */
/* Tokenizing                                                                  */
/* -------------------------------------------------------------------------- */

/** One shell-ish token plus whether any part of it was quoted. */
interface Token {
  text: string;
  quoted: boolean;
}

/**
 * Split a command line on whitespace, honoring single and double quotes. Quotes
 * are consumed (they are not part of the path) but the fact that a token WAS
 * quoted is kept, because that is the signal that distinguishes a quoted path
 * from an inline script body.
 */
export function tokenizeCommand(command: string): Token[] {
  const tokens: Token[] = [];
  let buf = "";
  let quoted = false;
  let open: '"' | "'" | null = null;
  let started = false;

  const flush = (): void => {
    if (started) tokens.push({ text: buf, quoted });
    buf = "";
    quoted = false;
    started = false;
  };

  for (const ch of command) {
    if (open !== null) {
      if (ch === open) open = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      open = ch;
      quoted = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    buf += ch;
    started = true;
  }
  flush();
  return tokens;
}

/** Shell operators that mark a token as syntax rather than a path. */
function isShellNoise(text: string): boolean {
  return (
    text.includes("|") ||
    text.includes(";") ||
    text.includes("&&") ||
    text.includes(">(")
  );
}

/**
 * True for a quoted token that is clearly inline CODE rather than a path — the
 * `node -e "…"` / `python -c "…"` case. A newline or an opening paren inside a
 * quoted token is never part of a filename we would want to carry.
 */
function isInlineCode(token: Token): boolean {
  return token.quoted && (token.text.includes("\n") || token.text.includes("("));
}

/**
 * Script suffixes that identify a token as an executable being INVOKED rather
 * than a filename that merely contains spaces.
 */
const SCRIPT_EXTENSIONS = [".sh", ".py", ".js", ".mjs", ".rb", ".pl"] as const;

/**
 * The script path at the head of an inline command line, or null when the token
 * is not one.
 *
 * `sh -c "~/.agents/hooks/dispatch.sh --json"` puts a whole command line inside a
 * SINGLE token: taking it as a filename yields a path that exists nowhere, and
 * the script the hook actually needs is never carried. But `"~/My Scripts/run.sh"`
 * is also a single token with whitespace in it — and there IS a file at that
 * path. Nothing about the token can distinguish the two, so the rule is narrow,
 * deterministic, and documented:
 *
 *   a token is an inline command line iff its FIRST word ends in a script
 *   extension (.sh/.py/.js/.mjs/.rb/.pl) AND is followed by more words.
 *
 * `~/.agents/hooks/dispatch.sh --json` matches (first word `dispatch.sh`, then
 * `--json`) and yields the script. `~/My Scripts/run.sh` does not (its first word
 * is `~/My`) and is kept whole, as is `~/My Scripts/run.sh --json` — a
 * space-containing path with arguments is unresolvable either way, and keeping it
 * whole at least fails as a missing file rather than capturing `~/My`.
 *
 * Pure: `text` is the token's inner text, already unquoted by the tokenizer.
 */
function inlineCommandLead(text: string): string | null {
  const inner = tokenizeCommand(text);
  // Fewer than two words => nothing followed the extension => not a command line.
  if (inner.length < 2) return null;
  const first = inner[0]!.text;
  return SCRIPT_EXTENSIONS.some((ext) => first.endsWith(ext)) ? first : null;
}

/* -------------------------------------------------------------------------- */
/* The scanner                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every distinct absolute path under `home` that this command reference
 * mentions, in first-seen order.
 *
 * Both the tokenized `command` and each entry of `args` are considered (`args`
 * entries are literal — they are NOT re-tokenized, since an argument may
 * legitimately contain spaces). A single token that turns out to hold a whole
 * command line (`sh -c "~/x.sh --json"`, `bash -lc "…"`) contributes the script
 * at its head instead of itself — see {@link inlineCommandLead} for the exact
 * rule. A trailing `:*` (Claude's permission-rule syntax) is stripped before the
 * path test.
 */
export function extractHomePathCandidates(ref: CommandRef, home: string): string[] {
  if (home.trim() === "") return [];

  const tokens: Token[] = [
    ...tokenizeCommand(ref.command),
    ...(ref.args ?? []).map((a) => ({ text: a, quoted: false })),
  ];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (token.text === "" || isInlineCode(token)) continue;
    // A `sh -c "<script> <args>"` token stands for its leading script; every
    // other token stands for itself. The shell-operator check runs on whichever
    // one we ended up with, so `sh -c "~/x.sh | tee log"` still yields ~/x.sh
    // while a bare `~/a.sh;rm -rf /` is still dropped whole.
    const candidate = inlineCommandLead(token.text) ?? token.text;
    if (isShellNoise(candidate)) continue;
    const text = candidate.endsWith(":*") ? candidate.slice(0, -2) : candidate;
    const abs = expandHomePath(text, home);
    if (abs === null || !isUnderHome(abs, home)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Generic config walk                                                         */
/* -------------------------------------------------------------------------- */

/** Depth guard so a pathological config can never blow the stack. */
const MAX_WALK_DEPTH = 12;

/** Every string element of an array value, or undefined when there is none. */
function stringArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const args = value.filter((v): v is string => typeof v === "string");
  return args.length > 0 ? args : undefined;
}

/**
 * Walk a parsed config value and collect every command reference in it.
 *
 * The shape recognized is universal across the tools arbella supports: ANY
 * object with a string `command` property is a command reference, and an
 * adjacent `args` array supplies its arguments. That covers Claude's
 * `hooks.<Event>[i].hooks[j]`, its `statusLine`, `mcpServers.<name>`,
 * `~/.claude.json#mcpServers`, Codex's `hooks.json` entries and its
 * `[mcp_servers.<name>]` tables — without this module knowing any of them by
 * name. The caller decides WHICH value to hand over (and therefore which keys
 * are ever looked at); this function never reads a file.
 *
 * `source` labels the root; children are labeled `<source>#<key>` at the first
 * level and `<parent>.<key>` / `<parent>[<i>]` below it, producing provenance
 * strings like `claude:settings.json#hooks.PreToolUse[1].hooks[0]`.
 */
export function collectCommandRefs(value: unknown, source: string): CommandRef[] {
  const out: CommandRef[] = [];
  walkForCommands(value, source, 0, out);
  return out;
}

function walkForCommands(
  node: unknown,
  label: string,
  depth: number,
  out: CommandRef[],
): void {
  if (depth > MAX_WALK_DEPTH) return;

  if (Array.isArray(node)) {
    node.forEach((child, i) => walkForCommands(child, `${label}[${i}]`, depth + 1, out));
    return;
  }
  if (!isPlainObject(node)) return;

  if (typeof node.command === "string" && node.command.trim() !== "") {
    const args = stringArgs(node.args);
    out.push({ command: node.command, ...(args ? { args } : {}), source: label });
  }

  const join = depth === 0 ? "#" : ".";
  for (const [key, child] of Object.entries(node)) {
    if (key === "command" || key === "args") continue;
    walkForCommands(child, `${label}${join}${key}`, depth + 1, out);
  }
}
