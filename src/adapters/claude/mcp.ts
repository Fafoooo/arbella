/**
 * MCP server definitions from ~/.claude.json — the one thing arbella lifts OUT of
 * Claude's global-state file.
 *
 * ~/.claude.json is denylisted wholesale and always will be: it holds the OAuth
 * account, telemetry counters and the full project history. But it is ALSO the
 * only place user-scope MCP servers live, and losing them is losing the setup.
 * So this module reads exactly two sub-objects out of it —
 *
 *   mcpServers                              -> manifest.mcpServers
 *   projects.<absPath>.mcpServers           -> manifest.projectMcpServers
 *
 * — and NOTHING else. No other key is copied, stored, logged, or even retained
 * past the parse: the parsed object is read for those two keys and dropped.
 *
 * Both directions go through the injected services:
 *   capture  -> sanitizer.sanitizeJson (every leaf under env/environment/headers
 *               becomes {{REDACTED}}, unless includeSecrets) then templater
 *               .toTemplate over every string leaf, so an absolute command path
 *               folds to {{HOME}}/....
 *   restore  -> templater.fromTemplate over the serialized def, then a KEY-WISE
 *               merge into the target's ~/.claude.json. Keys arbella does not own
 *               are never touched, and a file that is not valid JSON is never
 *               overwritten.
 *
 * The restore side has exactly ONE decision function, `planMcpMerge`: it reads
 * the target's current ~/.claude.json and reports which servers WOULD be written
 * (plus the env keys those servers still need). `--dry-run` prints its actions,
 * the post-restore reminder reads its `needsEnv`, and `restoreMcpServers` applies
 * its decisions verbatim — so the three can never disagree about what a pull does.
 *
 * No direct node:fs, no clock. templateDeep/hydrateDef and the merge appliers are
 * pure.
 */

import path from "node:path";

import type { CaptureContext, RestoreContext } from "../adapter.interface.js";
import type { RestoreAction, SecretRef, ToolManifest } from "../../types.js";

import { REDACTED } from "../../core/sanitizer/patterns.js";
import { isPlainObject, isUnsafeObjectKey } from "../../utils/object.js";
import type { CommandRef } from "../../core/homefiles/scan.js";
import { collectCommandRefs } from "../../core/homefiles/scan.js";

import { paths } from "./paths.js";

/** What a capture pass lifted out of ~/.claude.json. */
export interface CapturedMcp {
  /** name -> server definition (sanitized + templated), name-sorted. */
  mcpServers: ToolManifest["mcpServers"];
  /** Project-scope servers, sorted by (templated) project path. */
  projectMcpServers: ToolManifest["projectMcpServers"];
  /** SecretRefs for every value the sanitizer redacted. Metadata only. */
  secrets: SecretRef[];
  /** Non-fatal problems (unreadable / unparseable global state). */
  warnings: string[];
  /**
   * Command references taken from the RAW (pre-sanitize, pre-template) server
   * definitions, so `shared/home` capture can follow them to the launcher
   * scripts they point at (`~/.local/bin/serena-mcp-start`). Built here because
   * ~/.claude.json is parsed exactly once, and the templated defs in
   * `mcpServers` above no longer contain machine paths to resolve.
   */
  commandRefs: CommandRef[];
}

/** An empty result — used for "file absent" and "file unparseable" alike. */
function emptyMcp(warnings: string[] = []): CapturedMcp {
  return {
    mcpServers: {},
    projectMcpServers: [],
    secrets: [],
    warnings,
    commandRefs: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Map every STRING leaf of a JSON-ish value through `fn`, returning a new value.
 * Objects and arrays are cloned; non-string scalars pass through untouched.
 * Pure — the input is never mutated.
 */
export function templateDeep<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((el) => templateDeep(el, fn)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // `out["__proto__"] = …` would rewrite this object's prototype instead of
      // adding a field. A server definition read out of ~/.claude.json (or a
      // backup repo) is parsed JSON, which CAN carry such a key.
      if (isUnsafeObjectKey(k)) continue;
      out[k] = templateDeep(v, fn);
    }
    return out as unknown as T;
  }
  return value;
}

/** Longest launch summary an action description carries before it is elided. */
export const MAX_LAUNCH_SUMMARY = 120;

/**
 * One line describing WHAT a server definition will start on this machine:
 * `<command> <args…>` for a spawned server, `<url>` for an http/sse one.
 *
 * The dry run exists so a user can see what a pull will do BEFORE it does it,
 * and "Register MCP server serena" hides the only part that matters — the
 * command a backup repo just talked this machine into launching. Returns "" when
 * the definition names neither (nothing honest to show), so the caller can fall
 * back to the bare label. Truncated to {@link MAX_LAUNCH_SUMMARY} characters:
 * this is a plan line, not a config dump. Pure.
 */
export function describeServerLaunch(def: Record<string, unknown>): string {
  const url = typeof def.url === "string" ? def.url.trim() : "";
  const transport = typeof def.type === "string" ? def.type.toLowerCase() : "";
  const remote = transport === "http" || transport === "sse" || transport === "streamable-http";
  if (url !== "" && (remote || typeof def.command !== "string")) return truncate(url);

  const command = typeof def.command === "string" ? def.command.trim() : "";
  if (command === "") return url === "" ? "" : truncate(url);

  const args = Array.isArray(def.args)
    ? def.args.filter((a): a is string => typeof a === "string")
    : [];
  return truncate([command, ...args].join(" ").trim());
}

/** Cut `value` to {@link MAX_LAUNCH_SUMMARY} characters, marking the elision. */
function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_LAUNCH_SUMMARY
    ? collapsed
    : `${collapsed.slice(0, MAX_LAUNCH_SUMMARY - 1)}…`;
}

/** `<label>: <what it launches>`, or just `<label>` when there is nothing to show. */
function describeRegistration(label: string, def: Record<string, unknown>): string {
  const launch = describeServerLaunch(def);
  return launch === "" ? label : `${label}: ${launch}`;
}

/** Sort an object's keys so the serialized manifest is diff-stable. */
function sortedByKey<V>(obj: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key]!;
  return out;
}

/**
 * Collect every env/header KEY whose value is the redaction marker, i.e. the
 * values the user has to re-supply after a restore. Recurses so a nested
 * `env` under a transport block is found too. Pure — module-private: the plan is
 * the only thing outside this file that needs to know about redacted env keys,
 * and it reports them for the servers it will actually write.
 */
function redactedEnvKeys(def: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const el of node) walk(el);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (value === REDACTED) out.push(key);
      else walk(value);
    }
  };
  walk(def);
  return [...new Set(out)].sort();
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sanitize (unless includeSecrets) + template one server definition, appending
 * any SecretRefs to `secrets`.
 */
function processDef(
  ctx: CaptureContext,
  def: Record<string, unknown>,
  source: string,
  secrets: SecretRef[],
): Record<string, unknown> {
  let value: unknown = def;
  if (!ctx.includeSecrets) {
    const cleaned = ctx.sanitizer.sanitizeJson(def, "claude", source);
    value = cleaned.value;
    secrets.push(...cleaned.found);
  }
  return templateDeep(value as Record<string, unknown>, (s) =>
    ctx.templater.toTemplate(s, ctx.vars),
  );
}

/** Extract the name -> def map from a raw `mcpServers`-shaped value. */
function processServerMap(
  ctx: CaptureContext,
  raw: unknown,
  sourcePrefix: string,
  secrets: SecretRef[],
): ToolManifest["mcpServers"] {
  if (!isPlainObject(raw)) return {};
  const out: ToolManifest["mcpServers"] = {};
  for (const name of Object.keys(raw).sort()) {
    // A server literally named "__proto__" is not a server; carrying it would
    // mutate the prototype of every map it is copied into on the way back.
    if (isUnsafeObjectKey(name)) continue;
    const def = raw[name];
    if (!isPlainObject(def)) continue;
    out[name] = processDef(ctx, def, `${sourcePrefix}.${name}`, secrets);
  }
  return out;
}

/**
 * Read ~/.claude.json (when present) and lift out ONLY the MCP server
 * definitions. A missing file is normal (fresh machine) and yields an empty
 * result; an unparseable one yields a warning and an empty result — never a
 * throw, and never a partial read of any other key.
 */
export async function captureMcpServers(ctx: CaptureContext): Promise<CapturedMcp> {
  const globalState = paths(ctx.toolHome).globalState;
  if ((await ctx.fs.statKind(globalState)) !== "file") {
    ctx.log.debug("claude: no ~/.claude.json; no MCP servers to capture");
    return emptyMcp();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await ctx.fs.read(globalState));
  } catch {
    // The parser's message is DELIBERATELY dropped: V8 quotes a snippet of the
    // offending input, and this is the one file whose every byte is sensitive.
    return emptyMcp([
      "claude: could not parse ~/.claude.json; no MCP servers were captured.",
    ]);
  }
  if (!isPlainObject(raw)) return emptyMcp();

  const secrets: SecretRef[] = [];
  const mcpServers = processServerMap(
    ctx,
    raw.mcpServers,
    ".claude.json#mcpServers",
    secrets,
  );

  // The RAW defs, restricted to the two MCP sub-objects, are also the source for
  // the linked-script scan (see CapturedMcp.commandRefs). Nothing else from the
  // parsed file is copied into this scope.
  const rawMcpScope: Record<string, unknown> = {};
  if (isPlainObject(raw.mcpServers)) rawMcpScope.mcpServers = raw.mcpServers;
  const rawProjectScope: Record<string, unknown> = {};

  const projectMcpServers: ToolManifest["projectMcpServers"] = [];
  if (isPlainObject(raw.projects)) {
    for (const absPath of Object.keys(raw.projects).sort()) {
      const project = raw.projects[absPath];
      if (!isPlainObject(project)) continue;
      const servers = processServerMap(
        ctx,
        project.mcpServers,
        `.claude.json#projects.${absPath}.mcpServers`,
        secrets,
      );
      if (Object.keys(servers).length === 0) continue;
      rawProjectScope[absPath] = { mcpServers: project.mcpServers };
      projectMcpServers.push({
        projectPath: ctx.templater.toTemplate(absPath, ctx.vars),
        servers,
      });
    }
  }
  if (Object.keys(rawProjectScope).length > 0) rawMcpScope.projects = rawProjectScope;

  const commandRefs = collectCommandRefs(rawMcpScope, "claude:.claude.json");

  ctx.log.debug(
    `claude: lifted ${Object.keys(mcpServers).length} user-scope + ` +
      `${projectMcpServers.length} project-scope MCP server group(s) from ~/.claude.json`,
  );

  return {
    mcpServers: sortedByKey(mcpServers),
    projectMcpServers,
    secrets,
    warnings: [],
    commandRefs,
  };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

/** Expand {{HOME}}/{{TOOL_HOME}}/… inside a stored definition for THIS machine. */
function hydrateDef(
  ctx: RestoreContext,
  def: Record<string, unknown>,
): Record<string, unknown> {
  return templateDeep(def, (s) => ctx.templater.fromTemplate(s, ctx.vars));
}

/** Hydrate a stored project path to this machine's absolute path. */
function hydrateProjectPath(ctx: RestoreContext, projectPath: string): string {
  return ctx.templater.fromTemplate(projectPath, ctx.vars);
}

/** One server the merge would write, already hydrated for this machine. */
interface PlannedServer {
  name: string;
  def: Record<string, unknown>;
}

/** The servers a merge would write into one project scope. */
interface PlannedProject {
  /**
   * The `projects` key this project's servers will be written under. This is
   * the EXISTING key in ~/.claude.json when {@link findProjectKey} finds one
   * naming the same directory (reused verbatim, so a separator-flavor
   * mismatch never creates a second entry for one directory) — otherwise the
   * normalized, hydrated project path.
   */
  dir: string;
  servers: PlannedServer[];
}

/**
 * Find the key in `projects` that names the SAME directory as `projectDir`,
 * comparing under `normalize` rather than by raw string equality.
 *
 * ~/.claude.json's `projects` keys are written by Claude Code itself with
 * NATIVE separators (`path.join`) — backslashes on Windows. A manifest's
 * project path is stored "/"-joined (`{{HOME}}/programming/arbella`), so
 * hydrating it by splicing in a native-backslash `{{HOME}}` on Windows yields
 * a MIXED-separator string (`C:\Users\…\home/programming/arbella`) that never
 * equals the native-backslash key by plain `===`, even though both name the
 * same directory. That mismatch used to make `planProjectScope` treat an
 * already-registered project as unregistered — re-planning (and, on merge,
 * duplicating) it under a second, differently-spelled key.
 *
 * `normalize` is injectable (default `path.normalize`, a no-op for POSIX
 * paths) so this can be exercised with `path.win32.normalize` from any host,
 * including a POSIX CI runner. Pure — no fs, no host detection.
 */
export function findProjectKey(
  projects: Record<string, unknown>,
  projectDir: string,
  normalize: (p: string) => string = path.normalize,
): string | undefined {
  const target = normalize(projectDir);
  return Object.keys(projects).find((key) => normalize(key) === target);
}

/**
 * The single decision the restore and its dry run share.
 *
 * `actions` and `needsEnv` describe ONLY what would actually be written; the
 * remaining fields carry the decision itself so {@link restoreMcpServers} can
 * apply it without re-deciding anything.
 */
export interface McpMergePlan {
  /** One `register-mcp-server` action per server that WOULD be registered. */
  actions: RestoreAction[];
  /** `<server>.<KEY>` pairs the user must re-supply, for the servers above only. */
  needsEnv: Array<{ name: string; key: string }>;
  /** The parsed ~/.claude.json (empty object when absent or unparseable). */
  existing: Record<string, unknown>;
  /** True when the file is already on disk (decides whether a mode is passed). */
  existed: boolean;
  /** True when the file exists but is not valid JSON: the merge must refuse. */
  invalid: boolean;
  /** User-scope servers to write, name-sorted. */
  userServers: PlannedServer[];
  /** Project-scope servers to write, grouped by hydrated project dir. */
  projectServers: PlannedProject[];
}

/** A plan that changes nothing (no servers to merge, or a file we must not touch). */
function emptyMergePlan(
  overrides: Partial<McpMergePlan> = {},
): McpMergePlan {
  return {
    actions: [],
    needsEnv: [],
    existing: {},
    existed: false,
    invalid: false,
    userServers: [],
    projectServers: [],
    ...overrides,
  };
}

/**
 * Read ~/.claude.json. A missing file is normal (empty object); an unparseable
 * one is reported as `invalid` and treated as empty, so planning still runs
 * while the merge itself refuses to touch the file.
 */
async function readGlobalState(
  ctx: RestoreContext,
): Promise<{ obj: Record<string, unknown>; existed: boolean; invalid: boolean }> {
  const globalState = paths(ctx.toolHome).globalState;
  if ((await ctx.fs.statKind(globalState)) !== "file") {
    return { obj: {}, existed: false, invalid: false };
  }
  try {
    const parsed: unknown = JSON.parse(await ctx.fs.read(globalState));
    if (!isPlainObject(parsed)) throw new Error("top-level value is not an object");
    return { obj: parsed, existed: true, invalid: false };
  } catch {
    // No parser detail here either — see captureMcpServers.
    return { obj: {}, existed: true, invalid: true };
  }
}

/** True when sourceOfTruth leaves an already-registered server alone. */
function keepsLocal(ctx: RestoreContext, target: unknown, name: string): boolean {
  return ctx.sourceOfTruth === "local" && isPlainObject(target) && name in target;
}

/** The user-scope servers the merge would write, name-sorted. */
function planUserScope(
  ctx: RestoreContext,
  manifest: ToolManifest,
  existing: Record<string, unknown>,
): PlannedServer[] {
  const planned: PlannedServer[] = [];
  for (const name of Object.keys(manifest.mcpServers).sort()) {
    if (isUnsafeObjectKey(name)) {
      ctx.log.debug(`claude: ignoring MCP server with reserved name ${name}`);
      continue;
    }
    if (keepsLocal(ctx, existing.mcpServers, name)) {
      ctx.log.debug(`claude: keep local MCP server ${name} (user scope, sourceOfTruth=local)`);
      continue;
    }
    planned.push({ name, def: hydrateDef(ctx, manifest.mcpServers[name]!) });
  }
  return planned;
}

/**
 * The project-scope servers the merge would write, grouped by project dir.
 *
 * A project entry is only ever planned when its hydrated directory exists HERE:
 * a backup carries every machine's projects, and registering MCP servers for
 * directories this machine does not have would be noise at best. Projects with
 * nothing left to write after the sourceOfTruth check are dropped entirely, so
 * the merge never rewrites a project object it has no change for.
 */
async function planProjectScope(
  ctx: RestoreContext,
  manifest: ToolManifest,
  existing: Record<string, unknown>,
): Promise<PlannedProject[]> {
  const projects = isPlainObject(existing.projects) ? existing.projects : {};
  const planned: PlannedProject[] = [];

  for (const entry of manifest.projectMcpServers) {
    // Normalized so a manifest path that mixes separators (the stored
    // template is "/"-joined; splicing a native-backslash {{HOME}} into it on
    // Windows yields "C:\Users\…\home/programming/arbella") lines up with a
    // directory path.join built natively. A no-op on POSIX.
    const dir = path.normalize(hydrateProjectPath(ctx, entry.projectPath));
    if ((await ctx.fs.statKind(dir)) !== "dir") {
      ctx.log.debug(`claude: skip project MCP servers — ${dir} does not exist here`);
      continue;
    }
    // The on-disk key may still be spelled differently (Claude Code wrote it
    // with `path.join`, which can disagree with our normalized `dir` in edge
    // cases `path.normalize` alone doesn't cover) — find it by normalized
    // comparison and REUSE that exact key, so the merge never writes a
    // second key for the same directory.
    const key = findProjectKey(projects, dir) ?? dir;
    const project = key in projects ? projects[key] : undefined;
    const localServers = isPlainObject(project) ? project.mcpServers : undefined;

    const servers: PlannedServer[] = [];
    for (const name of Object.keys(entry.servers).sort()) {
      if (isUnsafeObjectKey(name)) {
        ctx.log.debug(`claude: ignoring MCP server with reserved name ${name}`);
        continue;
      }
      if (keepsLocal(ctx, localServers, name)) {
        ctx.log.debug(`claude: keep local MCP server ${name} (${key}, sourceOfTruth=local)`);
        continue;
      }
      servers.push({ name, def: hydrateDef(ctx, entry.servers[name]!) });
    }
    if (servers.length > 0) planned.push({ dir: key, servers });
  }

  return planned;
}

/**
 * Decide the whole MCP merge WITHOUT touching anything: which servers would be
 * registered, and which of their env values the user has to re-supply.
 *
 * This is the ONE place those rules live. `--dry-run` prints `plan.actions` and
 * the post-restore reminder reads `plan.needsEnv`, while the real merge applies
 * `plan.userServers` / `plan.projectServers` — so the plan cannot promise a
 * registration the merge then skips (it used to: the plan listed every server in
 * the manifest while the merge kept the local one whenever sourceOfTruth said so,
 * and the reminder pointed at "needs env" warnings that were never printed).
 */
export async function planMcpMerge(
  ctx: RestoreContext,
  manifest: ToolManifest,
): Promise<McpMergePlan> {
  const targetPath = paths(ctx.toolHome).globalState;

  // Nothing to merge => do not even read ~/.claude.json. It is the biggest and
  // most sensitive file in the tool home, and a repo captured before MCP support
  // (or from a machine with no servers) has no reason to open it.
  if (
    Object.keys(manifest.mcpServers).length === 0 &&
    manifest.projectMcpServers.length === 0
  ) {
    return emptyMergePlan();
  }

  const { obj, existed, invalid } = await readGlobalState(ctx);

  if (invalid) {
    // Nothing will be written, so nothing is planned. restoreMcpServers turns
    // this into the user-facing warning when a real pull reaches it.
    ctx.log.debug(`claude: ${targetPath} is not valid JSON; planning no MCP registrations`);
    return emptyMergePlan({ existing: obj, existed, invalid });
  }

  const userServers = planUserScope(ctx, manifest, obj);
  const projectServers = await planProjectScope(ctx, manifest, obj);

  const actions: RestoreAction[] = [
    ...userServers.map((s) => ({
      type: "register-mcp-server" as const,
      tool: "claude" as const,
      targetPath,
      description: describeRegistration(`Register MCP server ${s.name} (user scope)`, s.def),
    })),
    ...projectServers.flatMap((p) =>
      p.servers.map((s) => ({
        type: "register-mcp-server" as const,
        tool: "claude" as const,
        targetPath,
        description: describeRegistration(
          `Register MCP server ${s.name} for ${p.dir}`,
          s.def,
        ),
      })),
    ),
  ];

  // Only servers that WOULD be written are reported: a server kept because the
  // local copy won already holds its real values, and telling the user to
  // re-supply them would be a lie.
  const needsEnv: Array<{ name: string; key: string }> = [];
  const note = ({ name, def }: PlannedServer): void => {
    for (const key of redactedEnvKeys(def)) needsEnv.push({ name, key });
  };
  for (const server of userServers) note(server);
  for (const project of projectServers) for (const server of project.servers) note(server);

  return { actions, needsEnv, existing: obj, existed, invalid, userServers, projectServers };
}

/** Apply the planned user-scope servers, returning a new global-state object. */
function mergeUserScope(
  existing: Record<string, unknown>,
  planned: readonly PlannedServer[],
): Record<string, unknown> {
  if (planned.length === 0) return existing;
  const target = isPlainObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  for (const { name, def } of planned) target[name] = def;
  return { ...existing, mcpServers: target };
}

/** Apply the planned project-scope servers, returning a new global-state object. */
function mergeProjectScope(
  existing: Record<string, unknown>,
  planned: readonly PlannedProject[],
): Record<string, unknown> {
  if (planned.length === 0) return existing;
  const projects = isPlainObject(existing.projects) ? { ...existing.projects } : {};

  for (const { dir, servers } of planned) {
    const project = isPlainObject(projects[dir])
      ? { ...(projects[dir] as Record<string, unknown>) }
      : {};
    const target = isPlainObject(project.mcpServers) ? { ...project.mcpServers } : {};
    for (const { name, def } of servers) target[name] = def;
    projects[dir] = { ...project, mcpServers: target };
  }

  return { ...existing, projects };
}

/**
 * Merge the manifest's MCP servers into this machine's ~/.claude.json, applying
 * EXACTLY the decisions {@link planMcpMerge} made (and that `--dry-run` printed).
 *
 * Rules (all of them decided in planMcpMerge):
 *   - the file is created (mode 0600, like Claude's own) when absent; when it
 *     exists its mode is left alone and only the MCP keys are rewritten;
 *   - an existing file that is not valid JSON is NEVER overwritten — we warn and
 *     skip, because clobbering it would destroy the user's auth + history;
 *   - sourceOfTruth "local" keeps an already-registered server; "repo" (or
 *     --force) overwrites it;
 *   - project-scope entries apply only when the project dir exists here;
 *   - every value that was redacted on backup produces one warn line so the user
 *     knows exactly which env keys to re-supply.
 */
export async function restoreMcpServers(
  ctx: RestoreContext,
  manifest: ToolManifest,
): Promise<void> {
  if (
    Object.keys(manifest.mcpServers).length === 0 &&
    manifest.projectMcpServers.length === 0
  ) {
    return;
  }

  const globalState = paths(ctx.toolHome).globalState;
  const plan = await planMcpMerge(ctx, manifest);

  if (plan.invalid) {
    ctx.log.warn(
      "claude: could not merge MCP servers: ~/.claude.json is not valid JSON; " +
        "leaving it untouched.",
    );
    return;
  }

  const written =
    plan.userServers.length +
    plan.projectServers.reduce((n, p) => n + p.servers.length, 0);

  // Nothing merged (every server was kept local, or no project dir exists here):
  // leave the file byte-for-byte alone. Rewriting it would only reformat a file
  // Claude Code may be writing concurrently.
  if (written === 0) {
    ctx.log.debug(`claude: no MCP servers to merge into ${globalState}; left untouched`);
    return;
  }

  const merged = mergeProjectScope(
    mergeUserScope(plan.existing, plan.userServers),
    plan.projectServers,
  );

  // Written ATOMICALLY (temp sibling + rename): Claude Code reads and rewrites
  // this file continuously, so a truncate-then-write would expose an empty or
  // half-written ~/.claude.json — losing the user's auth and project history for
  // exactly as long as the write takes, and permanently if it is interrupted.
  //
  // Mode is passed ONLY on creation: Claude's own file is 0600, and writeAtomic
  // carries an EXISTING file's mode across the rename by itself.
  const serialized = JSON.stringify(merged, null, 2) + "\n";
  await ctx.fs.writeAtomic(globalState, serialized, plan.existed ? undefined : 0o600);
  ctx.log.debug(
    `claude: merged ${written} MCP server(s) into ${globalState}` +
      (plan.existed ? "" : " (created, mode 0600)"),
  );

  for (const { name, key } of plan.needsEnv) {
    ctx.log.warn(
      `claude: MCP server ${name} needs env ${key} re-supplied (redacted on backup)`,
    );
  }
}
