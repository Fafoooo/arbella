/**
 * Restore for the Claude adapter: materialize the frozen ~/.claude subtree onto
 * the target machine, recreate skill symlinks, reinstall marketplaces + plugins
 * via the `claude` CLI, re-enable plugins by merging enabledPlugins into the
 * restored settings.json, and reinstall skills.sh skills via `npx skills add`.
 *
 * Placement is decided by the repoPath PREFIX:
 *   - "claude/files/…"    -> under ctx.toolHome.
 *   - "claude/memories/…" -> under ctx.toolHome/projects/<slug>/memory (the slug
 *                            is re-derived for THIS machine's $HOME; see
 *                            memories.ts).
 *   - anything else       -> ignored with a debug line. Other repo roots (e.g.
 *                            shared/home/…) belong to other restore steps and
 *                            must NOT be dumped inside ~/.claude.
 *   Content is run through templater.fromTemplate FIRST so {{HOME}}/{{USER}}/...
 *   become this machine's real values, then written (restoring the POSIX mode for
 *   executables). Binary files are base64-decoded.
 *   - Recreate each CapturedSymlink with its verbatim (relative) target.
 *   - `claude plugin marketplace add <source>` for every marketplace, then
 *     `claude plugin install <id> --scope user` for every USER-scope plugin.
 *   - Merge manifest.enabledPlugins into the freshly-written settings.json (the
 *     file Claude actually reads) so disabled plugins stay disabled.
 *   - `npx skills add <name>` for every skills.sh skill (the symlink itself is
 *     recreated above; this repopulates ~/.agents/skills/<name>).
 *   - manifest.mcpServers / projectMcpServers are merged key-wise into
 *     ~/.claude.json (mcp.ts) after the files are written and before plugins.
 *
 * sourceOfTruth (R12): "repo" => overwrite existing local files; "local" =>
 * never clobber a file that already exists locally (skip + debug). All install
 * steps are guarded by `which("claude")` / the npm helper and degrade to a
 * warning when the CLI is missing, rather than throwing.
 *
 * Symlink safety (claude/files/…): a "repo" pull writes THROUGH any existing
 * symlink component under the tool home, since `ctx.fs.write`/`writeBytes` do
 * not re-check the path they were handed. That is exactly the behavior the
 * skills.sh layout needs — `~/.claude/skills/<name>` is meant to be a symlink
 * into the shared skills root `~/.agents/skills/<name>`, and writing the
 * frozen skill through it is how the skill gets updated in place — but it is
 * also how a symlink planted anywhere else under the tool home (e.g.
 * `~/.claude/hooks -> /etc`) could redirect a write outside `~/.claude`. See
 * `claudeFilesSymlinkBlock` below: it allows the write ONLY when the symlink
 * is exactly `<toolHome>/skills/<name>` AND its realpath resolves under the
 * shared skills root (or the tool home's own `skills/` dir); everything else
 * is skipped with a warning, mirroring the existing `memorySymlinkBlock`
 * treatment of `claude/memories/…` paths.
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
import { findSymlinkComponent, isPathUnder } from "../../utils/safe-path.js";

import { REPO_PREFIX } from "./paths.js";
import {
  marketplaceAddArgs,
  pluginInstallArgs,
  isUserScope,
} from "./plugins.js";
import { planMcpMerge, restoreMcpServers } from "./mcp.js";
import { MEMORIES_REPO_PREFIX, memoryTargetPath, slugifyPath } from "./memories.js";

/** Strip the "claude/files/" repo prefix; returns the tool-home-relative POSIX path. */
function stripPrefix(repoPath: string): string {
  const prefix = `${REPO_PREFIX}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
}

/**
 * Absolute target path on this machine for a captured file/symlink, or null when
 * the repoPath belongs to a root this adapter does not own (the caller logs a
 * debug line and skips). Routing is prefix-based — see the module header.
 */
function targetFor(ctx: RestoreContext, repoPath: string): string | null {
  if (repoPath.startsWith(`${REPO_PREFIX}/`)) {
    return path.join(ctx.toolHome, ...stripPrefix(repoPath).split("/"));
  }
  if (repoPath.startsWith(`${MEMORIES_REPO_PREFIX}/`)) {
    return memoryTargetPath(ctx.toolHome, slugifyPath(ctx.vars.HOME), repoPath);
  }
  return null;
}

/**
 * The symlinked component that makes a MEMORY destination unsafe, or null.
 *
 * Memory paths are the one place a repo names a directory this machine may not
 * have: `projects/<slug>/memory/…` is created on demand, so a link planted (or
 * merely configured) at `projects/<slug>` would redirect the write out of
 * ~/.claude entirely. The `claude/files/` tree is deliberately NOT checked —
 * skills there are legitimately symlinks into ~/.agents/skills, and refusing to
 * write through them would break the feature the adapter exists to restore.
 */
async function memorySymlinkBlock(
  ctx: RestoreContext,
  repoPath: string,
  dest: string,
): Promise<string | null> {
  if (!repoPath.startsWith(`${MEMORIES_REPO_PREFIX}/`)) return null;
  return findSymlinkComponent(ctx.fs, ctx.toolHome, dest);
}

/**
 * True when `link` is the legitimate skills.sh symlink for a `claude/files/`
 * destination whose tool-home-relative path is `rel` — i.e. `rel` names a file
 * under `skills/<name>/…`, `link` is exactly `<toolHome>/skills/<name>`, and
 * that link's REAL target (not its raw relative text) resolves under the
 * shared skills root `<toolHome's parent>/.agents/skills` or, as a fallback for
 * a same-machine relocation, under the tool home's own `skills/` dir.
 *
 * Anything else — a link elsewhere under the tool home, or a `skills/<name>`
 * link that resolves somewhere outside those two roots (a planted symlink) —
 * returns false so the caller refuses the write.
 */
async function isSharedSkillsLink(
  ctx: RestoreContext,
  rel: string,
  link: string,
): Promise<boolean> {
  const segments = rel.split("/");
  const name = segments[1];
  if (segments[0] !== "skills" || !name) return false;

  const expectedLink = path.join(ctx.toolHome, "skills", name);
  if (link !== expectedLink) return false;

  const resolved = await ctx.fs.realPath(link);
  const sharedSkillsRoot = path.join(path.dirname(ctx.toolHome), ".agents", "skills");
  const ownSkillsRoot = path.join(ctx.toolHome, "skills");
  return isPathUnder(sharedSkillsRoot, resolved) || isPathUnder(ownSkillsRoot, resolved);
}

/**
 * The symlinked component that makes a `claude/files/…` destination unsafe, or
 * null. See the module header for the policy: any symlink is refused UNLESS it
 * is the shared-skills link this adapter itself is meant to write through.
 */
async function claudeFilesSymlinkBlock(
  ctx: RestoreContext,
  repoPath: string,
  dest: string,
): Promise<string | null> {
  if (!repoPath.startsWith(`${REPO_PREFIX}/`)) return null;
  const link = await findSymlinkComponent(ctx.fs, ctx.toolHome, dest);
  if (link === null) return null;
  if (await isSharedSkillsLink(ctx, stripPrefix(repoPath), link)) return null;
  return link;
}

/** Human label for an action description: the path relative to its repo root. */
function describePath(repoPath: string): string {
  if (repoPath.startsWith(`${REPO_PREFIX}/`)) return stripPrefix(repoPath);
  return repoPath;
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
  const dest = targetFor(ctx, file.repoPath);
  if (dest === null) {
    ctx.log.debug(`claude: ignoring ${file.repoPath} (not a Claude repo root)`);
    return false;
  }

  const isMemory = file.repoPath.startsWith(`${MEMORIES_REPO_PREFIX}/`);

  const memLink = await memorySymlinkBlock(ctx, file.repoPath, dest);
  if (memLink !== null) {
    ctx.log.warn(
      `claude: skipping ${file.repoPath} — ${memLink} is a symlink; ` +
        "arbella does not write memories through links.",
    );
    return false;
  }

  const filesLink = await claudeFilesSymlinkBlock(ctx, file.repoPath, dest);
  if (filesLink !== null) {
    ctx.log.warn(
      `claude: refusing to write ${describePath(file.repoPath)} through symlink ` +
        `${filesLink} (not a shared-skills link)`,
    );
    return false;
  }

  if (ctx.sourceOfTruth === "local" && (await ctx.fs.exists(dest))) {
    ctx.log.debug(`claude: keep local (sourceOfTruth=local) ${dest}`);
    return false;
  }

  // Memories go through the RENAME-based writers: the symlink check above and
  // the write cannot be one operation, and a plain write follows a link that
  // appears in the gap. `rename` replaces the leaf entry instead.
  //
  // The `claude/files/` tree writes straight through (write/writeBytes, not the
  // atomic rename pair): claudeFilesSymlinkBlock above has already vetted the
  // path, and the one link it permits — a skill symlinked into ~/.agents/skills
  // — is deliberately followed, since updating the canonical skill in place is
  // the behavior the adapter exists to restore.
  if (file.binary) {
    const bytes = Buffer.from(file.content, "base64");
    if (isMemory) await ctx.fs.writeBytesAtomic(dest, bytes, file.mode);
    else await ctx.fs.writeBytes(dest, bytes, file.mode);
  } else {
    const hydrated = ctx.templater.fromTemplate(file.content, ctx.vars);
    if (isMemory) await ctx.fs.writeAtomic(dest, hydrated, file.mode);
    else await ctx.fs.write(dest, hydrated, file.mode);
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
    const dest = targetFor(ctx, file.repoPath);
    if (dest === null) continue;
    // Mirror the write-side refusals so the dry run cannot list a file the
    // restore will then skip.
    if ((await memorySymlinkBlock(ctx, file.repoPath, dest)) !== null) continue;
    if ((await claudeFilesSymlinkBlock(ctx, file.repoPath, dest)) !== null) continue;
    const overwrites = await ctx.fs.exists(dest);
    if (ctx.sourceOfTruth === "local" && overwrites) continue;
    actions.push({
      type: "write-file",
      tool: "claude",
      targetPath: dest,
      description: `Write ${describePath(file.repoPath)}`,
      overwrites,
    });
  }

  for (const link of data.symlinks) {
    const dest = targetFor(ctx, link.repoPath);
    if (dest === null) continue;
    const overwrites = (await ctx.fs.statKind(dest)) !== "missing";
    actions.push({
      type: "write-symlink",
      tool: "claude",
      targetPath: dest,
      description: `Symlink ${describePath(link.repoPath)} -> ${link.target}`,
      overwrites,
    });
  }

  // The MCP half of the plan comes from the SAME decision function the merge
  // applies, so a listed registration is one that will really happen.
  actions.push(...(await planMcpMerge(ctx, data.manifest)).actions);

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
    const dest = targetFor(ctx, link.repoPath);
    if (dest === null) {
      ctx.log.debug(`claude: ignoring symlink ${link.repoPath} (not a Claude repo root)`);
      continue;
    }
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

  // ----- 3. MCP servers merged into ~/.claude.json -----
  await restoreMcpServers(ctx, data.manifest);

  // ----- 4. Marketplaces + plugins via the claude CLI -----
  const hasClaude = await claudeAvailable();
  if (!hasClaude) {
    ctx.log.warn(
      "claude CLI not found on PATH; skipping marketplace/plugin reinstall. " +
        "Install Claude Code and re-run `arbella pull`.",
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

  // ----- 5. Re-enable plugins (authoritative: settings.enabledPlugins) -----
  await mergeEnabledPlugins(ctx, data.manifest.enabledPlugins);

  // ----- 6. skills.sh skills (repopulate ~/.agents/skills) -----
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
