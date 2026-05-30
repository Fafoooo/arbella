/**
 * config.toml processing for the Codex adapter — the trickiest piece.
 *
 * Responsibility:
 *   - parse `config.toml` with smol-toml;
 *   - REDACT secret VALUES under [mcp_servers.*] (env maps, headers, tokens) and
 *     [shell_environment_policy.set] using the sanitizer's key-name + value
 *     pattern detection;
 *   - DROP [hooks.state.*] tables entirely (machine-specific trusted hashes, and
 *     their KEYS embed absolute paths — never useful on another machine);
 *   - extract [plugins."name@marketplace"] -> PluginEntry and
 *     [marketplaces.name]   -> MarketplaceEntry for the reinstall manifest;
 *   - TEMPLATE absolute machine paths — both in VALUES (mcp command/args, etc.)
 *     and in [projects."/abs/path"] KEYS — via templater.toTemplate over the
 *     re-stringified text (the templater is path-aware and separator-agnostic, so
 *     it folds paths regardless of whether they sit in a value or a quoted key);
 *   - KEEP scalars / [features] / [tui.*] / [notice.*] / [projects.*] (trust
 *     levels, with their path keys templated).
 *
 * On restore, rehydrateConfigToml() expands the {{TOKENS}} back to this machine's
 * paths. Plugins/marketplaces are reinstalled via the CLI (see restore.ts), not
 * by editing the TOML, but project/mcp paths must be rehydrated so a written-back
 * config.toml points at the right local directories.
 *
 * Libraries: smol-toml (parse/stringify), the sanitizer patterns (isSecretKey +
 * SECRET_PATTERNS + REDACTED), and the injected templater. No fs, no clock.
 */

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import type {
  MarketplaceEntry,
  PluginEntry,
  SecretRef,
  TemplaterService,
  TemplateVariables,
} from "../../types.js";
import { isSecretKey, REDACTED, SECRET_PATTERNS } from "../../core/sanitizer/patterns.js";

/** Result of processing a raw config.toml on capture. */
export interface ParsedCodexConfig {
  /** The sanitized + templated TOML text to store (for the frozen config.toml). */
  sanitizedToml: string;
  /** Plugins parsed from [plugins."name@marketplace"] { enabled }. */
  plugins: PluginEntry[];
  /** Marketplaces parsed from [marketplaces.name] { source_type, source }. */
  marketplaces: MarketplaceEntry[];
  /** Any redacted values (mcp_servers env/headers, shell_environment_policy.set). */
  secrets: SecretRef[];
}

/** A loosely-typed TOML table (object). */
type TomlTable = Record<string, unknown>;

/** Narrow an unknown value to a plain object table (not array, not null). */
function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redact secret VALUES inside an arbitrary TOML subtree IN PLACE.
 *
 * A value is redacted when EITHER its key name denotes a secret (isSecretKey) OR
 * its string value matches a known secret pattern. Objects and arrays are walked
 * recursively. Every redaction appends a SecretRef (kind:"value") whose `source`
 * pinpoints the dotted path inside config.toml.
 *
 * `keyIsSecretContext` forces redaction of *all* string leaves regardless of the
 * leaf key — used for env/headers maps where the table key (e.g. "env") is itself
 * a secret container and the inner keys are arbitrary variable names.
 */
function redactSubtree(
  node: unknown,
  dottedPath: string,
  secrets: SecretRef[],
  keyIsSecretContext: boolean,
): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const child = node[i];
      if (typeof child === "string") {
        if (keyIsSecretContext || valueLooksSecret(child)) {
          node[i] = REDACTED;
          secrets.push(makeValueSecret(`${dottedPath}[${i}]`));
        }
      } else if (isTable(child) || Array.isArray(child)) {
        redactSubtree(child, `${dottedPath}[${i}]`, secrets, keyIsSecretContext);
      }
    }
    return;
  }

  if (!isTable(node)) return;

  for (const key of Object.keys(node)) {
    const child = node[key];
    const childPath = dottedPath ? `${dottedPath}.${key}` : key;
    const secretContext = keyIsSecretContext || isSecretKey(key) || isSecretContainerKey(key);

    if (typeof child === "string") {
      if (secretContext || valueLooksSecret(child)) {
        node[key] = REDACTED;
        secrets.push(makeValueSecret(childPath));
      }
    } else if (isTable(child) || Array.isArray(child)) {
      // For container keys ("env", "headers", "set", ...) every leaf below is
      // treated as secret; otherwise recurse with normal per-key detection.
      redactSubtree(child, childPath, secrets, secretContext);
    }
    // numbers / booleans are never secret values we can meaningfully redact.
  }
}

/**
 * Keys whose entire SUBTREE of string values should be treated as secret,
 * regardless of the inner variable names. These are the standard MCP/credential
 * container maps.
 */
function isSecretContainerKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === "env" ||
    k === "environment" ||
    k === "headers" ||
    k === "header" ||
    k === "set" || // [shell_environment_policy.set]
    k === "secrets" ||
    k === "credentials"
  );
}

/** True if a free string value matches any known secret-value pattern. */
function valueLooksSecret(value: string): boolean {
  for (const p of SECRET_PATTERNS) {
    // Patterns carry the global flag; reset lastIndex before each test so a
    // shared RegExp object does not skip on subsequent calls.
    p.regex.lastIndex = 0;
    if (p.regex.test(value)) return true;
  }
  return false;
}

/** Build a value-kind SecretRef for a redacted config.toml leaf. */
function makeValueSecret(dottedPath: string): SecretRef {
  return {
    tool: "codex",
    source: `config.toml#${dottedPath}`,
    key: dottedPath,
    description: `Redacted secret value in config.toml at ${dottedPath}`,
    kind: "value",
  };
}

/**
 * Parse [plugins."name@marketplace"] tables into PluginEntry[].
 * Each plugin key is "name@marketplace"; the table carries { enabled }.
 */
function extractPlugins(root: TomlTable): PluginEntry[] {
  const out: PluginEntry[] = [];
  const plugins = root["plugins"];
  if (!isTable(plugins)) return out;

  for (const id of Object.keys(plugins)) {
    const entry = plugins[id];
    const atIdx = id.lastIndexOf("@");
    const name = atIdx >= 0 ? id.slice(0, atIdx) : id;
    const marketplace = atIdx >= 0 ? id.slice(atIdx + 1) : undefined;
    let enabled = true;
    if (isTable(entry) && typeof entry["enabled"] === "boolean") {
      enabled = entry["enabled"] as boolean;
    }
    const plugin: PluginEntry = {
      id,
      name,
      enabled,
      // Codex plugins captured here are user-global config; restore reinstalls them.
      scope: "user",
    };
    if (marketplace) plugin.marketplace = marketplace;
    out.push(plugin);
  }
  return out;
}

/**
 * Parse [marketplaces.name] tables into MarketplaceEntry[].
 * Each table carries { source_type, source }. Codex uses source_type "git" with a
 * clone URL (verified), or "github"/"local"; default unknown types to "git".
 */
function extractMarketplaces(root: TomlTable): MarketplaceEntry[] {
  const out: MarketplaceEntry[] = [];
  const marketplaces = root["marketplaces"];
  if (!isTable(marketplaces)) return out;

  for (const id of Object.keys(marketplaces)) {
    const entry = marketplaces[id];
    if (!isTable(entry)) continue;
    const rawType = typeof entry["source_type"] === "string" ? (entry["source_type"] as string) : "git";
    const source = typeof entry["source"] === "string" ? (entry["source"] as string) : "";
    const sourceType: MarketplaceEntry["sourceType"] =
      rawType === "github" || rawType === "git" || rawType === "local" ? rawType : "git";
    out.push({ id, sourceType, source });
  }
  return out;
}

/**
 * Parse raw config.toml text and produce sanitized output + manifest pieces.
 *
 * Steps:
 *   1. parse with smol-toml;
 *   2. extract plugins + marketplaces (BEFORE mutation, so the entries are clean);
 *   3. redact secret values across [mcp_servers.*] and [shell_environment_policy*]
 *      (and any other secret-keyed leaves) in place;
 *   4. delete the [hooks.state] table (and the [hooks] parent if it became empty);
 *   5. re-stringify, then run templater.toTemplate over the TEXT to fold every
 *      remaining absolute machine path — in values and in [projects."PATH"] keys.
 *
 * The function never throws on malformed TOML where avoidable, but smol-toml's
 * parse will throw on genuinely invalid syntax; callers (capture.ts) catch that
 * and fall back to skipping the file with a warning.
 */
export function processConfigToml(
  raw: string,
  templater: TemplaterService,
  vars: TemplateVariables,
  opts?: { redactSecrets?: boolean },
): ParsedCodexConfig {
  // redactSecrets defaults to true (the safe default). The codex adapter passes
  // false only when ctx.includeSecrets opts INTO carrying inline secret values
  // into the private repo; extraction/templating/hooks-state stripping still run.
  const redactSecrets = opts?.redactSecrets ?? true;
  const secrets: SecretRef[] = [];

  const parsed = parseToml(raw) as TomlTable;

  // 2) Manifest extraction first — from the still-pristine parse.
  const plugins = extractPlugins(parsed);
  const marketplaces = extractMarketplaces(parsed);

  // 3) Redact secrets under the at-risk tables. We walk the whole tree so any
  //    secret-keyed leaf anywhere is caught, but the explicit container handling
  //    (env/headers/set) guarantees full mcp_servers + shell_env coverage.
  //    Skipped entirely when includeSecrets opted to carry values verbatim.
  if (redactSecrets) {
    const mcpServers = parsed["mcp_servers"];
    if (isTable(mcpServers)) {
      redactSubtree(mcpServers, "mcp_servers", secrets, false);
    }
    const shellEnv = parsed["shell_environment_policy"];
    if (isTable(shellEnv)) {
      redactSubtree(shellEnv, "shell_environment_policy", secrets, false);
    }
    // Catch-all: any other secret-keyed scalar at the top level or in keep-sections.
    for (const key of Object.keys(parsed)) {
      if (key === "mcp_servers" || key === "shell_environment_policy") continue;
      if (key === "plugins" || key === "marketplaces" || key === "hooks") continue;
      const value = parsed[key];
      if (typeof value === "string") {
        if (isSecretKey(key) || valueLooksSecret(value)) {
          parsed[key] = REDACTED;
          secrets.push(makeValueSecret(key));
        }
      } else if (isTable(value) || Array.isArray(value)) {
        redactSubtree(value, key, secrets, false);
      }
    }
  }

  // 4) Strip machine-specific hook trust state. The KEYS embed absolute paths and
  //    sha256 hashes that are meaningless on another machine; drop the whole
  //    [hooks.state] table. Remove the [hooks] parent if nothing else remains.
  const hooks = parsed["hooks"];
  if (isTable(hooks)) {
    delete hooks["state"];
    if (Object.keys(hooks).length === 0) {
      delete parsed["hooks"];
    }
  }

  // 5) Re-serialize, then template all remaining machine paths in the text.
  const serialized = stringifyToml(parsed);
  const sanitizedToml = templater.toTemplate(serialized, vars);

  return { sanitizedToml, plugins, marketplaces, secrets };
}

/**
 * Inverse for restore: expand {{TOKENS}} in a stored config.toml back to this
 * machine's paths. Pure text transform via the injected templater; the structure
 * is preserved (we do not re-parse, so comments/formatting survive untouched).
 */
export function rehydrateConfigToml(
  stored: string,
  templater: TemplaterService,
  vars: TemplateVariables,
): string {
  return templater.fromTemplate(stored, vars);
}
