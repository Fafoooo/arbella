/**
 * Capture for the Claude adapter: turn the live ~/.claude tree into a
 * CaptureResult (frozen files + symlinks + reinstall manifest + secret refs).
 *
 * Strategy:
 *   - Walk FROZEN_PATHS. For each existing path, recurse into files.
 *   - Compute `rel` (POSIX, relative to tool home). Skip if it matches the
 *     Claude denylist (secrets / caches / session noise never leave the box).
 *   - Read each file; if textual, sanitize secret VALUES then template machine
 *     paths to {{HOME}}/{{USER}}/... placeholders; emit a CapturedFile with
 *     repoPath = "claude/files/<rel>". Preserve executable mode for hooks/
 *     statusline/commands scripts.
 *   - skills/ is MIXED: a relative symlink "-> ../../.agents/skills/<name>" is a
 *     skills.sh install => emit a CapturedSymlink + a SkillEntry(source:"skills.sh",
 *     symlinked:true, installCommand:"npx skills add <name>"). A real dir is
 *     hand-made => freeze its files + a SkillEntry(source:"frozen").
 *   - Parse plugins/installed_plugins.json + plugins/known_marketplaces.json +
 *     settings.json.enabledPlugins into the manifest.
 *   - Collect npm globals via the shared platform helper.
 *   - Any denylisted-but-present secret file (.credentials.json, .claude.json)
 *     is recorded as a SecretRef(kind:"file") so the user is reminded to
 *     re-supply it; its CONTENTS are never read or stored. The ONE exception is
 *     ~/.claude.json's `mcpServers` / `projects.*.mcpServers` sub-objects, which
 *     mcp.ts lifts into the manifest (sanitized + templated) — no other key of
 *     that file is ever read past the parse.
 *   - projects/<slug>/memory/** is captured under its own `claude/memories/`
 *     root when ctx.includeMemories is on (see memories.ts).
 *   - Scripts the configs POINT AT but that live outside ~/.claude (hook
 *     dispatchers, statusline scripts, MCP launchers under ~/.agents, ~/.local/bin)
 *     are followed with core/homefiles and emitted as `shared/home/<rel>` files
 *     inside this same CaptureResult, together with the well-known plugin
 *     companion configs (~/.claude-mem/settings.json). The backup command merges
 *     every tool's shared/home files into one mirrored root.
 *
 * All fs/sanitizer/templater work goes through the injected CaptureContext, so
 * this module is unit-testable against a fixture dir. No clock, no direct
 * node:fs. dryRun changes nothing here (we never write during capture; the
 * backup command owns writing), but we still honor it by not touching the
 * network/npm when set, to keep dry runs fast and side-effect free.
 */

import path from "node:path";

import { binaryScanViews, decodeForCapture } from "../../utils/capture-bytes.js";
import type { CaptureContext } from "../adapter.interface.js";
import type {
  CaptureResult,
  CapturedFile,
  CapturedSymlink,
  SecretRef,
  SkillEntry,
  ToolManifest,
} from "../../types.js";

import {
  COMMON_DENY,
  denylistFor,
  matchesDeny,
} from "../../core/sanitizer/denylist.js";
import type { CommandRef } from "../../core/homefiles/scan.js";
import { collectCommandRefs } from "../../core/homefiles/scan.js";
import {
  captureHomeFile,
  captureLinkedHomeFiles,
  homeExcludeRoots,
} from "../../core/homefiles/capture.js";
import {
  capturedAbsolutePaths,
  collectExternalTools,
} from "../../core/externaltools/collect.js";
import { normalizeCapturedSymlinkTarget } from "../../utils/symlink.js";
import { listNpmGlobals } from "../../platform/install.js";

import type { ClaudePaths } from "./paths.js";
import { REPO_PREFIX, FROZEN_PATHS, INSTRUCTIONS_FILE, paths } from "./paths.js";
import {
  parseInstalledPlugins,
  parseKnownMarketplaces,
  extractEnabledPlugins,
} from "./plugins.js";
import { captureMcpServers } from "./mcp.js";
import { captureMemories, slugifyPath } from "./memories.js";

/**
 * Files known to hold whole-file secrets; recorded (never read) if present.
 * `abs` resolves each one from the path set because they do not all live INSIDE
 * the tool home — ~/.claude.json is a sibling of ~/.claude.
 */
const SECRET_FILES: ReadonlyArray<{
  rel: string;
  key: string;
  description: string;
  abs: (p: ClaudePaths) => string;
}> = [
  {
    rel: ".credentials.json",
    key: ".credentials.json",
    description: "Claude OAuth / API credentials — re-login after restore.",
    abs: (p) => path.join(p.home, ".credentials.json"),
  },
  {
    rel: ".claude.json",
    key: ".claude.json",
    description:
      "Claude global state (auth + telemetry) — excluded; MCP server definitions " +
      "are carried in manifest.mcpServers.",
    abs: (p) => p.globalState,
  },
];


/** Build the repo path for a tool-home-relative POSIX path. */
function repoPathFor(rel: string): string {
  return `${REPO_PREFIX}/${rel}`;
}

/** Convert an absolute child path under `home` into a POSIX rel path. */
function toRel(home: string, abs: string): string {
  return path.relative(home, abs).split(path.sep).join("/");
}

/**
 * Recursively collect frozen files (and skill symlinks) under an absolute path.
 * Mutates the provided accumulators. Denylisted entries are skipped.
 */
async function walk(
  ctx: CaptureContext,
  home: string,
  abs: string,
  deny: string[],
  files: CapturedFile[],
  symlinks: CapturedSymlink[],
  warnings: string[],
): Promise<void> {
  const kind = await ctx.fs.statKind(abs);
  if (kind === "missing") return;

  const rel = toRel(home, abs);
  if (rel && matchesDeny(rel, deny)) {
    ctx.log.debug(`claude: skip (denylist) ${rel}`);
    return;
  }

  if (kind === "symlink") {
    // A symlink anywhere in the frozen tree is preserved as a link. (Skill
    // symlinks are special-cased by the caller before recursing into skills/.)
    const target = normalizeCapturedSymlinkTarget(await ctx.fs.readLink(abs));
    symlinks.push({ repoPath: repoPathFor(rel), target });
    ctx.log.debug(`claude: symlink ${rel} -> ${target}`);
    return;
  }

  if (kind === "dir") {
    const entries = await ctx.fs.list(abs);
    entries.sort();
    for (const name of entries) {
      await walk(ctx, home, path.join(abs, name), deny, files, symlinks, warnings);
    }
    return;
  }

  // kind === "file"
  await captureFile(ctx, abs, repoPathFor(rel), rel, files, warnings);
}

/**
 * Read + sanitize + template a single file and push a CapturedFile.
 *
 * `repoPath` is the destination inside the backup repo and `source` the label
 * used for sanitizer SecretRefs and warnings. They are passed explicitly (rather
 * than derived from a tool-home-relative path) because memories land under a
 * different repo root than the frozen tree — see memories.ts.
 */
async function captureFile(
  ctx: CaptureContext,
  abs: string,
  repoPath: string,
  source: string,
  files: CapturedFile[],
  warnings: string[],
): Promise<void> {
  let mode: number | undefined;
  try {
    // Preserve executable bit for scripts (hooks/statusline/commands *.sh|*.py).
    const { promises: fsp } = await import("node:fs");
    const st = await fsp.stat(abs);
    mode = st.mode & 0o777;
  } catch {
    mode = undefined;
  }

  let bytes: Buffer;
  try {
    bytes = await ctx.fs.readBytes(abs);
  } catch (err) {
    warnings.push(`claude: could not read ${source}: ${(err as Error).message}`);
    return;
  }

  const decoded = decodeForCapture(bytes);

  if (decoded.kind === "binary") {
    // Fail-safe: never let a "binary" file smuggle a secret past the sanitizer.
    // Scan every lossy view (UTF-8 + UTF-16LE/BE at both alignments) — a NUL-
    // interleaved token is invisible to a UTF-8-only scan. If secret-shaped bytes
    // are present (and we're not opted into carrying secrets), DROP the file with
    // a warning rather than base64'ing it in raw.
    if (
      !ctx.includeSecrets &&
      binaryScanViews(bytes).some((view) => ctx.sanitizer.sanitizeText(view, "claude", source).changed)
    ) {
      warnings.push(`claude: skipped ${source} — binary content with secret-shaped bytes`);
      return;
    }
    const file: CapturedFile = {
      repoPath,
      content: bytes.toString("base64"),
      binary: true,
    };
    if (mode !== undefined) file.mode = mode;
    files.push(file);
    return;
  }

  // Textual: sanitize secret values (unless includeSecrets opts INTO carrying
  // them), then template machine paths.
  //
  // sanitizeFile routes JSON configs (settings.json, settings.local.json, ...)
  // through the STRUCTURAL key-name-aware sanitizer so an opaque secret under a
  // secret KEY NAME (e.g. ANTHROPIC_AUTH_TOKEN feeding an MCP server /
  // apiKeyHelper) is redacted even when its value matches no known token shape;
  // non-JSON files (hooks/*.sh|*.py, CLAUDE.md, ...) fall back to the text pass.
  //
  // ctx.includeSecrets (opt-in, default OFF) is the documented switch that carries
  // inline secret VALUES into the PRIVATE repo: when true we SKIP value redaction
  // so the real values are stored (the "risk" the init prompt/README warn about).
  // Whole-file credential stores (.credentials.json/.claude.json) remain excluded
  // by the denylist regardless — only in-place values in shareable configs are
  // carried, never the wholesale token files.
  // UTF-16 files are decoded to text above, so a lone NUL byte never routes a
  // secret-bearing config around sanitizeFile.
  const raw = decoded.text;
  const content = ctx.includeSecrets
    ? raw
    : ctx.sanitizer.sanitizeFile(raw, "claude", source).content;
  const templated = ctx.templater.toTemplate(content, ctx.vars);

  const file: CapturedFile = {
    repoPath,
    content: templated,
  };
  if (mode !== undefined) file.mode = mode;
  files.push(file);
}

/**
 * Handle the skills/ directory specially: classify each entry as a skills.sh
 * symlink (reinstallable) or a frozen hand-made dir.
 */
async function captureSkills(
  ctx: CaptureContext,
  home: string,
  skillsDir: string,
  deny: string[],
  files: CapturedFile[],
  symlinks: CapturedSymlink[],
  skills: SkillEntry[],
  warnings: string[],
): Promise<void> {
  if ((await ctx.fs.statKind(skillsDir)) !== "dir") return;

  const entries = await ctx.fs.list(skillsDir);
  entries.sort();

  for (const name of entries) {
    const abs = path.join(skillsDir, name);
    const rel = toRel(home, abs);
    if (matchesDeny(rel, deny)) {
      ctx.log.debug(`claude: skip skill (denylist) ${rel}`);
      continue;
    }

    const kind = await ctx.fs.statKind(abs);
    if (kind === "symlink") {
      // skills.sh: ~/.claude/skills/<name> -> ../../.agents/skills/<name>
      const target = normalizeCapturedSymlinkTarget(await ctx.fs.readLink(abs));
      symlinks.push({ repoPath: repoPathFor(rel), target });
      skills.push({
        name,
        source: "skills.sh",
        symlinked: true,
        installCommand: `npx skills add ${name}`,
      });
      ctx.log.debug(`claude: skill (skills.sh) ${name} -> ${target}`);
    } else if (kind === "dir") {
      // Hand-made skill: freeze its files AND record it as frozen.
      await walk(ctx, home, abs, deny, files, symlinks, warnings);
      skills.push({ name, source: "frozen", symlinked: false });
      ctx.log.debug(`claude: skill (frozen) ${name}`);
    } else if (kind === "file") {
      // A loose file directly under skills/ (rare) — freeze it.
      await captureFile(ctx, abs, repoPathFor(rel), rel, files, warnings);
    }
  }
}

/**
 * Companion config dirs of Claude PLUGINS: reinstalled from the manifest, but
 * their own settings live outside ~/.claude and would otherwise be lost. Paths
 * are $HOME-relative POSIX and land under `shared/home/` like any linked script.
 */
const COMPANION_FILES: ReadonlyArray<{ rel: string; reason: string }> = [
  { rel: ".claude-mem/settings.json", reason: "companion:claude-mem" },
];

/**
 * Capture everything Claude needs that lives in $HOME but OUTSIDE ~/.claude:
 * the hook/statusline/MCP scripts its configs point at, and the well-known
 * plugin companion configs.
 *
 * The command refs come from the already-parsed settings files and from
 * mcp.ts's raw pass over ~/.claude.json — no config file is read twice, and no
 * key of ~/.claude.json beyond its MCP sub-objects is ever looked at.
 *
 * Returns the full ref list so the external-tool collector (WP-C) can classify
 * the same commands without parsing anything again.
 */
async function captureHomeExtras(
  ctx: CaptureContext,
  settingsJson: unknown,
  settingsLocalJson: unknown,
  mcpRefs: readonly CommandRef[],
  out: { files: CapturedFile[]; secrets: SecretRef[]; warnings: string[] },
): Promise<CommandRef[]> {
  const opts = { excludeRoots: homeExcludeRoots(ctx.toolHome) };

  const refs: CommandRef[] = [
    ...collectCommandRefs(settingsJson, "claude:settings.json"),
    ...collectCommandRefs(settingsLocalJson, "claude:settings.local.json"),
    ...mcpRefs,
  ];
  await captureLinkedHomeFiles(ctx, refs, "claude", out, opts);

  for (const companion of COMPANION_FILES) {
    const abs = path.join(ctx.vars.HOME, ...companion.rel.split("/"));
    await captureHomeFile(ctx, abs, "claude", companion.reason, out, opts);
  }

  return refs;
}

/** Read + parse a JSON file via the fs service; returns undefined if absent/bad. */
async function readJson(
  ctx: CaptureContext,
  abs: string,
  warnings: string[],
  label: string,
): Promise<unknown | undefined> {
  if ((await ctx.fs.statKind(abs)) !== "file") return undefined;
  try {
    return JSON.parse(await ctx.fs.read(abs));
  } catch (err) {
    warnings.push(`claude: could not parse ${label}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Capture the Claude setup.
 *
 * @param ctx  injected services + tool home + flags.
 * @param opts.skipInstructions when true (R9 shared instructions active), do NOT
 *             emit CLAUDE.md as a frozen file — the backup command stores it once
 *             under shared/instructions.md instead.
 */
export async function capture(
  ctx: CaptureContext,
  opts?: { skipInstructions?: boolean },
): Promise<CaptureResult> {
  const skipInstructions = opts?.skipInstructions ?? false;
  const home = ctx.toolHome;
  const p = paths(home);
  const deny = denylistFor("claude");

  const files: CapturedFile[] = [];
  const symlinks: CapturedSymlink[] = [];
  const skills: SkillEntry[] = [];
  const secrets: SecretRef[] = [];
  const warnings: string[] = [];

  // ----- Frozen files (recurse FROZEN_PATHS) -----
  for (const top of FROZEN_PATHS) {
    if (skipInstructions && top === INSTRUCTIONS_FILE) {
      ctx.log.debug("claude: skipping CLAUDE.md (shared instructions)");
      continue;
    }
    if (top === "skills") {
      await captureSkills(ctx, home, p.skillsDir, deny, files, symlinks, skills, warnings);
      continue;
    }
    await walk(ctx, home, path.join(home, top), deny, files, symlinks, warnings);
  }

  // ----- Per-project memories (R13, opt-in) -----
  // Stored under their OWN repo root (claude/memories/…), not claude/files/,
  // because ~/.claude/projects is denylisted wholesale and the layout has to be
  // portable across machines with different $HOME values.
  if (ctx.includeMemories) {
    await captureMemories(
      ctx,
      p.projectsDir,
      slugifyPath(ctx.vars.HOME),
      // COMMON_DENY, not the Claude list: memory paths are relative to a
      // project's memory/ dir, so the root-anchored Claude patterns ("/feedback/",
      // "/plugins/") would match a memory SUBDIRECTORY of the same name and drop
      // it. Only the universal cruft rules make sense at this root.
      [...COMMON_DENY],
      (abs, repoPath, source) => captureFile(ctx, abs, repoPath, source, files, warnings),
    );
  } else {
    ctx.log.debug("claude: skipping projects/*/memory (includeMemories is off)");
  }

  // ----- Manifest: plugins, marketplaces, enabledPlugins -----
  const installedJson = await readJson(ctx, p.installedPlugins, warnings, "installed_plugins.json");
  const marketplacesJson = await readJson(ctx, p.knownMarketplaces, warnings, "known_marketplaces.json");
  const settingsJson = await readJson(ctx, p.settings, warnings, "settings.json");
  const settingsLocalJson = await readJson(
    ctx,
    p.settingsLocal,
    warnings,
    "settings.local.json",
  );

  // Fold project-scope plugin paths (projectPath) to {{HOME}}-style placeholders,
  // exactly like file contents — otherwise the raw machine path leaks into the repo.
  const plugins = parseInstalledPlugins(installedJson, (p) =>
    ctx.templater.toTemplate(p, ctx.vars),
  );
  const marketplaces = parseKnownMarketplaces(marketplacesJson);
  const enabledPlugins = extractEnabledPlugins(settingsJson);

  // Mirror the enabled state onto each plugin entry for convenience.
  for (const entry of plugins) {
    if (entry.id in enabledPlugins) {
      entry.enabled = enabledPlugins[entry.id]!;
    }
  }

  // ----- npm globals (shared source of truth) -----
  let npmGlobals: ToolManifest["npmGlobals"] = [];
  try {
    npmGlobals = await listNpmGlobals();
  } catch (err) {
    warnings.push(`claude: npm globals unavailable: ${(err as Error).message}`);
  }

  // ----- Secret files: record presence, never read contents -----
  for (const sf of SECRET_FILES) {
    if (await ctx.fs.exists(sf.abs(p))) {
      secrets.push({
        tool: "claude",
        source: sf.rel,
        key: sf.key,
        description: sf.description,
        kind: "file",
      });
    }
  }

  // ----- MCP servers lifted out of ~/.claude.json (see mcp.ts) -----
  const mcp = await captureMcpServers(ctx);
  secrets.push(...mcp.secrets);
  warnings.push(...mcp.warnings);

  // ----- Linked scripts + companion configs in $HOME (WP-B) -----
  const commandRefs = await captureHomeExtras(
    ctx,
    settingsJson,
    settingsLocalJson,
    mcp.commandRefs,
    { files, secrets, warnings },
  );

  // ----- External tools behind those same commands (WP-C) -----
  // Runs on the FULL file list so a command pointing at something this capture
  // already carries (a statusline script under ~/.claude, a hook dispatcher in
  // shared/home) is restored as a file rather than reported as a missing package.
  const externalTools = await collectExternalTools(commandRefs, {
    home: ctx.vars.HOME,
    capturedPaths: capturedAbsolutePaths(files, {
      home: ctx.vars.HOME,
      toolHome: home,
      filesPrefix: REPO_PREFIX,
    }),
    toTemplate: (value) => ctx.templater.toTemplate(value, ctx.vars),
  });

  const manifest: ToolManifest = {
    tool: "claude",
    plugins,
    marketplaces,
    skills,
    npmGlobals,
    enabledPlugins,
    mcpServers: mcp.mcpServers,
    projectMcpServers: mcp.projectMcpServers,
    externalTools,
  };

  ctx.log.debug(
    `claude: captured ${files.length} files, ${symlinks.length} symlinks, ` +
      `${plugins.length} plugins, ${marketplaces.length} marketplaces, ` +
      `${skills.length} skills, ${npmGlobals.length} npm globals, ` +
      `${Object.keys(mcp.mcpServers).length} MCP servers, ` +
      `${externalTools.length} external tools`,
  );

  return { tool: "claude", files, symlinks, manifest, secrets, warnings };
}

export default capture;
