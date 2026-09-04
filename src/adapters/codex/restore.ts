/**
 * Codex restore: place frozen files + symlinks onto the target machine, reinstall
 * plugins/marketplaces, and recreate reinstallable skills.
 *
 * Strategy for plugins/marketplaces (documented choice):
 *   The Codex CLI's plugin surface is `codex plugin ...`. We attempt, in order:
 *     codex plugin marketplace add <source>
 *     codex plugin add <name@marketplace>
 *   guarded by `which("codex")`. If the CLI is missing OR a command exits
 *   non-zero (the subcommand may differ across Codex versions), we DO NOT fail
 *   the restore: the sanitized config.toml we just wrote already retains the
 *   [marketplaces.*] and [plugins.*] tables (configToml.ts keeps them), so Codex
 *   re-syncs them from config on next launch. We log.warn that a manual
 *   `codex` re-sync may be needed. This keeps restore resilient and idempotent.
 *
 * File writing: each CapturedFile's repoPath is stripped of the "codex/files/"
 * prefix and joined onto ctx.toolHome THROUGH the shared containment gate
 * (utils/safe-path.ts: no `..`/backslash/absolute segment, no symlinked
 * component below the tool home), then written with the rename-based writers so
 * a link at the leaf is replaced rather than followed. Text files are de-templated
 * (fromTemplate) so {{TOKENS}} become this machine's paths; config.toml is
 * additionally rehydrated (same fromTemplate, applied through configToml.ts for
 * clarity/symmetry). Binary files are decoded from base64. Modes are restored.
 * sourceOfTruth governs whether existing files are overwritten.
 */

import { execa } from "execa";

import type { RestoreContext, RestoreData } from "../adapter.interface.js";
import type { CapturedFile, MarketplaceEntry, PluginEntry, RestoreAction } from "../../types.js";
import { which } from "../../platform/install.js";
import { resolveContainedTarget } from "../../utils/safe-path.js";
import type { ContainedTarget, ContainedTargetOptions } from "../../utils/safe-path.js";
import { REPO_PREFIX } from "./paths.js";
import { rehydrateConfigToml } from "./configToml.js";

/** POSIX prefix that every Codex CapturedFile.repoPath carries. */
const PREFIX_WITH_SLASH = `${REPO_PREFIX}/`;

/** Map a repoPath ("codex/files/X") to its tool-home-relative POSIX subpath ("X"). */
function repoPathToRel(repoPath: string): string | null {
  if (!repoPath.startsWith(PREFIX_WITH_SLASH)) return null;
  return repoPath.slice(PREFIX_WITH_SLASH.length);
}

/**
 * Resolve a captured repoPath onto a CHECKED absolute target under ctx.toolHome,
 * or null when the repoPath belongs to a repo root this adapter does not own.
 *
 * The rel half is repo-supplied, so it goes through the shared containment gate
 * rather than a bare `path.join`: `codex/files/../../x` (and its backslash
 * twin) must not resolve outside ~/.codex, and a planted `~/.codex/prompts ->
 * /elsewhere` must not silently receive the write. Callers decide what to do
 * with a refusal — the planner drops the action, the writer warns — so the two
 * cannot disagree about which files a pull touches.
 */
async function targetFor(
  ctx: RestoreContext,
  repoPath: string,
  opts: ContainedTargetOptions = {},
): Promise<{ rel: string; target: ContainedTarget } | null> {
  const rel = repoPathToRel(repoPath);
  if (rel === null) return null;
  return { rel, target: await resolveContainedTarget(ctx.fs, ctx.toolHome, rel, opts) };
}

/** Is this captured file the Codex config.toml? */
function isConfigToml(rel: string): boolean {
  return rel === "config.toml";
}

/**
 * Build the plan fragment (actions) without executing. Used by the restore
 * command for --dry-run and to size the safety backup.
 */
export async function planActions(
  ctx: RestoreContext,
  data: RestoreData,
): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];
  const overwriteAllowed = ctx.sourceOfTruth === "repo";

  // Frozen files. A target the writer would refuse (traversal, symlinked
  // component) or keep (local wins) is omitted, so --dry-run lists exactly the
  // writes restore() will make.
  for (const file of data.files) {
    const resolved = await targetFor(ctx, file.repoPath);
    if (resolved === null || !resolved.target.ok) continue;
    const targetPath = resolved.target.path;
    const exists = await ctx.fs.exists(targetPath);
    if (!overwriteAllowed && exists) continue;
    actions.push({
      type: "write-file",
      tool: "codex",
      targetPath,
      description: `Write ${resolved.rel}${file.binary ? " (binary)" : ""}`,
      overwrites: exists && overwriteAllowed,
    });
  }

  // Symlinks (skills.sh etc.). `fs.symlink` REPLACES the leaf entry, so only the
  // components above it have to be link-free.
  for (const link of data.symlinks) {
    const resolved = await targetFor(ctx, link.repoPath, { allowLeafSymlink: true });
    if (resolved === null || !resolved.target.ok) continue;
    const targetPath = resolved.target.path;
    // statKind, not exists(): a dangling link is still an entry the writer keeps.
    const exists = (await ctx.fs.statKind(targetPath)) !== "missing";
    if (!overwriteAllowed && exists) continue;
    actions.push({
      type: "write-symlink",
      tool: "codex",
      targetPath,
      description: `Link ${resolved.rel} -> ${link.target}`,
      overwrites: exists && overwriteAllowed,
    });
  }

  // Marketplaces, then plugins (user-scope only). A "local" marketplace's
  // source is a Codex-managed bundled-runtime path (e.g. under .tmp/ or
  // .cache/) that only exists on the machine that captured it and is
  // regenerated by Codex itself — skip planning it when the hydrated path is
  // absent here rather than surfacing a doomed registration action.
  const plannedMarketplaces: MarketplaceEntry[] = [];
  for (const m of data.manifest.marketplaces) {
    const hydratedSource = ctx.templater.fromTemplate(m.source, ctx.vars);
    if (m.sourceType === "local" && (await ctx.fs.statKind(hydratedSource)) === "missing") {
      ctx.log.debug(
        `codex: skip marketplace ${m.id} (bundled runtime not present at ${hydratedSource})`,
      );
      continue;
    }
    plannedMarketplaces.push(m);
    actions.push({
      type: "add-marketplace",
      tool: "codex",
      description: `Register marketplace ${m.id} (${hydratedSource})`,
    });
  }
  // Only the marketplaces this plan will actually register can resolve a plugin.
  // Passing the FULL manifest list here advertised `Install plugin <id>` for a
  // plugin whose local marketplace was just skipped — a dry-run line for an
  // install that cannot succeed.
  const { installable } = partitionPluginsForRestore(
    plannedMarketplaces,
    data.manifest.plugins.filter((p) => p.scope === "user"),
  );
  for (const plugin of installable) {
    actions.push({
      type: "install-plugin",
      tool: "codex",
      description: `Install plugin ${plugin.id}`,
    });
  }

  // Reinstallable skills (skills.sh).
  for (const skill of data.manifest.skills) {
    if (skill.source !== "skills.sh") continue;
    actions.push({
      type: "install-skill",
      tool: "codex",
      description: `Install skill ${skill.name} (${skill.installCommand ?? "npx skills add " + skill.name})`,
    });
  }

  // NOTE: npm globals are intentionally NOT planned per-tool. The restore command
  // dedupes them across every restored tool and emits a single set of system-level
  // install-npm-global actions (and runs them once each), so the dry-run plan
  // matches the executor and a package is never installed twice. See
  // src/commands/restore.ts (npmGlobalActions / installSharedNpmGlobals).

  return actions;
}

/**
 * Restore the Codex setup. No-ops on every filesystem/install action when
 * ctx.dryRun is true (planActions is the dry-run reporter; restore itself simply
 * returns early so the command can call either path).
 */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  if (ctx.dryRun) {
    // Nothing to mutate in dry-run; the command prints planActions() output.
    return;
  }

  const overwriteAllowed = ctx.sourceOfTruth === "repo";

  await ctx.fs.ensureDir(ctx.toolHome);

  // 1) Write frozen files (config.toml rehydrated; modes restored).
  for (const file of data.files) {
    await writeCapturedFile(ctx, file, overwriteAllowed);
  }

  // 2) Recreate symlinks.
  for (const link of data.symlinks) {
    const resolved = await targetFor(ctx, link.repoPath, { allowLeafSymlink: true });
    if (resolved === null) continue;
    if (!resolved.target.ok) {
      ctx.log.warn(
        `codex: refusing to link ${link.repoPath} — ${resolved.target.reason}`,
      );
      continue;
    }
    const targetPath = resolved.target.path;
    // Local wins: an entry that is already here is kept, as it is for files.
    if (!overwriteAllowed && (await ctx.fs.statKind(targetPath)) !== "missing") {
      ctx.log.debug(`codex: keep existing ${resolved.rel} (sourceOfTruth=local)`);
      continue;
    }
    try {
      await ctx.fs.symlink(link.target, targetPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`codex: could not recreate symlink ${resolved.rel} (${msg})`);
    }
  }

  // 3) Reinstall marketplaces + plugins via the codex CLI (best-effort).
  await reinstallPluginsAndMarketplaces(ctx, data.manifest.marketplaces, data.manifest.plugins);

  // 4) Reinstall skills.sh skills.
  await reinstallSkills(ctx, data.manifest.skills);

  // npm globals are installed by the restore command's shared, deduped install
  // pass (src/commands/restore.ts -> installSharedNpmGlobals), which runs once
  // across ALL restored tools. The adapter records them in the manifest but does
  // not install them here (doing so would double-install when claude is also in
  // the restore set, and would miss them on a codex-only restore if left to the
  // claude adapter). This is the fix for the codex-only-restore gap.
}

/** Write a single CapturedFile onto the target, honoring overwrite policy + mode. */
async function writeCapturedFile(
  ctx: RestoreContext,
  file: CapturedFile,
  overwriteAllowed: boolean,
): Promise<void> {
  const resolved = await targetFor(ctx, file.repoPath);
  if (resolved === null) return;
  if (!resolved.target.ok) {
    ctx.log.warn(`codex: refusing to write ${file.repoPath} — ${resolved.target.reason}`);
    return;
  }
  const { rel, target } = resolved;
  const targetPath = target.path;

  if (!overwriteAllowed && (await ctx.fs.exists(targetPath))) {
    ctx.log.debug(`codex: skip existing ${rel} (sourceOfTruth=local)`);
    return;
  }

  // Rename-based writers: the containment check above and the write cannot be
  // one operation, and a plain write FOLLOWS a link that appears at the leaf in
  // the gap. `rename` replaces the entry instead.
  if (file.binary) {
    const bytes = Buffer.from(file.content, "base64");
    await ctx.fs.writeBytesAtomic(targetPath, bytes, file.mode);
    return;
  }

  // Text: expand {{TOKENS}} back to this machine's paths. config.toml goes through
  // the dedicated rehydrate helper for symmetry with capture (same transform).
  const content = isConfigToml(rel)
    ? rehydrateConfigToml(file.content, ctx.templater, ctx.vars)
    : ctx.templater.fromTemplate(file.content, ctx.vars);

  await ctx.fs.writeAtomic(targetPath, content, file.mode);
}

/**
 * Split user-scope plugins into those installable via the `codex` CLI now and
 * those that must be DEFERRED to Codex's own config.toml re-sync.
 *
 * A plugin keyed `name@marketplace` can only be `codex plugin add`-ed if its
 * marketplace is REGISTERED ON THIS MACHINE. `marketplaces` is therefore the set
 * that survived this restore's own marketplace pass — NOT the full manifest
 * list: a Codex BUILT-IN curated marketplace like `openai-curated` was never
 * captured (it has no addable source), and a captured `local` marketplace is
 * skipped when its bundled-runtime path does not exist here. Either way the CLI
 * cannot resolve the plugin, so the install would fail every time. Those are
 * left to the restored config.toml (which still carries their `[plugins."…"]`
 * table) for Codex to re-sync on next launch. Plugins with no marketplace are
 * installable.
 */
export function partitionPluginsForRestore(
  marketplaces: MarketplaceEntry[],
  userPlugins: PluginEntry[],
): { installable: PluginEntry[]; deferred: PluginEntry[] } {
  const known = new Set(marketplaces.map((m) => m.id));
  const installable: PluginEntry[] = [];
  const deferred: PluginEntry[] = [];
  for (const p of userPlugins) {
    if (p.marketplace !== undefined && !known.has(p.marketplace)) {
      deferred.push(p);
    } else {
      installable.push(p);
    }
  }
  return { installable, deferred };
}

/**
 * Best-effort marketplace + plugin reinstall via the `codex` CLI. Failures are
 * logged, never thrown: the written config.toml already carries the tables so
 * Codex can re-sync on next launch.
 */
async function reinstallPluginsAndMarketplaces(
  ctx: RestoreContext,
  marketplaces: MarketplaceEntry[],
  plugins: PluginEntry[],
): Promise<void> {
  const userPlugins = plugins.filter((p) => p.scope === "user");
  if (marketplaces.length === 0 && userPlugins.length === 0) return;

  const hasCodex = await which("codex");
  if (!hasCodex) {
    ctx.log.warn(
      "codex CLI not found; plugins/marketplaces left in config.toml for Codex to re-sync on next launch.",
    );
    return;
  }

  // The marketplaces that are actually resolvable on THIS machine after this
  // pass — a skipped local marketplace and a failed `marketplace add` are both
  // absent, so a plugin that needs one is deferred rather than attempted.
  const registered: MarketplaceEntry[] = [];
  for (const m of marketplaces) {
    const hydratedSource = ctx.templater.fromTemplate(m.source, ctx.vars);
    if (m.sourceType === "local" && (await ctx.fs.statKind(hydratedSource)) === "missing") {
      ctx.log.debug(
        `codex: skip marketplace ${m.id} (bundled runtime not present at ${hydratedSource})`,
      );
      continue;
    }
    const args = marketplaceAddArgs({ ...m, source: hydratedSource });
    try {
      await execa("codex", args, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      registered.push(m);
      ctx.log.step(`codex: registered marketplace ${m.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`codex: 'codex ${args.join(" ")}' failed (${msg}); config.toml retains it.`);
    }
  }

  const { installable, deferred } = partitionPluginsForRestore(registered, userPlugins);

  // Plugins whose marketplace is not registered HERE can't be CLI-installed (no
  // marketplace to resolve them against) — a Codex BUILT-IN curated marketplace
  // that was never captured, or a local one whose bundled runtime is absent on
  // this machine. The placed config.toml carries them and Codex re-syncs on next
  // launch. Note it calmly instead of attempting a doomed install and warning.
  for (const plugin of deferred) {
    ctx.log.step(
      `codex: ${plugin.id} needs marketplace ${plugin.marketplace}, which is not ` +
        "registered here; left to config.toml for Codex to re-sync.",
    );
  }

  for (const plugin of installable) {
    const args = pluginInstallArgs(plugin);
    try {
      await execa("codex", args, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      ctx.log.step(`codex: installed plugin ${plugin.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`codex: 'codex ${args.join(" ")}' failed (${msg}); config.toml retains it.`);
    }
  }
}

/** Reinstall skills.sh-sourced skills via `npx skills add <name>` (best-effort). */
async function reinstallSkills(
  ctx: RestoreContext,
  skills: RestoreData["manifest"]["skills"],
): Promise<void> {
  const reinstallable = skills.filter((s) => s.source === "skills.sh");
  if (reinstallable.length === 0) return;

  for (const skill of reinstallable) {
    try {
      await execa("npx", ["skills", "add", skill.name], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      ctx.log.step(`codex: installed skill ${skill.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`codex: 'npx skills add ${skill.name}' failed (${msg}); skill skipped.`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* CLI argv builders (exported for testability + reuse)                         */
/* -------------------------------------------------------------------------- */

/** argv for registering a Codex marketplace from a MarketplaceEntry. */
export function marketplaceAddArgs(m: MarketplaceEntry): string[] {
  return ["plugin", "marketplace", "add", m.source];
}

/** argv for installing a Codex plugin from a PluginEntry. */
export function pluginInstallArgs(p: PluginEntry): string[] {
  return ["plugin", "add", p.id];
}
