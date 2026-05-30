/**
 * TemplaterService implementation: machine value <-> {{TOKEN}}.
 *
 * On CAPTURE (toTemplate) we collapse machine-identifying values — the home
 * directory, the tool home, the username — into stable placeholders so the
 * stored files are portable across machines and operating systems. On RESTORE
 * (fromTemplate) we expand those placeholders back into THIS machine's values.
 *
 * Cross-OS matching is the subtle part. A Windows home like `C:\Users\fab` can
 * appear in captured text three ways:
 *   - native backslash:        C:\Users\fab
 *   - JSON-escaped backslash:  C:\\Users\\fab   (each "\" doubled in JSON)
 *   - forward slash:           C:/Users/fab     (many tools normalize to "/")
 * toTemplate must collapse all three to the same token. We do that by matching
 * any path value with a separator class that accepts "/", "\" or "\\" between
 * segments. POSIX paths (single separator style) are a trivial subset.
 *
 * Replacement order: most-specific (longest) value first, so TOOL_HOME collapses
 * before HOME (TOOL_HOME is a child of HOME). orderedReplacements() guarantees
 * this ordering; we simply honor it.
 *
 * Safety choices:
 *   - The OS variable ("darwin" / "linux" / "win32") is metadata, not a machine
 *     path. Blindly replacing the substring "linux" everywhere would corrupt
 *     ordinary prose/config, so toTemplate SKIPS the OS value. {{OS}} is still
 *     expanded by fromTemplate for anyone who references it deliberately.
 *   - Non-path scalar variables (e.g. USER) are matched only at token
 *     boundaries, so a username like "al" cannot rewrite the middle of "also".
 *     Because longer path values are applied first, the username inside a home
 *     path is already gone (folded into {{HOME}}) by the time USER is matched.
 *
 * Libraries: none beyond src/platform + the variable helpers. Pure string work.
 */

import type { TemplateVariables, TemplaterService } from "../../types.js";
import { orderedReplacements, type Replacement } from "./variables.js";

/** Variable names that are descriptive enums, not machine values to fold away. */
const ENUM_ONLY_VARS = new Set<string>(["OS"]);

/** Escape a literal string for safe insertion into a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic: does this value look like a filesystem path (so we should match
 * across separator styles), or a plain scalar (match at boundaries)?
 *
 * True when it contains a path separator, starts with "~", starts with "/", or
 * begins with a Windows drive specifier like "C:".
 */
function looksLikePath(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return true;
  if (value.startsWith("~")) return true;
  if (/^[A-Za-z]:/.test(value)) return true;
  return false;
}

/**
 * Build a RegExp source that matches a path value irrespective of separator
 * style. Each run of separators in the original becomes a class that accepts a
 * forward slash, a single backslash, or a doubled (JSON-escaped) backslash.
 *
 * The leading edge is preserved: a drive prefix is matched, a leading separator
 * (POSIX root, or a UNC double-backslash) is matched with the separator class,
 * and a leading "~" is kept verbatim.
 *
 * `win32` widens the drive letter to a case-insensitive class so a config that
 * stored "c:\Users\fab" still folds against a var of "C:\Users\fab" (§5.2:
 * tools/Node frequently emit the drive letter in the opposite case). The rest of
 * the path stays case-sensitive (Windows is case-preserving for the visible name
 * and folding a different-cased username would be wrong).
 */
function pathVariantSource(value: string, win32: boolean): string {
  // A separator in the source matches "/", "\", or "\\" in the target text.
  const SEP = "(?:\\\\{1,2}|/)";

  // Peel an optional Windows drive specifier so its ":" stays literal.
  const driveMatch = /^([A-Za-z]):/.exec(value);
  const driveLetter = driveMatch ? driveMatch[1]! : "";
  let rest = value.slice(driveLetter ? driveLetter.length + 1 : 0);

  // Detect and peel a leading run of separators (POSIX "/...", UNC "\\...").
  const leadSepMatch = /^[\\/]+/.exec(rest);
  const hasLeadingSep = leadSepMatch !== null;
  if (hasLeadingSep) rest = rest.slice(leadSepMatch![0].length);

  // Detect a trailing run of separators (rare, but keep it round-trippable).
  const trailSepMatch = /[\\/]+$/.exec(rest);
  const hasTrailingSep = trailSepMatch !== null;
  if (hasTrailingSep) rest = rest.slice(0, rest.length - trailSepMatch![0].length);

  const segments = rest.length === 0 ? [] : rest.split(/[\\/]+/);
  const body = segments.map((seg) => escapeRegExp(seg)).join(SEP);

  let source = "";
  if (driveLetter) {
    // On win32 the drive letter is case-insensitive ("[Cc]:"); elsewhere literal.
    source += win32
      ? `[${driveLetter.toUpperCase()}${driveLetter.toLowerCase()}]:`
      : `${escapeRegExp(driveLetter)}:`;
  }
  if (hasLeadingSep) source += SEP;
  source += body;
  if (hasTrailingSep) source += SEP;
  return source;
}

/**
 * Apply a single replacement to `content` for the capture direction.
 * Returns the rewritten content.
 */
function foldValue(content: string, r: Replacement, win32: boolean): string {
  if (looksLikePath(r.value)) {
    const re = new RegExp(pathVariantSource(r.value, win32), "g");
    return content.replace(re, r.token);
  }
  // Plain scalar (e.g. username): only at non-word boundaries so we never split
  // a larger identifier. We approximate a word boundary that also treats "-",
  // "_" and "." as word characters by requiring the surrounding chars not to be
  // [A-Za-z0-9_.-].
  const esc = escapeRegExp(r.value);
  const re = new RegExp(`(?<![A-Za-z0-9_.-])${esc}(?![A-Za-z0-9_.-])`, "g");
  return content.replace(re, r.token);
}

/* -------------------------------------------------------------------------- */
/* Separator-aware expansion (restore direction)                               */
/* -------------------------------------------------------------------------- */

/** Detect the native separator style a path value itself uses. */
function nativeSeparator(value: string): "/" | "\\" {
  return value.includes("\\") ? "\\" : "/";
}

/**
 * Re-emit a Windows path value so that ALL of its separators use `style`
 * ("/", "\" or "\\"). The drive letter and segment names are preserved; only the
 * separators change. POSIX-rooted values (leading "/") keep their root.
 */
function reseparate(value: string, style: "/" | "\\" | "\\\\"): string {
  return value.replace(/[\\/]+/g, style);
}

/**
 * Expand a single path token in the win32 direction, matching the separator
 * style of the text IMMEDIATELY FOLLOWING each occurrence so the rehydrated
 * value joins cleanly onto the path tail (§5.2). This is what makes
 * fromTemplate(toTemplate(x)) === x hold for native-backslash, JSON-doubled
 * backslash, and forward-slash variants alike: the tail keeps whatever style it
 * had on capture, and the prefix is re-emitted in that same style.
 *
 * Detection looks at the characters right after the token:
 *   - "/"                  -> forward slash
 *   - "\\" (two)           -> JSON-doubled backslash
 *   - "\"  (one, lone)     -> single backslash
 *   - anything else / EOL  -> the value's own native style (token stood alone)
 */
function expandPathTokenWin32(content: string, token: string, value: string): string {
  const native = nativeSeparator(value);
  let out = "";
  let i = 0;
  while (i < content.length) {
    const at = content.indexOf(token, i);
    if (at === -1) {
      out += content.slice(i);
      break;
    }
    out += content.slice(i, at);
    const after = content.slice(at + token.length);
    let style: "/" | "\\" | "\\\\";
    if (after.startsWith("/")) {
      style = "/";
    } else if (after.startsWith("\\\\")) {
      style = "\\\\";
    } else if (after.startsWith("\\")) {
      style = "\\";
    } else {
      style = native;
    }
    out += reseparate(value, style);
    i = at + token.length;
  }
  return out;
}

/**
 * Create a TemplaterService. Stateless; the singleton below is the normal entry
 * point, but a factory is exported so callers/tests can hold their own instance.
 */
export function createTemplater(): TemplaterService {
  function toTemplate(content: string, vars: TemplateVariables): string {
    const win32 = vars.OS === "win32";
    let out = content;
    for (const r of orderedReplacements(vars)) {
      // Enum-style variables (OS) are descriptive metadata, not values to fold.
      if (ENUM_ONLY_VARS.has(r.name)) continue;
      out = foldValue(out, r, win32);
    }
    return out;
  }

  function fromTemplate(content: string, vars: TemplateVariables): string {
    const win32 = vars.OS === "win32";
    let out = content;
    // Order is irrelevant for expansion (tokens are unique literals), but we
    // reuse orderedReplacements for a single source of truth over the var set.
    for (const r of orderedReplacements(vars)) {
      // On win32, path-valued tokens are expanded with separators that match the
      // text right after the token, so a value's tail (which kept its original
      // separator style on capture) joins cleanly to the rehydrated prefix and
      // the round-trip is exact + the result is valid JSON/TOML. Non-path tokens
      // (USER, OS) and POSIX paths are a plain literal substitution.
      if (win32 && r.name !== "OS" && looksLikePath(r.value)) {
        out = expandPathTokenWin32(out, r.token, r.value);
      } else {
        out = out.split(r.token).join(r.value);
      }
    }
    return out;
  }

  return { toTemplate, fromTemplate };
}

/** Default singleton TemplaterService. */
export const templater: TemplaterService = createTemplater();

export default templater;
