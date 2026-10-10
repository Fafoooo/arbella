/**
 * Placement engine: the one place that decides whether a restored file replaces
 * what is on disk. Plan and write share planPlacement, so --dry-run cannot
 * disagree with the real pull. Reports key names and paths only, never values.
 */
import { isDeepStrictEqual } from "node:util";
import type { CoreServices } from "../../adapters/adapter.interface.js";
import type { CapturedFile, SourceOfTruth } from "../../types.js";
import { withoutAutobackupHook } from "../autobackup/hook.js";
import type { Role } from "../config/schema.js";
import { REDACTED } from "../sanitizer/patterns.js";
import { sha256, type Ledger, type MissingSecret } from "./ledger.js";
import {
  describeMissingSecret,
  isPlain,
  isRedactedFormOf,
  markerPaths,
  matchesWithSecrets,
  mergeRedactedText,
  parseStructured,
  plain,
  repairRedactedText,
  secretBlindText,
  structuredKind,
  tildify,
} from "./redacted.js";

export type PlaceOutcome = "written" | "identical" | "kept";

export interface PullReport {
  tools: Record<string, { written: number; identical: number; kept: string[] }>;
  /** Files that still contain the marker after the pull. */
  redactedText: string[];
  missingSecrets: MissingSecret[];
  /**
   * Kept although `--force` or the ledger would replace them: the local file
   * has real values where the repo has the marker. Also listed under `kept`.
   */
  keptForSecrets: string[];
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
  /** The file's repo path; lets the compare ignore arbella's own autobackup hook. */
  repoPath?: string;
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
  /** The file will still contain the marker after this pass (placed bytes, or the kept local bytes). */
  stillRedacted: boolean;
  /** Kept only because replacing it would lose a real local value. */
  keptForSecrets: boolean;
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
  localBroken: boolean;
  keepsSecrets: boolean;
  /** Local equals next once arbella's own autobackup hook is left out. */
  sameButOurHook?: boolean;
  /** Follower only: the local file is what the ledger says arbella last placed. */
  ledgerMatch: boolean;
  /** Replacing the local file cannot lose a real value the repo has as a marker. */
  secretSafe: boolean;
}): PlaceOutcome {
  if (!i.local) return "written";
  if (i.keepsSecrets || i.local.equals(i.next) || i.sameButOurHook) return "identical";
  if (i.localBroken) return "written";
  if (!i.secretSafe) return "kept";
  if (i.force) return "written";
  if (i.role === "follower" && i.ledgerMatch) return "written";
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

/**
 * The bytes placement would write and the keys they leave out. A marker-broken
 * structured local file is repaired from itself (local-only keys survive)
 * unless forced; otherwise a repo file with markers is merged with the local
 * one. `merged`: the structured repair or merge ran.
 */
function nextContent(a: {
  kind?: "json" | "toml";
  repoText?: string;
  localText?: string;
  content: string | Buffer;
  repair: boolean;
}): { next: string | Buffer; missing: string[][]; merged: boolean; unsafe: boolean } {
  const { kind, repoText, localText } = a;
  const asIs = { next: a.content, missing: [], merged: false, unsafe: false };
  if (!kind || repoText === undefined) return asIs;
  const repaired =
    a.repair && localText !== undefined ? repairRedactedText(kind, localText, repoText) : undefined;
  const out =
    repaired ?? (repoText.includes(REDACTED) ? mergeRedactedText(kind, repoText, localText) : undefined);
  return out
    ? { next: out.text, missing: out.missing, merged: true, unsafe: out.unsafe.length > 0 }
    : asIs;
}

/** The local hook file equals `nextText` once arbella's own autobackup hook is left out. */
function sameButOurHook(repoPath: string, localText: string, nextText: string): boolean {
  const file = { repoPath, content: localText };
  const stripped = withoutAutobackupHook(file);
  if (stripped === file) return false;
  const a = parseStructured("json", stripped.content);
  return a !== undefined && isDeepStrictEqual(a, parseStructured("json", nextText));
}

/** Read-only: what would happen to `req.dest`. */
export async function planPlacement(ctx: PlaceCtx, req: PlaceRequest): Promise<PlaceDecision> {
  const role = ctx.pull?.role ?? "source";
  const force = ctx.pull ? ctx.pull.force : ctx.sourceOfTruth === "repo";
  const { bytes: local, unreadable } = await readLocal(ctx, req.dest);
  const localText = local?.toString("utf8");
  const repoText = typeof req.content === "string" ? req.content : undefined;
  const repoHasMarkers = repoText?.includes(REDACTED) ?? false;
  const kind = structuredKind(req.dest);

  // A structured config value is never legitimately the marker; free text may mention it.
  const localBroken =
    repoText === undefined || localText === undefined
      ? false
      : kind
        ? localText.includes(REDACTED)
        : isRedactedFormOf(localText, repoText);

  const { next, missing, merged, unsafe } = nextContent({
    kind,
    repoText,
    localText,
    content: req.content,
    repair: localBroken && !force,
  });
  const nextBytes = toBuffer(next);
  const keepsSecrets =
    repoHasMarkers && localText !== undefined && matchesWithSecrets(repoText!, localText);
  // Replacing the local file loses nothing real when the repo has no marker,
  // there is no local text or it holds markers itself, or the structured merge
  // carries its values over.
  // An unsafe merge (a changed command/args/url next to a marker) never counts:
  // the real value would stay behind or go to a new endpoint, so the file is kept.
  const secretSafe =
    !unsafe &&
    (!repoHasMarkers ||
      (localText?.includes(REDACTED) ?? true) ||
      (merged && isPlain(parseStructured(kind!, localText!))));

  const hashOf = (b: Buffer): string => placementHash(req.dest, b, repoText);

  const ledgerHash = ctx.pull?.ledger.files[req.dest];
  const ledgerMatch =
    ledgerHash !== undefined &&
    local !== undefined &&
    (sha256(local) === ledgerHash || hashOf(local) === ledgerHash);

  const inputs = {
    role,
    force,
    local,
    next: nextBytes,
    localBroken,
    keepsSecrets,
    sameButOurHook:
      req.repoPath !== undefined &&
      localText !== undefined &&
      typeof next === "string" &&
      sameButOurHook(req.repoPath, localText, next),
    ledgerMatch,
    secretSafe,
  };
  const decided = unreadable ? (force ? "written" : "kept") : decide(inputs);
  // decide() lets a marker-broken local file through before the secret check.
  const outcome = unsafe && decided === "written" ? "kept" : decided;

  // Identical via secrets: nothing is missing. A structured file records its
  // secret-blind hash so a later repo change still reaches a follower; a text
  // file stays unrecorded.
  const viaSecrets = outcome === "identical" && keepsSecrets;
  return {
    outcome,
    overwrites: (local !== undefined || unreadable) && outcome === "written",
    bytes: next,
    missing: outcome === "written" || (!unreadable && !viaSecrets) ? missing : [],
    recordHash:
      outcome === "written" ? hashOf(nextBytes)
      : outcome === "identical" && local && (!viaSecrets || kind) ? hashOf(local)
      : undefined,
    repoHasMarkers,
    stillRedacted:
      outcome === "written" ? nextBytes.includes(REDACTED) : (local?.includes(REDACTED) ?? false),
    keptForSecrets:
      outcome === "kept" &&
      !unreadable &&
      (unsafe || decide({ ...inputs, secretSafe: true }) === "written"),
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
  if (d.stillRedacted) pull.report.redactedText.push(req.dest);
  if (d.keptForSecrets) pull.report.keptForSecrets.push(req.dest);
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

/** A captured file as placement compares and writes it: {{TOKENS}} expanded, binary decoded. */
export function hydratedContent(
  ctx: Pick<CoreServices, "templater" | "vars">,
  file: CapturedFile,
): string | Buffer {
  return file.binary ? Buffer.from(file.content, "base64") : ctx.templater.fromTemplate(file.content, ctx.vars);
}

/**
 * The ledger hash of `bytes` placed at `dest`. Secret-blind when `repoText` is
 * a structured file carrying markers: the marker paths are dropped, so filling
 * in a secret locally does not look like an edit. Otherwise a plain sha256.
 */
export function placementHash(dest: string, bytes: string | Buffer, repoText?: string): string {
  const kind = structuredKind(dest);
  if (kind && repoText?.includes(REDACTED)) {
    const blind = secretBlindText(kind, bytes.toString(), markerPaths(parseStructured(kind, repoText)));
    if (blind !== undefined) return sha256(blind);
  }
  return sha256(bytes);
}

/**
 * For writes made outside placeFile (enabledPlugins overlay): keep the ledger
 * hash current. Pass the repo text the file was placed from so the hash is
 * secret-blind like placeFile's.
 */
export function recordExternalWrite(
  ctx: PlaceCtx,
  dest: string,
  bytes: string | Buffer,
  repoText?: string,
): void {
  if (ctx.pull && !ctx.dryRun) ctx.pull.ledger.files[dest] = placementHash(dest, bytes, repoText);
}

export function noteMissingSecrets(ctx: PlaceCtx, e: MissingSecret[]): void {
  if (ctx.pull && !ctx.dryRun) ctx.pull.report.missingSecrets.push(...e);
}

/** Entries for the pull summary: kept although the repo would replace them, to protect a real local value. */
export function noteKeptForSecrets(ctx: PlaceCtx, what: string[]): void {
  if (ctx.pull && !ctx.dryRun) ctx.pull.report.keptForSecrets.push(...what);
}

export function newPullSession(a: { role: Role; force: boolean; ledger: Ledger }): PullSession {
  return {
    role: a.role,
    force: a.force,
    ledger: { ...a.ledger, files: { ...a.ledger.files }, missingSecrets: [...a.ledger.missingSecrets] },
    report: { tools: {}, redactedText: [], missingSecrets: [], keptForSecrets: [] },
  };
}

const MAX_KEPT_SHOWN = 20;

/** Pure: the lines `arbella pull` prints after placing files. Paths and key names only, as plain text. */
export function formatPullSummary(r: PullReport, role: Role, home: string): string[] {
  const shown = (p: string): string => plain(tildify(p, home));
  const forSecrets = new Set(r.keptForSecrets);
  const lines: string[] = [];
  const kept: string[] = [];
  for (const [tool, t] of Object.entries(r.tools)) {
    lines.push(`${tool}: ${t.written} written, ${t.identical} unchanged, ${t.kept.length} kept`);
    kept.push(...t.kept.filter((p) => !forSecrets.has(p)));
  }
  if (kept.length > 0) {
    for (const p of kept.slice(0, MAX_KEPT_SHOWN)) lines.push(`  kept ${shown(p)}`);
    if (kept.length > MAX_KEPT_SHOWN) lines.push(`  … and ${kept.length - MAX_KEPT_SHOWN} more`);
    const why = role === "follower" ? "changed locally" : "differs from repo";
    lines.push(`Kept files are ${why}; \`arbella pull --force\` replaces them.`);
  }
  // --force deliberately does not replace these: it would lose the real value.
  if (r.keptForSecrets.length > 0) {
    for (const p of r.keptForSecrets) {
      lines.push(`  kept (has real values where the repo has ${REDACTED}): ${shown(p)}`);
    }
    lines.push("  remove the local file (or MCP server entry) to take the repo version");
  }
  if (r.redactedText.length > 0) {
    lines.push(`Files still containing ${REDACTED}:`);
    for (const p of r.redactedText.slice(0, MAX_KEPT_SHOWN)) lines.push(`  ${shown(p)}`);
    if (r.redactedText.length > MAX_KEPT_SHOWN) {
      lines.push(`  … and ${r.redactedText.length - MAX_KEPT_SHOWN} more`);
    }
  }
  for (const e of r.missingSecrets) lines.push(`secret missing: ${describeMissingSecret(e, home)}`);
  return lines;
}
