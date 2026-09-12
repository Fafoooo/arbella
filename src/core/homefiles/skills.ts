import path from "node:path";

import type { CaptureContext } from "../../adapters/adapter.interface.js";
import type { ToolId } from "../../types.js";
import { findSymlinkComponent } from "../../utils/safe-path.js";
import { normalizeCapturedSymlinkTarget } from "../../utils/symlink.js";
import { captureHomeTree, homeExcludeRoots } from "./capture.js";
import type { HomeCaptureOut } from "./capture.js";

/**
 * A skill directory name is not an install source. Carry the canonical shared
 * contents with the link so a fresh machine can restore it without guessing a
 * repository or losing local edits. Only the known ~/.agents/skills/<name>
 * layout is followed; additional symlinks are never traversed.
 */
export async function captureSharedSkill(
  ctx: CaptureContext,
  tool: ToolId,
  name: string,
  link: string,
  target: string,
  out: HomeCaptureOut,
): Promise<string> {
  const shared = path.join(ctx.vars.HOME, ".agents", "skills", name);
  if (path.resolve(path.dirname(link), target) !== shared) {
    out.warnings.push(`${tool}: skill ${name} links outside ~/.agents/skills/${name}; only the link is backed up. Carry its contents explicitly with extraPaths.`);
    return target;
  }
  const portableTarget = normalizeCapturedSymlinkTarget(path.relative(path.dirname(link), shared));
  if ((await findSymlinkComponent(ctx.fs, ctx.vars.HOME, shared)) !== null ||
      (await ctx.fs.statKind(shared)) !== "dir") {
    out.warnings.push(`${tool}: shared skill ${name} is missing or redirected through a symlink; its contents were not backed up.`);
    return portableTarget;
  }
  await captureHomeTree(ctx, shared, tool, `skill:${name}`, out, {
    excludeRoots: homeExcludeRoots(ctx.toolHome),
  });
  return portableTarget;
}
