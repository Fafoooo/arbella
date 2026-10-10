/**
 * Placement engine: the one place that decides whether a restored file replaces
 * what is on disk. Plan and write share planPlacement, so --dry-run cannot
 * disagree with the real pull. Reports key names and paths only, never values.
 */
import type { CoreServices } from "../../adapters/adapter.interface.js";
import type { SourceOfTruth } from "../../types.js";
import { REDACTED } from "../sanitizer/patterns.js";
import { sha256, type Ledger, type MissingSecret } from "./ledger.js";
import {
  describeMissingSecret,
  matchesWithSecrets,
  mergeRedactedText,
  structuredKind,
} from "./redacted.js";

export type Role = "source" | "follower";
export type PlaceOutcome = "written" | "identical" | "kept";

export interface PullReport {
  tools: Record<string, { written: number; identical: number; kept: string[] }>;
  /** Files that still contain the marker after the pull. */
  redactedText: string[];
  missingSecrets: MissingSecret[];
}

/** Per-pull accumulator: ledger and report are updated in place by applyPlacement. */
export interface PullSession {
  readonly role: Role;
  readonly force: boolean;
  readonly ledger: Ledger;
  readonly report: PullReport;
}

export interface PlaceRequest {
  bucket: string;
  /** Absolute destination, containment-checked by the caller. */
  dest: string;
  /** Hydrated text or decoded bytes. */
  content: string | Buffer;
  mode?: number;
  /** Non-atomic writer (claude/files only). */
  direct?: boolean;
}

export interface PlaceDecision {
  outcome: PlaceOutcome;
  overwrites: boolean;
  bytes: string | Buffer;
  missing: string[][];
  recordHash?: string;
  repoHasMarkers: boolean;
}

export type PlaceCtx = Pick<CoreServices, "fs" | "log"> & {
  sourceOfTruth: SourceOfTruth;
  dryRun?: boolean;
  pull?: PullSession;
};

export function decide(i: {
  role: Role;
  force: boolean;
  local?: Buffer;
  next: Buffer;
  localHasMarker: boolean;
  keepsSecrets: boolean;
  ledgerHash?: string;
}): PlaceOutcome {
  if (!i.local) return "written";
  if (i.keepsSecrets || i.local.equals(i.next)) return "identical";
  if (i.localHasMarker || i.force) return "written";
  if (i.role === "follower" && i.ledgerHash !== undefined && sha256(i.local) === i.ledgerHash) return "written";
  return "kept";
}

const toBuffer = (b: string | Buffer): Buffer => (typeof b === "string" ? Buffer.from(b) : b);

async function readLocal(ctx: PlaceCtx, dest: string): Promise<{ bytes?: Buffer; unreadable: boolean }> {
  if (!(await ctx.fs.exists(dest))) return { unreadable: false };
  try {
    return { bytes: await ctx.fs.readBytes(dest), unreadable: false };
  } catch {
    return { unreadable: true };
  }
}

/** Read-only: what would happen to `req.dest`. */
export async function planPlacement(ctx: PlaceCtx, req: PlaceRequest): Promise<PlaceDecision> {
  const role = ctx.pull?.role ?? "source";
  const force = ctx.pull ? ctx.pull.force : ctx.sourceOfTruth === "repo";
  const { bytes: local, unreadable } = await readLocal(ctx, req.dest);
  const localText = local?.toString("utf8");
  const repoText = typeof req.content === "string" ? req.content : undefined;
  const repoHasMarkers = repoText?.includes(REDACTED) ?? false;

  let next: string | Buffer = req.content;
  let missing: string[][] = [];
  if (repoText !== undefined && repoHasMarkers) {
    const kind = structuredKind(req.dest);
    const merged = kind ? mergeRedactedText(kind, repoText, localText) : undefined;
    if (merged) {
      next = merged.text;
      missing = merged.missing;
    }
  }
  const nextBytes = toBuffer(next);
  const keepsSecrets =
    repoHasMarkers && localText !== undefined && matchesWithSecrets(repoText!, localText);

  const outcome = unreadable
    ? force ? "written" : "kept"
    : decide({
        role,
        force,
        local,
        next: nextBytes,
        localHasMarker: local?.includes(REDACTED) ?? false,
        keepsSecrets,
        ledgerHash: ctx.pull?.ledger.files[req.dest],
      });

  const plainIdentical = outcome === "identical" && !keepsSecrets;
  return {
    outcome,
    overwrites: local !== undefined && outcome === "written",
    bytes: next,
    missing: outcome === "written" ? missing : [],
    recordHash: outcome === "written" ? sha256(nextBytes) : plainIdentical && local ? sha256(local) : undefined,
    repoHasMarkers,
  };
}

/** Write (when the decision says so) and record into the session. */
export async function applyPlacement(
  ctx: PlaceCtx,
  req: PlaceRequest,
  d: PlaceDecision,
): Promise<PlaceOutcome> {
  if (ctx.dryRun) return d.outcome;
  if (d.outcome === "written") await writeBytes(ctx, req, d.bytes);
  const pull = ctx.pull;
  if (!pull) return d.outcome;

  const tool = (pull.report.tools[req.bucket] ??= { written: 0, identical: 0, kept: [] });
  if (d.outcome === "kept") tool.kept.push(req.dest);
  else tool[d.outcome]++;
  if (d.recordHash) pull.ledger.files[req.dest] = d.recordHash;
  for (const keyPath of d.missing) {
    pull.report.missingSecrets.push({ tool: req.bucket, file: req.dest, keyPath });
  }
  const viaSecrets = d.outcome === "identical" && d.recordHash === undefined;
  if (d.outcome !== "kept" && !viaSecrets && toBuffer(d.bytes).includes(REDACTED)) {
    pull.report.redactedText.push(req.dest);
  }
  return d.outcome;
}

async function writeBytes(ctx: PlaceCtx, req: PlaceRequest, bytes: string | Buffer): Promise<void> {
  const { fs } = ctx;
  if (typeof bytes === "string") {
    if (req.direct) await fs.write(req.dest, bytes, req.mode);
    else await fs.writeAtomic(req.dest, bytes, req.mode);
  } else if (req.direct) await fs.writeBytes(req.dest, bytes, req.mode);
  else await fs.writeBytesAtomic(req.dest, bytes, req.mode);
}

export async function placeFile(ctx: PlaceCtx, req: PlaceRequest): Promise<PlaceOutcome> {
  return applyPlacement(ctx, req, await planPlacement(ctx, req));
}

/** For writes made outside placeFile (enabledPlugins overlay): keep the ledger hash current. */
export function recordExternalWrite(ctx: PlaceCtx, dest: string, bytes: string | Buffer): void {
  if (ctx.pull && !ctx.dryRun) ctx.pull.ledger.files[dest] = sha256(bytes);
}

export function noteMissingSecrets(ctx: PlaceCtx, e: MissingSecret[]): void {
  if (ctx.pull && !ctx.dryRun) ctx.pull.report.missingSecrets.push(...e);
}

export function newPullSession(a: { role: Role; force: boolean; ledger: Ledger }): PullSession {
  return {
    role: a.role,
    force: a.force,
    ledger: { ...a.ledger, files: { ...a.ledger.files }, missingSecrets: [...a.ledger.missingSecrets] },
    report: { tools: {}, redactedText: [], missingSecrets: [] },
  };
}

const MAX_KEPT_SHOWN = 20;

const tildify = (p: string, home: string): string =>
  p === home ? "~" : p.startsWith(home + "/") || p.startsWith(home + "\\") ? "~" + p.slice(home.length) : p;

/** Pure: the lines `arbella pull` prints after placing files. */
export function formatPullSummary(r: PullReport, role: Role, home: string): string[] {
  const lines: string[] = [];
  const kept: string[] = [];
  for (const [tool, t] of Object.entries(r.tools)) {
    lines.push(`${tool}: ${t.written} written, ${t.identical} unchanged, ${t.kept.length} kept`);
    kept.push(...t.kept);
  }
  if (kept.length > 0) {
    for (const p of kept.slice(0, MAX_KEPT_SHOWN)) lines.push(`  kept ${tildify(p, home)}`);
    if (kept.length > MAX_KEPT_SHOWN) lines.push(`  … and ${kept.length - MAX_KEPT_SHOWN} more`);
    const why = role === "follower" ? "changed locally" : "differs from repo";
    lines.push(`Kept files are ${why}; \`arbella pull --force\` replaces them.`);
  }
  if (r.redactedText.length > 0) {
    lines.push(`Files still containing ${REDACTED}:`);
    for (const p of r.redactedText) lines.push(`  ${tildify(p, home)}`);
  }
  for (const e of r.missingSecrets) lines.push(`secret missing: ${describeMissingSecret(e)}`);
  return lines;
}
