import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;

/**
 * Package version used by the CLI and backup metadata.
 *
 * tsup bundles source modules into dist/index.js, so import.meta.url points at
 * different depths in dev (`src/core/version.ts`) and in the packed CLI
 * (`dist/index.js`). Try both stable locations and fall back only if package.json
 * is unexpectedly unavailable.
 */
export function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "package.json"),
  ];

  for (const packagePath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version.trim() !== "") {
        cachedVersion = parsed.version;
        return cachedVersion;
      }
    } catch {
      // Try the next candidate.
    }
  }

  cachedVersion = "0.0.0";
  return cachedVersion;
}
