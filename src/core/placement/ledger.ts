/**
 * Pull ledger: what arbella last placed on this machine, so a follower can tell
 * "unchanged since the last pull" from "edited locally". Stores only sha256
 * hashes and key paths, never file content or secret values.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "../../platform/os.js";
import type { FsService, Logger } from "../../types.js";
import { parse as parseToml } from "smol-toml";
import { parseJsonOrJsonc } from "../sanitizer/index.js";
import { hasMarker, structuredKind } from "./redacted.js";

export interface MissingSecret {
  tool: string;
  /** Absolute path of the file the key is missing from. */
  file: string;
  keyPath: string[];
}

export interface Ledger {
  version: 1;
  /** Absolute destination -> sha256 of what arbella last placed there. */
  files: Record<string, string>;
  missingSecrets: MissingSecret[];
}

const ledgerSchema = z.object({
  version: z.literal(1),
  files: z.record(z.string(), z.string()),
  missingSecrets: z.array(z.object({ tool: z.string(), file: z.string(), keyPath: z.array(z.string()) })),
});

const emptyLedger = (): Ledger => ({ version: 1, files: {}, missingSecrets: [] });

export const ledgerPath = (): string => path.join(dataDir(), "pull-ledger.json");

export function sha256(b: string | Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/** Absent or corrupt -> empty (corrupt also warns when a logger is given). */
export async function loadLedger(fs: FsService, file: string = ledgerPath(), log?: Logger): Promise<Ledger> {
  if (!(await fs.exists(file))) return emptyLedger();
  let parsed: z.SafeParseReturnType<unknown, Ledger> | undefined;
  try {
    parsed = ledgerSchema.safeParse(JSON.parse(await fs.read(file)));
  } catch {
    parsed = undefined;
  }
  if (parsed?.success) return parsed.data;
  log?.warn(`Ignoring unreadable pull ledger ${file}; treating every differing file as locally changed.`);
  return emptyLedger();
}

export async function saveLedger(fs: FsService, l: Ledger, file: string = ledgerPath()): Promise<void> {
  await fs.writeAtomic(file, JSON.stringify(l, null, 2) + "\n", 0o600);
}

/** True while the key is absent or still a marker in its file; false once filled in. */
export async function stillMissing(fs: FsService, e: MissingSecret): Promise<boolean> {
  if (!(await fs.exists(e.file))) return false;
  const kind = structuredKind(e.file);
  if (!kind) return true;
  const text = await fs.read(e.file);
  let doc: unknown;
  if (kind === "json") {
    const r = parseJsonOrJsonc(text);
    if (!r.ok) return true;
    doc = r.value;
  } else {
    try {
      doc = parseToml(text);
    } catch {
      return true;
    }
  }
  for (const k of e.keyPath) {
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return true;
    doc = (doc as Record<string, unknown>)[k];
  }
  return doc === undefined || hasMarker(doc);
}
