/**
 * Codex restore: place frozen files + symlinks onto the target machine, reinstall
 * plugins/marketplaces, and recreate reinstallable skills.
 *
 * Strategy for plugins/marketplaces (documented choice):
 *   The Codex CLI's plugin surface is `codex plugin ...`. We attempt, in order:
 *     codex plugin marketplace add <source>
 *     codex plugin install <name@marketplace>
 *   guarded by `which("codex")`. If the CLI is missing OR a command exits
 *   non-zero (the subcommand may differ across Codex versions), we DO NOT fail
 *   the restore: the sanitized config.toml we just wrote already retains the
 *   [marketplaces.*] and [plugins.*] tables (configToml.ts keeps them), so Codex
 *   re-syncs them from config on next launch. We log.warn that a manual
 *   `codex` re-sync may be needed. This keeps restore resilient and idempotent.
 *
 * File writing: each CapturedFile's repoPath is stripped of the "codex/files/"
 * prefix and joined onto ctx.toolHome. Text files are de-templated
 * (fromTemplate) so {{TOKENS}} become this machine's paths; config.toml is
 * additionally rehydrated (same fromTemplate, applied through configToml.ts for
 * clarity/symmetry). Binary files are decoded from base64. Modes are restored.
 * sourceOfTruth governs whether existing files are overwritten.
 */

import path from "node:path";

import { execa } from "execa";

import type { RestoreContext, RestoreData } from "../adapter.interface.js";
import type { CapturedFile, MarketplaceEntry, PluginEntry, RestoreAction } from "../../types.js";
import { which } from "../../platform/install.js";
import { REPO_PREFIX } from "./paths.js";
import { rehydrateConfigToml } from "./configToml.js";

/** POSIX prefix that every Codex CapturedFile.repoPath carries. */
const PREFIX_WITH_SLASH = `${REPO_PREFIX}/`;

/** Map a repoPath ("codex/files/X") to its tool-home-relative POSIX subpath ("X"). */
function repoPathToRel(repoPath: string): string | null {
  if (!repoPath.startsWith(PREFIX_WITH_SLASH)) return null;
  return repoPath.slice(PREFIX_WITH_SLASH.length);
}

/** Resolve a tool-home-relative POSIX subpath onto the absolute target path. */
function targetAbsFor(toolHome: string, rel: string): string {
  // Split on POSIX "/" and re-join with node:path so win32 separators are right.
  const segments = rel.split("/").filter((s) => s.length > 0);
  return path.join(toolHome, ...segments);
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

  // Frozen files.
  for (const file of data.files) {
    const rel = repoPathToRel(file.repoPath);
    if (rel === null) continue;
    const targetPath = targetAbsFor(ctx.toolHome, rel);
    const exists = await ctx.fs.exists(targetPath);
    actions.push({
      type: "write-file",
      tool: "codex",
      targetPath,
      description: `Write ${rel}${file.binary ? " (binary)" : ""}`,
      overwrites: exists && overwriteAllowed,
    });
  }

  // Symlinks (skills.sh etc.).
  for (const link of data.symlinks) {
    const rel = repoPathToRel(link.repoPath);
    if (rel === null) continue;
    const targetPath = targetAbsFor(ctx.toolHome, rel);
    const exists = await ctx.fs.exists(targetPath);
    actions.push({
      type: "write-symlink",
      tool: "codex",
      targetPath,
      description: `Link ${rel} -> ${link.target}`,
      overwrites: exists && overwriteAllowed,
    });
  }

  // Marketplaces, then plugins (user-scope only).
  for (const m of data.manifest.marketplaces) {
    actions.push({
      type: "add-marketplace",
      tool: "codex",
      description: `Register marketplace ${m.id} (${m.source})`,
    });
  }
  for (const plugin of data.manifest.plugins) {
    if (plugin.scope !== "user") continue;
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
    const rel = repoPathToRel(link.repoPath);
    if (rel === null) continue;
    const targetPath = targetAbsFor(ctx.toolHome, rel);
    try {
      await ctx.fs.symlink(link.target, targetPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`codex: could not recreate symlink ${rel} (${msg})`);
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
  const rel = repoPathToRel(file.repoPath);
  if (rel === null) return;
  const targetPath = targetAbsFor(ctx.toolHome, rel);

  if (!overwriteAllowed && (await ctx.fs.exists(targetPath))) {
    ctx.log.debug(`codex: skip existing ${rel} (sourceOfTruth=local)`);
    return;
  }

  if (file.binary) {
    const bytes = Buffer.from(file.content, "base64");
    await ctx.fs.writeBytes(targetPath, bytes, file.mode);
    return;
  }

  // Text: expand {{TOKENS}} back to this machine's paths. config.toml goes through
  // the dedicated rehydrate helper for symmetry with capture (same transform).
  const content = isConfigToml(rel)
    ? rehydrateConfigToml(file.content, ctx.templater, ctx.vars)
    : ctx.templater.fromTemplate(file.content, ctx.vars);

  await ctx.fs.write(targetPath, content, file.mode);
}

/**
 * Split user-scope plugins into those installable via the `codex` CLI now and
 * those that must be DEFERRED to Codex's own config.toml re-sync.
 *
 * A plugin keyed `name@marketplace` can only be `codex plugin install`-ed if its
 * marketplace was captured (and thus `codex plugin marketplace add`-ed first).
 * Plugins referencing a marketplace we did NOT capture — e.g. a Codex BUILT-IN
 * curated marketplace like `openai-curated`, which has no addable source — can't
 * be resolved by the CLI, so the install would fail every time. Those are left to
 * the restored config.toml (which still carries their `[plugins."…"]` table) for
 * Codex to re-sync on next launch. Plugins with no marketplace are installable.
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

  for (const m of marketplaces) {
    const args = marketplaceAddArgs(m);
    try {
      await execa("codex", args, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      ctx.log.step(`codex: registered marketplace ${m.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`codex: 'codex ${args.join(" ")}' failed (${msg}); config.toml retains it.`);
    }
  }

  const { installable, deferred } = partitionPluginsForRestore(marketplaces, userPlugins);

  // Plugins on a built-in / uncaptured marketplace can't be CLI-installed (no
  // marketplace to resolve them against); the placed config.toml carries them and
  // Codex re-syncs on next launch. Note it calmly instead of attempting a doomed
  // install and warning.
  for (const plugin of deferred) {
    ctx.log.step(
      `codex: ${plugin.id} uses a built-in marketplace (${plugin.marketplace}); ` +
        "left to config.toml for Codex to re-sync.",
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
  return ["plugin", "install", p.id];
}
