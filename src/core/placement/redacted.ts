/**
 * Redacted-value handling for live configs (pure). A repo file may carry the
 * REDACTED marker where a secret used to be; placing it verbatim would break the
 * local tool. These helpers merge the real local value back in, or report the
 * key as missing. Never logs or returns anything but key paths for omissions.
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { REDACTED } from "../sanitizer/patterns.js";
import { detectJsonIndent, parseJsonOrJsonc } from "../sanitizer/index.js";

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep check: does any string inside `v` contain the marker? */
export function hasMarker(v: unknown): boolean {
  if (typeof v === "string") return v.includes(REDACTED);
  if (Array.isArray(v)) return v.some(hasMarker);
  if (isPlain(v)) return Object.values(v).some(hasMarker);
  return false;
}

/**
 * Merge a repo value (may contain markers) with the local one. A marker leaf (a
 * string, or an array containing a marker) takes the local value at the same key
 * path when that is real; otherwise only that key is omitted and its path
 * reported. A local marker counts as no value.
 */
export function mergeRedacted(
  repo: unknown,
  local: unknown,
): { value: unknown; missing: string[][] } {
  if (!isPlain(repo)) return { value: repo, missing: [] };
  return mergeObject(repo, isPlain(local) ? local : {}, []);
}

function mergeObject(
  repo: Plain,
  local: Plain,
  path: string[],
): { value: Plain; missing: string[][] } {
  const value: Plain = {};
  const missing: string[][] = [];
  for (const [key, rv] of Object.entries(repo)) {
    const lv = local[key];
    const here = [...path, key];
    if (isPlain(rv)) {
      const sub = mergeObject(rv, isPlain(lv) ? lv : {}, here);
      value[key] = sub.value;
      missing.push(...sub.missing);
    } else if (hasMarker(rv)) {
      if (lv !== undefined && !hasMarker(lv)) value[key] = lv;
      else missing.push(here);
    } else {
      value[key] = rv;
    }
  }
  return { value, missing };
}

export function structuredKind(dest: string): "json" | "toml" | undefined {
  if (/\.jsonc?$/i.test(dest)) return "json";
  if (/\.toml$/i.test(dest)) return "toml";
  return undefined;
}

function parseKind(kind: "json" | "toml", text: string): unknown {
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
): { text: string; missing: string[][] } | undefined {
  if (!repoText.includes(REDACTED)) return { text: repoText, missing: [] };
  const repo = parseKind(kind, repoText);
  if (!isPlain(repo)) return undefined;
  const local = localText === undefined ? undefined : parseKind(kind, localText);
  const { value, missing } = mergeRedacted(repo, local);
  if (kind === "toml") return { text: stringifyToml(value as Plain), missing };
  const nl = repoText.endsWith("\n") ? "\n" : "";
  return { text: JSON.stringify(value, null, detectJsonIndent(repoText)) + nl, missing };
}

/**
 * Does `localText` equal `repoText` with every marker replaced by a real value
 * of >= 1 char? Linear leftmost-first scan (exact for single-star globs); no
 * regex is built from file content. A local marker is never a real value.
 */
export function matchesWithSecrets(repoText: string, localText: string): boolean {
  if (localText.includes(REDACTED)) return false;
  const segs = repoText.split(REDACTED);
  if (segs.length === 1) return repoText === localText;
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;
  const end = localText.length - last.length;
  if (!localText.startsWith(first) || !localText.endsWith(last)) return false;
  let pos = first.length;
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const j = localText.indexOf(seg, pos + 1);
    if (j < pos + 1 || j + seg.length > end) return false;
    pos = j + seg.length;
  }
  return end - pos >= 1;
}

const MCP_ROOTS = new Set(["mcpServers", "mcp_servers"]);
const MCP_SECRET_MAPS = new Set(["env", "headers", "http_headers", "env_http_headers"]);

/** One report line body, e.g. "codex mcp unifi-network → UNIFI_NETWORK_PASSWORD". */
export function describeMissingSecret(e: { tool: string; file: string; keyPath: string[] }): string {
  const p = e.keyPath;
  const i = p.findIndex((s) => MCP_ROOTS.has(s));
  if (i >= 0 && p.length === i + 4 && MCP_SECRET_MAPS.has(p[i + 2]!)) {
    return `${e.tool} mcp ${p[i + 1]} → ${p[i + 3]}`;
  }
  const segs = e.file.split(/[\\/]/);
  const home = segs.lastIndexOf(`.${e.tool}`);
  const rel = home >= 0 && home < segs.length - 1 ? segs.slice(home + 1).join("/") : segs[segs.length - 1];
  return `${e.tool} ${rel} → ${p.join(".")}`;
}
