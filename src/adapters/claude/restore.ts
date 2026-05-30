/**
 * Restore for the Claude adapter: materialize the frozen ~/.claude subtree onto
 * the target machine, recreate skill symlinks, reinstall marketplaces + plugins
 * via the `claude` CLI, re-enable plugins by merging enabledPlugins into the
 * restored settings.json, and reinstall skills.sh skills via `npx skills add`.
 *
 * Placement (BUILD_CONTRACT §5.10):
 *   - For each CapturedFile, strip the "claude/files/" prefix from repoPath and
 *     join onto ctx.toolHome. Run templater.fromTemplate FIRST so {{HOME}}/
 *     {{USER}}/... become this machine's real values, then write (restoring the
 *     POSIX mode for executables). Binary files are base64-decoded.
 *   - Recreate each CapturedSymlink with its verbatim (relative) target.
 *   - `claude plugin marketplace add <source>` for every marketplace, then
 *     `claude plugin install <id> --scope user` for every USER-scope plugin.
 *   - Merge manifest.enabledPlugins into the freshly-written settings.json (the
 *     file Claude actually reads) so disabled plugins stay disabled.
 *   - `npx skills add <name>` for every skills.sh skill (the symlink itself is
 *     recreated above; this repopulates ~/.agents/skills/<name>).
 *
 * sourceOfTruth (R12): "repo" => overwrite existing local files; "local" =>
 * never clobber a file that already exists locally (skip + debug). All install
 * steps are guarded by `which("claude")` / the npm helper and degrade to a
 * warning when the CLI is missing, rather than throwing.
 *
 * planActions() returns the same set of intended actions WITHOUT executing, for
 * the restore command's --dry-run output.
 */

import path from "node:path";

import { execa } from "execa";

import type { RestoreContext, RestoreData } from "../adapter.interface.js";
import type { RestoreAction, CapturedFile } from "../../types.js";

import { cliBinaryName } from "../../platform/os.js";
import { which } from "../../platform/install.js";

import { REPO_PREFIX } from "./paths.js";
import {
  marketplaceAddArgs,
  pluginInstallArgs,
  isUserScope,
} from "./plugins.js";

/** Strip the "claude/files/" repo prefix; returns the tool-home-relative POSIX path. */
function stripPrefix(repoPath: string): string {
  const prefix = `${REPO_PREFIX}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
}

/** Absolute target path on this machine for a captured file/symlink. */
function targetFor(toolHome: string, repoPath: string): string {
  const rel = stripPrefix(repoPath);
  return path.join(toolHome, ...rel.split("/"));
}

/** True if `claude` CLI is on PATH. */
async function claudeAvailable(): Promise<boolean> {
  return which(cliBinaryName("claude"));
}

/**
 * Write one CapturedFile to disk, honoring sourceOfTruth + mode + binary flag.
 * Returns true if written, false if skipped.
 */
async function writeOne(
  ctx: RestoreContext,
  file: CapturedFile,
): Promise<boolean> {
  const dest = targetFor(ctx.toolHome, file.repoPath);

  if (ctx.sourceOfTruth === "local" && (await ctx.fs.exists(dest))) {
    ctx.log.debug(`claude: keep local (sourceOfTruth=local) ${dest}`);
    return false;
  }

  if (file.binary) {
    await ctx.fs.writeBytes(dest, Buffer.from(file.content, "base64"), file.mode);
  } else {
    const hydrated = ctx.templater.fromTemplate(file.content, ctx.vars);
    await ctx.fs.write(dest, hydrated, file.mode);
  }
  return true;
}

/**
 * Merge manifest.enabledPlugins into the restored settings.json on disk. The
 * frozen settings.json was just written; we re-read it, overlay the enabled map
 * (authoritative re-enable source), and write it back. No-op if settings.json
 * is absent or unparseable.
 */
async function mergeEnabledPlugins(
  ctx: RestoreContext,
  enabled: Record<string, boolean>,
): Promise<void> {
  if (Object.keys(enabled).length === 0) return;
  const settingsPath = path.join(ctx.toolHome, "settings.json");
  if (!(await ctx.fs.exists(settingsPath))) return;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(await ctx.fs.read(settingsPath)) as Record<string, unknown>;
  } catch (err) {
    ctx.log.warn(`claude: could not merge enabledPlugins: ${(err as Error).message}`);
    return;
  }

  const existing =
    typeof obj.enabledPlugins === "object" && obj.enabledPlugins !== null
      ? (obj.enabledPlugins as Record<string, boolean>)
      : {};
  obj.enabledPlugins = { ...existing, ...enabled };

  await ctx.fs.write(settingsPath, JSON.stringify(obj, null, 2) + "\n");
  ctx.log.debug(`claude: merged ${Object.keys(enabled).length} enabledPlugins entries`);
}

/**
 * Build the list of restore actions WITHOUT executing them (for --dry-run).
 */
export async function planActions(
  ctx: RestoreContext,
  data: RestoreData,
): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];

  for (const file of data.files) {
    const dest = targetFor(ctx.toolHome, file.repoPath);
    const overwrites = await ctx.fs.exists(dest);
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-file",
      tool: "claude",
      targetPath: dest,
      description: `Write ${stripPrefix(file.repoPath)}`,
      overwrites,
    });
  }

  for (const link of data.symlinks) {
    const dest = targetFor(ctx.toolHome, link.repoPath);
    const overwrites = (await ctx.fs.statKind(dest)) !== "missing";
    actions.push({
      type: "write-symlink",
      tool: "claude",
      targetPath: dest,
      description: `Symlink ${stripPrefix(link.repoPath)} -> ${link.target}`,
      overwrites,
    });
  }

  for (const m of data.manifest.marketplaces) {
    actions.push({
      type: "add-marketplace",
      tool: "claude",
      description: `claude plugin marketplace add ${m.source}`,
    });
  }

  for (const plugin of data.manifest.plugins) {
    if (!isUserScope(plugin)) continue;
    actions.push({
      type: "install-plugin",
      tool: "claude",
      description: `claude plugin install ${plugin.id} --scope user`,
    });
  }

  const enabledIds = Object.keys(data.manifest.enabledPlugins);
  if (enabledIds.length > 0) {
    actions.push({
      type: "enable-plugin",
      tool: "claude",
      targetPath: path.join(ctx.toolHome, "settings.json"),
      description: `Re-enable ${enabledIds.length} plugin(s) in settings.json`,
    });
  }

  for (const skill of data.manifest.skills) {
    if (skill.source !== "skills.sh") continue;
    actions.push({
      type: "install-skill",
      tool: "claude",
      description: skill.installCommand ?? `npx skills add ${skill.name}`,
    });
  }

  return actions;
}

/**
 * Execute the restore. Honors ctx.dryRun (delegates to planActions + logs,
 * performs no mutations).
 */
export async function restore(ctx: RestoreContext, data: RestoreData): Promise<void> {
  if (ctx.dryRun) {
    const actions = await planActions(ctx, data);
    for (const a of actions) ctx.log.step(a.description);
    return;
  }

  // ----- 1. Frozen files -----
  let written = 0;
  for (const file of data.files) {
    if (await writeOne(ctx, file)) written++;
  }
  ctx.log.debug(`claude: wrote ${written}/${data.files.length} files`);

  // ----- 2. Symlinks -----
  for (const link of data.symlinks) {
    const dest = targetFor(ctx.toolHome, link.repoPath);
    if (ctx.sourceOfTruth === "local" && (await ctx.fs.statKind(dest)) !== "missing") {
      ctx.log.debug(`claude: keep local symlink ${dest}`);
      continue;
    }
    try {
      await ctx.fs.symlink(link.target, dest);
    } catch (err) {
      ctx.log.warn(`claude: could not create symlink ${dest}: ${(err as Error).message}`);
    }
  }

  // ----- 3. Marketplaces + plugins via the claude CLI -----
  const hasClaude = await claudeAvailable();
  if (!hasClaude) {
    ctx.log.warn(
      "claude CLI not found on PATH; skipping marketplace/plugin reinstall. " +
        "Install Claude Code and re-run `arbella restore`.",
    );
  } else {
    for (const m of data.manifest.marketplaces) {
      const args = marketplaceAddArgs(m);
      try {
        await execa("claude", args, { reject: false });
        ctx.log.step(`marketplace add ${m.source}`);
      } catch (err) {
        ctx.log.warn(`claude: marketplace add ${m.source} failed: ${(err as Error).message}`);
      }
    }

    for (const plugin of data.manifest.plugins) {
      if (!isUserScope(plugin)) continue;
      const args = pluginInstallArgs(plugin);
      try {
        await execa("claude", args, { reject: false });
        ctx.log.step(`plugin install ${plugin.id}`);
      } catch (err) {
        ctx.log.warn(`claude: plugin install ${plugin.id} failed: ${(err as Error).message}`);
      }
    }
  }

  // ----- 4. Re-enable plugins (authoritative: settings.enabledPlugins) -----
  await mergeEnabledPlugins(ctx, data.manifest.enabledPlugins);

  // ----- 5. skills.sh skills (repopulate ~/.agents/skills) -----
  for (const skill of data.manifest.skills) {
    if (skill.source !== "skills.sh") continue;
    try {
      await execa("npx", ["--yes", "skills", "add", skill.name], { reject: false });
      ctx.log.step(`skills add ${skill.name}`);
    } catch (err) {
      ctx.log.warn(`claude: skills add ${skill.name} failed: ${(err as Error).message}`);
    }
  }

  // NOTE: npm globals are NOT installed here. Both adapters capture the SAME full
  // machine list (listNpmGlobals), so the restore command owns a single shared
  // npm-globals pass that dedupes across every restored tool and installs each
  // package exactly once (avoiding the double-install when claude + codex are both
  // restored, and ensuring a codex-only restore still installs them). See
  // src/commands/restore.ts (installSharedNpmGlobals).
}

export default restore;
