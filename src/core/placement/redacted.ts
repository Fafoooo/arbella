/**
 * Redacted-value handling for live configs (pure). A repo file may carry the
 * REDACTED marker where a secret used to be; placing it verbatim would break the
 * local tool. These helpers merge the real local value back in, or report the
 * key as missing. Never logs or returns anything but key paths for omissions.
 */
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { REDACTED } from "../sanitizer/patterns.js";
import { detectJsonIndent, parseJsonOrJsonc } from "../sanitizer/index.js";

type Plain = Record<string, unknown>;

export const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep check: does any string inside `v` contain the marker? */
export function hasMarker(v: unknown): boolean {
  if (typeof v === "string") return v.includes(REDACTED);
  if (Array.isArray(v)) return v.some(hasMarker);
  if (isPlain(v)) return Object.values(v).some(hasMarker);
  return false;
}

/**
 * Keys that say WHERE a server's secrets go. When one differs between the repo
 * and the local object, no real local value may be reused inside that object:
 * it would be handed to a different executable or endpoint.
 */
const BINDING_KEYS = ["command", "args", "url"] as const;

/** Equal, or equal once the repo's marker stands for the local real value (e.g. `--token <marker>`). */
const sameBinding = (repo: unknown, local: unknown): boolean =>
  isDeepStrictEqual(repo, local) ||
  (hasMarker(repo) &&
    local !== undefined &&
    matchesWithSecrets(JSON.stringify(repo), JSON.stringify(local)));

const bindingChanged = (repo: Plain, local: Plain): boolean =>
  BINDING_KEYS.some((k) => !sameBinding(repo[k], local[k]));

/**
 * Merge a repo value (may contain markers) with the local one. A marker leaf (a
 * string, or an array containing a marker) takes the local value at the same key
 * path when that is real; otherwise only that key is omitted and its path
 * reported. A local marker counts as no value. Inside an object whose binding
 * keys (command, args, url) differ from the local object, no local value is
 * reused: such a leaf is omitted and its path listed in `unsafe` instead.
 */
export function mergeRedacted(
  repo: unknown,
  local: unknown,
): { value: unknown; missing: string[][]; unsafe: string[][] } {
  if (!isPlain(repo)) return { value: repo, missing: [], unsafe: [] };
  return mergeObject(repo, isPlain(local) ? local : undefined, true, []);
}

function mergeObject(
  repo: Plain,
  local: Plain | undefined,
  reuse: boolean,
  path: string[],
): { value: Plain; missing: string[][]; unsafe: string[][] } {
  const value: Plain = {};
  const missing: string[][] = [];
  const unsafe: string[][] = [];
  const trusted = reuse && !(local && bindingChanged(repo, local));
  for (const [key, rv] of Object.entries(repo)) {
    const lv = local?.[key];
    const here = [...path, key];
    if (isPlain(rv)) {
      const sub = mergeObject(rv, isPlain(lv) ? lv : undefined, trusted, here);
      value[key] = sub.value;
      missing.push(...sub.missing);
      unsafe.push(...sub.unsafe);
    } else if (hasMarker(rv)) {
      if (lv === undefined || hasMarker(lv)) missing.push(here);
      else if (trusted) value[key] = lv;
      else unsafe.push(here);
    } else {
      value[key] = rv;
    }
  }
  return { value, missing, unsafe };
}

export function structuredKind(dest: string): "json" | "toml" | undefined {
  if (/\.jsonc?$/i.test(dest)) return "json";
  if (/\.toml$/i.test(dest)) return "toml";
  return undefined;
}

export function parseStructured(kind: "json" | "toml", text: string): unknown {
  if (kind === "json") {
    const r = parseJsonOrJsonc(text);
    return r.ok ? r.value : undefined;
  }
  try {
    return parseToml(text);
  } catch {
    return undefined;
  }
}

/**
 * Merge a structured repo file with the local file. Without a marker the repo
 * text is returned byte-identical. Undefined when the repo text does not parse
 * to an object (the caller then falls back to the plain text rule).
 */
export function mergeRedactedText(
  kind: "json" | "toml",
  repoText: string,
  localText?: string,
): { text: string; missing: string[][]; unsafe: string[][] } | undefined {
  if (!repoText.includes(REDACTED)) return { text: repoText, missing: [], unsafe: [] };
  const repo = parseStructured(kind, repoText);
  if (!isPlain(repo)) return undefined;
  const local = localText === undefined ? undefined : parseStructured(kind, localText);
  const { value, missing, unsafe } = mergeRedacted(repo, local);
  return { text: serialize(kind, value as Plain, repoText), missing, unsafe };
}

/** `value` as `kind` text; JSON keeps the indent and trailing newline of `like`. */
function serialize(kind: "json" | "toml", value: Plain, like: string): string {
  if (kind === "toml") return stringifyToml(value);
  const nl = like.endsWith("\n") ? "\n" : "";
  return JSON.stringify(value, null, detectJsonIndent(like)) + nl;
}

/**
 * Repair a local document broken by the old sanitizer. Starts from the LOCAL
 * value: each local marker leaf (same leaf rule as the merge) takes the repo's
 * value at the same key path when that is real; otherwise the key is omitted
 * and its path reported. Everything else local stays, local-only keys included.
 */
export function repairRedacted(
  local: unknown,
  repo: unknown,
): { value: unknown; missing: string[][] } {
  if (!isPlain(local)) return { value: local, missing: [] };
  return repairObject(local, isPlain(repo) ? repo : {}, []);
}

function repairObject(
  local: Plain,
  repo: Plain,
  path: string[],
): { value: Plain; missing: string[][] } {
  const value: Plain = {};
  const missing: string[][] = [];
  for (const [key, lv] of Object.entries(local)) {
    const rv = repo[key];
    const here = [...path, key];
    if (isPlain(lv)) {
      const sub = repairObject(lv, isPlain(rv) ? rv : {}, here);
      value[key] = sub.value;
      missing.push(...sub.missing);
    } else if (hasMarker(lv)) {
      if (rv !== undefined && !hasMarker(rv)) value[key] = rv;
      else missing.push(here);
    } else {
      value[key] = lv;
    }
  }
  return { value, missing };
}

/** {@link repairRedacted} on text. Undefined when the local text does not parse to an object. */
export function repairRedactedText(
  kind: "json" | "toml",
  localText: string,
  repoText: string,
): { text: string; missing: string[][]; unsafe: string[][] } | undefined {
  const local = parseStructured(kind, localText);
  if (!isPlain(local)) return undefined;
  const { value, missing } = repairRedacted(local, parseStructured(kind, repoText));
  // Starts from the local file, so no local value travels anywhere.
  return { text: serialize(kind, value as Plain, localText), missing, unsafe: [] };
}

/**
 * Does `text` equal `pattern` with every marker in the pattern replaced by >= 1
 * char of a single line (a gap never holds "\n")? Linear leftmost-first scan:
 * exact for single-star globs, and still exact with the line rule, since a later
 * match only widens the gap. No regex is built from file content.
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  const segs = pattern.split(REDACTED);
  if (segs.length === 1) return pattern === text;
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;
  const end = text.length - last.length;
  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  // Next "\n" at or after the gap start; only rescanned once the scan passes it.
  let nl = text.indexOf("\n", first.length);
  const oneLine = (from: number, to: number): boolean => {
    if (nl !== -1 && nl < from) nl = text.indexOf("\n", from);
    return nl === -1 || nl >= to;
  };
  let pos = first.length;
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const j = text.indexOf(seg, pos + 1);
    if (j < pos + 1 || j + seg.length > end || !oneLine(pos, j)) return false;
    pos = j + seg.length;
  }
  return end - pos >= 1 && oneLine(pos, end);
}

/** Local text equals repo text with real values in place of markers. A local marker is never a real value. */
export function matchesWithSecrets(repoText: string, localText: string): boolean {
  return !localText.includes(REDACTED) && wildcardMatch(repoText, localText);
}

/** Local text is the repo text with some values replaced by markers (a file broken by the old sanitizer). */
export function isRedactedFormOf(localText: string, repoText: string): boolean {
  return localText.includes(REDACTED) && wildcardMatch(localText, repoText);
}

/** Key paths of the marker leaves (same leaf rule as the merge). */
export function markerPaths(repo: unknown, path: string[] = []): string[][] {
  if (!isPlain(repo)) return [];
  return Object.entries(repo).flatMap(([k, v]) =>
    isPlain(v) ? markerPaths(v, [...path, k]) : hasMarker(v) ? [[...path, k]] : [],
  );
}

function withoutPath(node: unknown, path: string[]): unknown {
  if (!isPlain(node)) return node;
  const [head, ...rest] = path;
  if (head === undefined || !(head in node)) return node;
  if (rest.length === 0) {
    const { [head]: _dropped, ...others } = node;
    return others;
  }
  return { ...node, [head]: withoutPath(node[head], rest) };
}

/**
 * Canonical text of a structured file with the given key paths removed, used as
 * a ledger hash input so a locally filled-in secret does not look like an edit.
 */
export function secretBlindText(
  kind: "json" | "toml",
  text: string,
  paths: string[][],
): string | undefined {
  const doc = parseStructured(kind, text);
  if (!isPlain(doc)) return undefined;
  return JSON.stringify(paths.reduce(withoutPath, doc as unknown));
}

const MCP_ROOTS = new Set(["mcpServers", "mcp_servers"]);
const MCP_SECRET_MAPS = new Set(["env", "headers", "http_headers", "env_http_headers"]);

/** Text safe for one report line: no control characters (escape sequences, newlines). */
export const plain = (s: string): string => s.replace(/\p{C}/gu, "");

/** `p` with the home directory shown as "~". */
export const tildify = (p: string, home: string): string =>
  p === home ? "~" : p.startsWith(home + "/") || p.startsWith(home + "\\") ? "~" + p.slice(home.length) : p;

/**
 * One report line body, e.g. "codex mcp unifi-network → UNIFI_NETWORK_PASSWORD"
 * or "claude ~/.claude/settings.json → env.API_TOKEN".
 */
export function describeMissingSecret(
  e: { tool: string; file: string; keyPath: string[] },
  home: string,
): string {
  const p = e.keyPath.map(plain);
  const i = p.findIndex((s) => MCP_ROOTS.has(s));
  if (i >= 0 && p.length === i + 4 && MCP_SECRET_MAPS.has(p[i + 2]!)) {
    return `${plain(e.tool)} mcp ${p[i + 1]} → ${p[i + 3]}`;
  }
  return `${plain(e.tool)} ${plain(tildify(e.file, home))} → ${p.join(".")}`;
}
