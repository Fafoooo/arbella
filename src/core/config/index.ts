/**
 * arbella local config: load / save / locate / default.
 *
 * The config lives at `configDir()/config.json` (cross-OS, resolved by
 * src/platform/os.ts — never hardcoded here). It is validated against the zod
 * schema in `./schema.js`. This file is LOCAL to the machine and is NOT the
 * backup repo; it only records where the repo lives plus per-machine options.
 *
 * Security note: this config never holds secret values. It stores a repo URL
 * and local clone path only. We still never log its contents from here.
 */

import path from "node:path";

import { z } from "zod";

import { configDir } from "../../platform/os.js";
import { fs } from "../../utils/fs.js";

import {
  type ArbellaConfig,
  arbellaConfigSchema,
  DEFAULT_CONFIG,
} from "./schema.js";

/** Absolute path to the on-disk config file: `configDir()/config.json`. */
export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/** True if the config file is present on disk. */
export async function configExists(): Promise<boolean> {
  return fs.exists(configPath());
}

/**
 * Load + validate the config from disk.
 *
 * Throws a friendly Error when the file is missing, is not valid JSON, or fails
 * schema validation. Use {@link loadConfigOrDefault} when absence is fine.
 */
export async function loadConfig(): Promise<ArbellaConfig> {
  const file = configPath();

  if (!(await fs.exists(file))) {
    throw new Error(
      `No arbella config found at ${file}. Run \`arbella init\` first.`,
    );
  }

  let raw: string;
  try {
    raw = await fs.read(file);
  } catch (err) {
    throw new Error(
      `Could not read arbella config at ${file}: ${errMessage(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `arbella config at ${file} is not valid JSON: ${errMessage(err)}`,
    );
  }

  const result = arbellaConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `arbella config at ${file} is invalid:\n${formatIssues(result.error)}`,
    );
  }

  return result.data;
}

/**
 * Load the config if present, otherwise return {@link DEFAULT_CONFIG}.
 *
 * A present-but-invalid file still throws (we don't silently mask corruption);
 * only true absence falls back to the default.
 */
export async function loadConfigOrDefault(): Promise<ArbellaConfig> {
  if (!(await configExists())) {
    return defaultConfig();
  }
  return loadConfig();
}

/**
 * The default config (deep copy of {@link DEFAULT_CONFIG}) used to seed a fresh
 * install before `init` fills in the repo. Returning a copy keeps the exported
 * constant immutable against accidental in-place mutation by callers.
 */
export function defaultConfig(): ArbellaConfig {
  return arbellaConfigSchema.parse(structuredClone(DEFAULT_CONFIG));
}

/**
 * Persist the config to disk. Validates first (so we never write garbage),
 * ensures the config directory exists, then writes deterministic JSON.
 */
export async function saveConfig(config: ArbellaConfig): Promise<void> {
  // Re-validate to guarantee we only ever serialize a well-formed config and to
  // normalize defaults for any omitted fields.
  const valid = arbellaConfigSchema.parse(config);
  const file = configPath();
  await fs.ensureDir(path.dirname(file));
  await fs.write(file, serializeConfig(valid));
}

/**
 * Shallow-merge `patch` over the current config (or the default when absent),
 * persist the result, and return it.
 *
 * Shallow by design: passing `{ repo: {...} }` replaces the whole `repo`
 * object. Pass a complete `RepoConfig` when touching repo fields.
 */
export async function updateConfig(
  patch: Partial<ArbellaConfig>,
): Promise<ArbellaConfig> {
  const current = await loadConfigOrDefault();
  const merged = arbellaConfigSchema.parse({ ...current, ...patch });
  await saveConfig(merged);
  return merged;
}

/* -------------------------------------------------------------------------- */
/* internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Deterministic JSON: 2-space indent, stable key order, trailing newline. */
function serializeConfig(value: ArbellaConfig): string {
  return `${JSON.stringify(value, sortedReplacer, 2)}\n`;
}

/** JSON replacer that emits object keys in a stable (sorted) order. */
function sortedReplacer(_key: string, val: unknown): unknown {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {});
  }
  return val;
}

/** Render zod issues into a short, human-readable bullet list. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

/** Best-effort message extraction from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
