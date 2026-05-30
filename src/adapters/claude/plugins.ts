/**
 * Claude plugin + marketplace parsing and restore-command construction.
 *
 * Pure data transforms (no fs, no clock): given the already-parsed JSON content
 * of `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, and
 * `settings.json`, produce the manifest entry shapes from
 * src/core/manifest/schema.ts. Also builds the argv arrays for the `claude`
 * CLI used on restore.
 *
 * Real on-disk shapes (verified on this machine):
 *
 *   installed_plugins.json:
 *     { "version": 2, "plugins": {
 *         "superpowers@claude-plugins-official": [
 *           { "scope":"user"|"project", "version":"5.1.0",
 *             "projectPath":"...", "installPath":"...", ... } ] } }
 *
 *   known_marketplaces.json:
 *     { "claude-plugins-official": {
 *         "source": { "source":"github", "repo":"anthropics/claude-plugins-official" },
 *         "installLocation":"...", "lastUpdated":"..." } }
 *
 *   settings.json.enabledPlugins:
 *     { "superpowers@claude-plugins-official": true, ... }
 */

import type { PluginEntry, MarketplaceEntry } from "../../types.js";

/** Narrow a value to a plain object record. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Split a fully-qualified plugin id ("name@marketplace") into its parts.
 * If there is no "@", marketplace is undefined and the whole id is the name.
 */
function splitPluginId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0) return { name: id };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/**
 * Parse `installed_plugins.json` content into PluginEntry[].
 *
 * The value under each id key is an ARRAY of install records (a plugin can be
 * installed at user scope and/or for specific projects). We emit one
 * PluginEntry per record so user-scope and project-scope installs are both
 * represented; restore only auto-reinstalls scope:"user" entries.
 *
 * `foldPath` templates the machine-specific `projectPath` (a project-scope
 * install's absolute path) into {{HOME}}-style placeholders BEFORE it reaches
 * the manifest — otherwise the raw `/Users/<you>/...` path would be committed to
 * the repo (a portability + privacy leak). Capture passes the live templater;
 * the default is identity so callers/tests that don't care keep the raw value.
 *
 * Malformed records are skipped (graceful absence rule). Returns [] for any
 * non-conforming top-level shape.
 */
export function parseInstalledPlugins(
  json: unknown,
  foldPath: (p: string) => string = (p) => p,
): PluginEntry[] {
  if (!isRecord(json)) return [];
  const plugins = json.plugins;
  if (!isRecord(plugins)) return [];

  const out: PluginEntry[] = [];
  for (const [id, recordsRaw] of Object.entries(plugins)) {
    if (typeof id !== "string" || id.length === 0) continue;
    const records = Array.isArray(recordsRaw) ? recordsRaw : [recordsRaw];
    const { name, marketplace } = splitPluginId(id);

    for (const rec of records) {
      if (!isRecord(rec)) continue;
      const scope = rec.scope === "project" ? "project" : "user";
      const version =
        typeof rec.version === "string" ? rec.version : undefined;
      const projectPath =
        typeof rec.projectPath === "string" ? foldPath(rec.projectPath) : undefined;

      const entry: PluginEntry = {
        id,
        name,
        enabled: true,
        scope,
      };
      if (marketplace !== undefined) entry.marketplace = marketplace;
      if (version !== undefined) entry.version = version;
      if (projectPath !== undefined) entry.projectPath = projectPath;
      out.push(entry);
    }
  }
  return out;
}

/**
 * Parse `known_marketplaces.json` content into MarketplaceEntry[].
 *
 * Maps each top-level key to { id, sourceType, source }. The nested `source`
 * object carries `source` (the kind: "github" | "git" | "local") and a locator
 * (`repo` for github => "owner/repo", or `url`/`path` otherwise). Unknown kinds
 * are coerced to the closest supported sourceType; entries without any usable
 * locator are skipped.
 */
export function parseKnownMarketplaces(json: unknown): MarketplaceEntry[] {
  if (!isRecord(json)) return [];

  const out: MarketplaceEntry[] = [];
  for (const [id, valueRaw] of Object.entries(json)) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (!isRecord(valueRaw)) continue;

    const src = valueRaw.source;
    if (!isRecord(src)) continue;

    const kindRaw = typeof src.source === "string" ? src.source : "";
    let sourceType: MarketplaceEntry["sourceType"];
    if (kindRaw === "github") sourceType = "github";
    else if (kindRaw === "local") sourceType = "local";
    else sourceType = "git";

    // Locator: github => repo ("owner/repo"); git => url; local => path.
    const locator =
      (typeof src.repo === "string" && src.repo) ||
      (typeof src.url === "string" && src.url) ||
      (typeof src.path === "string" && src.path) ||
      "";
    if (!locator) continue;

    out.push({ id, sourceType, source: locator });
  }
  return out;
}

/**
 * Extract the `enabledPlugins` map from a parsed settings.json object.
 * Only boolean-valued entries are kept. Returns {} when absent/malformed.
 */
export function extractEnabledPlugins(settings: unknown): Record<string, boolean> {
  if (!isRecord(settings)) return {};
  const enabled = settings.enabledPlugins;
  if (!isRecord(enabled)) return {};

  const out: Record<string, boolean> = {};
  for (const [id, val] of Object.entries(enabled)) {
    if (typeof val === "boolean") out[id] = val;
  }
  return out;
}

/**
 * argv for `claude plugin marketplace add <source>`.
 *
 * The `claude plugin marketplace add` command accepts a URL, a local path, or a
 * GitHub "owner/repo" shorthand. We pass the stored locator verbatim:
 *  - github => "owner/repo"
 *  - git    => clone URL
 *  - local  => (templated) path; restore rehydrates it before use
 */
export function marketplaceAddArgs(m: MarketplaceEntry): string[] {
  return ["plugin", "marketplace", "add", m.source];
}

/**
 * argv for `claude plugin install <plugin> --scope user`.
 *
 * The plugin id is the fully-qualified "name@marketplace" form, which is exactly
 * what `claude plugin install` understands ("use plugin@marketplace for a
 * specific marketplace"). Scope is forced to user — only user-scope plugins are
 * auto-reinstalled on restore.
 */
export function pluginInstallArgs(p: PluginEntry): string[] {
  return ["plugin", "install", p.id, "--scope", "user"];
}

/** True if a plugin entry is a user-scope install (the only kind we reinstall). */
export function isUserScope(p: PluginEntry): boolean {
  return p.scope === "user";
}
