/**
 * The SanitizerService implementation: secret detection & removal so that
 * secrets NEVER leave the machine.
 *
 * Two layers:
 *   1. DENYLIST (whole-file exclusion). `isDenied(rel)` answers "is this path
 *      universally junk/secret?" using COMMON_DENY ONLY. The per-tool secret
 *      files (auth.json, .credentials.json, *.sqlite, history.jsonl, ...) live in
 *      denylist.ts and are applied by the ADAPTERS, which call
 *      `matchesDeny(rel, denylistFor(tool))` directly — keeping per-tool deny
 *      filtering where the tool context is known. This split is intentional: the
 *      service stays tool-agnostic; adapters own tool-specific exclusion.
 *   2. VALUE REDACTION (in-place). For files that ARE shareable but may contain a
 *      stray credential, `sanitizeText` redacts matches of SECRET_PATTERNS, and
 *      `sanitizeJson` deep-clones a parsed object redacting any value whose KEY
 *      is secret (isSecretKey) or whose VALUE matches a pattern.
 *
 * Pure-ish: operates on strings / already-parsed objects. TOML/JSON parsing and
 * re-serialization are done by callers; only `sanitizeJson` clones a parsed
 * object. No fs, and no system clock.
 */

import type {
  SanitizerService,
  SanitizeResult,
  SecretRef,
  ToolId,
} from "../../types.js";

import { COMMON_DENY, matchesDeny } from "./denylist.js";
import {
  REDACTED,
  SECRET_PATTERNS,
  isSecretContainerKey,
  isSecretKey,
  type SecretPattern,
} from "./patterns.js";

/* -------------------------------------------------------------------------- */
/* Standalone value redaction                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Redact a single scalar value if it looks secret OR if `keyIsSecret` is true.
 * Returns the (possibly unchanged) value and the matched pattern name, if any.
 *
 * - Non-string scalars are returned untouched UNLESS the key is secret, in which
 *   case they collapse to the REDACTED marker (a numeric/boolean "secret" is
 *   still a secret).
 * - Strings: if the key is secret the whole string is replaced; otherwise each
 *   embedded SECRET_PATTERNS match is swapped for REDACTED in place.
 */
export function redactValue(
  value: unknown,
  keyIsSecret = false,
): { value: unknown; matched: string | null } {
  if (keyIsSecret) {
    // Empty strings carry no secret; leave them so we don't manufacture noise.
    if (typeof value === "string" && value.length === 0) {
      return { value, matched: null };
    }
    return { value: REDACTED, matched: "secret-key" };
  }

  if (typeof value !== "string" || value.length === 0) {
    return { value, matched: null };
  }

  let firstMatch: string | null = null;
  let out = value;
  for (const pat of SECRET_PATTERNS) {
    const re = freshRegex(pat.regex);
    if (re.test(out)) {
      if (firstMatch === null) firstMatch = pat.name;
      out = out.replace(freshRegex(pat.regex), REDACTED);
    }
  }
  return { value: out, matched: firstMatch };
}

/* -------------------------------------------------------------------------- */
/* The service factory                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build a SanitizerService. Stateless, so the default export is a shared
 * singleton; a factory is provided for symmetry with the other core services and
 * for tests that want an isolated instance.
 */
export function createSanitizer(): SanitizerService {
  /**
   * Whole-file exclusion check, tool-agnostic. Uses COMMON_DENY only (OS cruft,
   * sqlite, caches). Adapters layer their per-tool denylist on top.
   */
  function isDenied(relativePath: string): boolean {
    return matchesDeny(relativePath, [...COMMON_DENY]);
  }

  /**
   * Redact secret VALUES inside free text. Walks SECRET_PATTERNS, replacing
   * every match with REDACTED, and records one SecretRef per distinct pattern
   * that fired (value-kind). `source` is the file's repo-relative location, used
   * to build a human-readable SecretRef.source like "<source>#<pattern>".
   */
  function sanitizeText(content: string, tool: ToolId, source: string): SanitizeResult {
    const found: SecretRef[] = [];
    let out = content;
    let changed = false;

    for (const pat of SECRET_PATTERNS) {
      if (!freshRegex(pat.regex).test(out)) continue;
      out = out.replace(freshRegex(pat.regex), REDACTED);
      changed = true;
      found.push(valueSecretRef(tool, source, pat));
    }

    return { content: out, found, changed };
  }

  /**
   * Deep-clone a parsed JSON/TOML-ish object, redacting any value whose key is
   * secret (isSecretKey) or whose string value matches a SECRET_PATTERNS entry.
   * Recurses through nested objects and arrays. Never mutates the input.
   *
   * `source` seeds SecretRef.source; each hit appends its key path, e.g.
   * "settings.json#mcpServers.foo.env.API_KEY".
   */
  function sanitizeJson(
    obj: unknown,
    tool: ToolId,
    source: string,
  ): { value: unknown; found: SecretRef[] } {
    const found: SecretRef[] = [];
    const value = cloneRedact(obj, tool, source, "", found);
    return { value, found };
  }

  /**
   * The production sanitizer for STORED file content. For JSON files this routes
   * through the structural, key-name-aware sanitizeJson so opaque secrets under a
   * secret KEY NAME (whose value matches no known token shape) are redacted before
   * they reach the repo — the gap that sanitizeText (value-patterns only) leaves
   * open. Behavior:
   *
   *   - If `source` looks like JSON (".json" basename) AND JSON/JSONC parsing
   *       succeeds: run sanitizeJson on the parsed object, then re-serialize with
   *       the file's detected indentation. Comments/trailing commas are not
   *       preserved, but opaque secrets under secret key names are redacted.
   *   - Otherwise (non-JSON, or JSON/JSONC parsing fails): fall back to the
   *       pattern-based sanitizeText (which still catches known token shapes and
   *       the key-name-aware env-assignment pattern in free text / hook scripts).
   *
   * JSON that fails to parse falling back to sanitizeText is the SAFE choice: we
   * never ship raw unsanitized content, and the value patterns still fire.
   */
  function sanitizeFile(content: string, tool: ToolId, source: string): SanitizeResult {
    if (looksLikeJsonSource(source)) {
      const parsed = parseJsonOrJsonc(content);
      if (!parsed.ok) {
        // Not valid JSON despite the extension — fall back to the text pass.
        return sanitizeText(content, tool, source);
      }
      const { value, found } = sanitizeJson(parsed.value, tool, source);
      const indent = detectJsonIndent(content);
      const serialized = JSON.stringify(value, null, indent);
      return { content: serialized, found, changed: serialized !== content };
    }
    return sanitizeText(content, tool, source);
  }

  return { isDenied, sanitizeText, sanitizeJson, sanitizeFile };
}

/* -------------------------------------------------------------------------- */
/* JSON helpers for sanitizeFile                                               */
/* -------------------------------------------------------------------------- */

/** True if a source path's basename ends in ".json" (case-insensitive). */
function looksLikeJsonSource(source: string): boolean {
  const base = source.replace(/\\/g, "/").split("/").pop() ?? source;
  return /\.json$/i.test(base);
}

function parseJsonOrJsonc(content: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    // Cursor and VS Code-style settings files are commonly JSONC.
  }

  try {
    return { ok: true, value: JSON.parse(stripJsonc(content)) };
  } catch {
    return { ok: false };
  }
}

function stripJsonc(content: string): string {
  return removeTrailingCommas(removeJsonComments(content));
}

function removeJsonComments(content: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") i++;
      if (i < content.length) out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        if (content[i] === "\n") out += "\n";
        i++;
      }
      i++;
      continue;
    }

    out += ch;
  }

  return out;
}

function removeTrailingCommas(content: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < content.length && /\s/.test(content[j]!)) j++;
      if (content[j] === "}" || content[j] === "]") continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Best-effort detection of a JSON document's indentation so re-serialization
 * preserves the file's style. Looks at the whitespace before the first indented
 * line; returns the number of spaces, "\t" for tab-indented files, or 2 as a
 * sensible default. (Exact byte-for-byte preservation is not required — the file
 * is rewritten by the backup either way — but matching the common 2-space style
 * keeps diffs tidy.)
 */
function detectJsonIndent(content: string): number | string {
  const m = /\n([ \t]+)\S/.exec(content);
  if (!m) return 2;
  const ws = m[1]!;
  if (ws.includes("\t")) return "\t";
  return ws.length || 2;
}

/* -------------------------------------------------------------------------- */
/* Internal recursion for sanitizeJson                                         */
/* -------------------------------------------------------------------------- */

/**
 * Recursively clone `node`, redacting secret values. `keyPath` is the dotted
 * path to `node` from the root (for SecretRef.source); `parentKey` is the
 * immediate key under which `node` sits (drives isSecretKey for scalars).
 * `inSecretContainer` is set once the walk descends under an env/environment/
 * headers map and stays set for the whole subtree: env vars are named
 * arbitrarily (KEY, OPENAI_KEY, ...), so EVERY leaf below such a container is
 * treated as secret — mirroring codex's TOML structural pass.
 */
function cloneRedact(
  node: unknown,
  tool: ToolId,
  source: string,
  keyPath: string,
  found: SecretRef[],
  parentKey = "",
  inSecretContainer = false,
): unknown {
  // Arrays: clone element-wise, preserving index in the path.
  if (Array.isArray(node)) {
    return node.map((el, i) =>
      cloneRedact(el, tool, source, joinPath(keyPath, String(i)), found, parentKey, inSecretContainer),
    );
  }

  // Plain objects: clone key-by-key.
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const childInContainer = inSecretContainer || isSecretContainerKey(k);
      out[k] = cloneRedact(v, tool, source, joinPath(keyPath, k), found, k, childInContainer);
    }
    return out;
  }

  // Scalars (string/number/boolean/null/undefined): redact if warranted.
  const keyIsSecret = parentKey.length > 0 && (isSecretKey(parentKey) || inSecretContainer);
  const { value: redacted, matched } = redactValue(node, keyIsSecret);
  if (matched !== null && redacted !== node) {
    found.push({
      tool,
      source: keyPath ? `${source}#${keyPath}` : source,
      key: parentKey || keyPath || "value",
      description: describeMatch(matched, parentKey, keyPath),
      kind: "value",
    });
  }
  return redacted;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** A SecretRef for a free-text pattern hit. */
function valueSecretRef(tool: ToolId, source: string, pat: SecretPattern): SecretRef {
  return {
    tool,
    source: `${source}#${pat.name}`,
    key: pat.name,
    description: `Redacted ${humanizePattern(pat.name)} value in ${source}`,
    kind: "value",
  };
}

/** Build a human-readable description for a sanitizeJson hit. */
function describeMatch(matched: string, parentKey: string, keyPath: string): string {
  if (matched === "secret-key") {
    return `Redacted secret value for key "${parentKey || keyPath}"`;
  }
  return `Redacted ${humanizePattern(matched)} value at "${keyPath}"`;
}

/** Turn a pattern id like "github-token" into "GitHub token"-ish prose. */
function humanizePattern(name: string): string {
  return name.replace(/[-_]/g, " ");
}

/**
 * Return a fresh, lastIndex-reset copy of a (possibly global) regex so that
 * stateful `.test()`/`.replace()` calls never interfere with one another.
 */
function freshRegex(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags);
}

/** True for ordinary `{}`-style objects (not arrays, not class instances). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Join two dotted-path segments, skipping empties. */
function joinPath(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}.${b}`;
}

/* -------------------------------------------------------------------------- */
/* Default singleton                                                           */
/* -------------------------------------------------------------------------- */

/** Shared, stateless sanitizer instance for all non-test callers. */
export const sanitizer: SanitizerService = createSanitizer();

export default sanitizer;
