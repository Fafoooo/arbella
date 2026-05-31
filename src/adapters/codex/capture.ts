/**
 * Codex capture: produce a CaptureResult from ~/.codex.
 *
 * Mirrors the Claude adapter's capture but for Codex specifics:
 *   - config.toml is routed through processConfigToml() (sanitize secrets, drop
 *     [hooks.state.*], template paths, extract plugins/marketplaces);
 *   - the rest of FROZEN_PATHS is walked recursively and frozen file-by-file;
 *   - AGENTS.md is skipped when opts.skipInstructions is set (R9 shared);
 *   - memories/ is gated on ctx.includeMemories;
 *   - skills are classified: a relative symlink into ~/.agents/skills becomes a
 *     reinstallable SkillEntry (source:"skills.sh") + a CapturedSymlink; a real
 *     directory is frozen file-by-file + recorded as SkillEntry (source:"frozen");
 *   - denylisted-but-present secret files (auth.json, ...) yield a SecretRef.
 *
 * Security: every file path is checked against the per-tool denylist before it is
 * read; text files are sanitized (secret values redacted) then templated (machine
 * paths -> {{TOKENS}}). Binary files are stored base64 without templating. Hook
 * scripts keep their executable mode.
 */

import path from "node:path";

import type { CaptureContext } from "../adapter.interface.js";
import type {
  CaptureResult,
  CapturedFile,
  CapturedSymlink,
  NpmGlobalEntry,
  SecretRef,
  SkillEntry,
  ToolManifest,
} from "../../types.js";
import { denylistFor, matchesDeny } from "../../core/sanitizer/denylist.js";
import { listNpmGlobals } from "../../platform/install.js";
import { normalizeCapturedSymlinkTarget } from "../../utils/symlink.js";
import {
  CONFIG_FILE,
  FROZEN_PATHS,
  INSTRUCTIONS_FILE,
  MEMORIES_DIR,
  REPO_PREFIX,
  paths as codexPaths,
} from "./paths.js";
import { processConfigToml } from "./configToml.js";

/** The Codex per-tool denylist, computed once per capture. */
const DENY = denylistFor("codex");

/** Convert a tool-home-relative POSIX path into its repo path. */
function repoPathFor(rel: string): string {
  // rel is already POSIX (we build it with "/" joins); prefix with codex/files.
  return `${REPO_PREFIX}/${rel}`;
}

/** Heuristic for "is this content safe to treat as UTF-8 text?". */
function isProbablyBinary(bytes: Buffer): boolean {
  // A NUL byte is the strongest signal of binary content. Also bail if a large
  // fraction of the first chunk is non-printable / non-whitespace.
  const sample = bytes.subarray(0, 8000);
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const b of sample) {
    // Allow tab(9), LF(10), CR(13), and the printable ASCII range; treat the
    // rest (including most control chars) as suspicious. High bytes (>=128) are
    // common in UTF-8 text, so they are NOT counted as suspicious here.
    if (b === 9 || b === 10 || b === 13) continue;
    if (b >= 32 && b < 127) continue;
    if (b >= 128) continue;
    suspicious++;
  }
  return suspicious / Math.max(1, sample.length) > 0.3;
}

/**
 * Recursively collect frozen files (and symlinks) under an absolute dir,
 * appending CapturedFile/CapturedSymlink/SecretRef as appropriate. `relBase` is
 * the POSIX path of `absPath` relative to the tool home.
 */
async function walkDir(
  ctx: CaptureContext,
  absPath: string,
  relBase: string,
  out: {
    files: CapturedFile[];
    symlinks: CapturedSymlink[];
    secrets: SecretRef[];
    warnings: string[];
  },
): Promise<void> {
  const entries = await ctx.fs.list(absPath);
  for (const name of entries) {
    const childAbs = path.join(absPath, name);
    const childRel = relBase ? `${relBase}/${name}` : name;

    // Denylist check first — never even read excluded paths.
    if (matchesDeny(childRel, DENY)) {
      // Surface known wholesale-secret files as SecretRefs so the user is told.
      maybeRecordSecretFile(childRel, out.secrets);
      continue;
    }

    const kind = await ctx.fs.statKind(childAbs);
    if (kind === "symlink") {
      await captureSymlink(ctx, childAbs, childRel, out);
    } else if (kind === "dir") {
      await walkDir(ctx, childAbs, childRel, out);
    } else if (kind === "file") {
      await captureFile(ctx, childAbs, childRel, out);
    }
    // "missing" (race) -> skip silently.
  }
}

/** Capture a single regular file at absPath (rel is tool-home-relative POSIX). */
async function captureFile(
  ctx: CaptureContext,
  absPath: string,
  rel: string,
  out: { files: CapturedFile[]; secrets: SecretRef[]; warnings: string[] },
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await ctx.fs.readBytes(absPath);
  } catch {
    out.warnings.push(`codex: could not read ${rel}; skipped`);
    return;
  }

  const mode = await fileMode(absPath);

  if (isProbablyBinary(bytes)) {
    out.files.push({
      repoPath: repoPathFor(rel),
      content: bytes.toString("base64"),
      binary: true,
      ...(mode !== undefined ? { mode } : {}),
    });
    return;
  }

  const text = bytes.toString("utf8");
  // sanitizeFile routes any JSON file through the STRUCTURAL key-name-aware
  // sanitizer; non-JSON (hooks/*.sh|*.py, AGENTS.md, prompts) falls back to the
  // text pass. config.toml is handled separately via processConfigToml().
  //
  // ctx.includeSecrets (opt-in, default OFF) carries inline secret VALUES into the
  // PRIVATE repo: when ON we skip value redaction here (whole-file secrets like
  // auth.json remain denylisted regardless).
  let sanitized = text;
  if (!ctx.includeSecrets) {
    const res = ctx.sanitizer.sanitizeFile(text, "codex", rel);
    sanitized = res.content;
    for (const ref of res.found) out.secrets.push(ref);
  }
  const templated = ctx.templater.toTemplate(sanitized, ctx.vars);

  out.files.push({
    repoPath: repoPathFor(rel),
    content: templated,
    ...(mode !== undefined ? { mode } : {}),
  });
}

/**
 * Capture a symlink. Codex skills MAY be relative symlinks into ~/.agents/skills
 * (the skills.sh mechanism). For a skills/<name> symlink we record a reinstallable
 * SkillEntry as well, but the symlink is recreated on restore regardless.
 */
async function captureSymlink(
  ctx: CaptureContext,
  absPath: string,
  rel: string,
  out: { symlinks: CapturedSymlink[]; warnings: string[] },
): Promise<void> {
  let target: string;
  try {
    target = normalizeCapturedSymlinkTarget(await ctx.fs.readLink(absPath));
  } catch {
    out.warnings.push(`codex: could not read symlink ${rel}; skipped`);
    return;
  }
  out.symlinks.push({ repoPath: repoPathFor(rel), target });
}

/**
 * Best-effort file mode. We only care about preserving the executable bit for
 * hook scripts; everything else uses the writer default. Returns undefined when
 * the mode is the ordinary 0o644 so the manifest/diff stays clean.
 */
async function fileMode(absPath: string): Promise<number | undefined> {
  // FsService has no stat-mode accessor; infer "executable" by reading bytes is
  // wrong. Instead we use node:fs lstat via a tiny dynamic import kept local so
  // adapters still funnel I/O through ctx for reads/writes. This is the single
  // exception (mode is not exposed on FsService).
  try {
    const { promises: fsp } = await import("node:fs");
    const st = await fsp.lstat(absPath);
    const perm = st.mode & 0o777;
    // Preserve only when an execute bit is set (hooks/, scripts).
    if (perm & 0o111) return perm;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Build skill entries by scanning ~/.codex/skills for symlinks vs real dirs. */
async function captureSkills(
  ctx: CaptureContext,
  skillsDir: string,
  skills: SkillEntry[],
): Promise<void> {
  const names = await ctx.fs.list(skillsDir);
  for (const name of names) {
    const childRel = `skills/${name}`;
    if (matchesDeny(childRel, DENY)) continue; // e.g. .DS_Store
    const childAbs = path.join(skillsDir, name);
    const kind = await ctx.fs.statKind(childAbs);
    if (kind === "symlink") {
      // Reinstallable skills.sh skill (symlink into ~/.agents/skills).
      skills.push({
        name,
        source: "skills.sh",
        installCommand: `npx skills add ${name}`,
        symlinked: true,
      });
    } else if (kind === "dir") {
      // Real, hand-made / system skill directory -> frozen (files captured by the
      // generic walk); record for visibility.
      skills.push({ name, source: "frozen", symlinked: false });
    }
    // files / missing -> ignore (skills are dirs or symlinks).
  }
}

/** Record a SecretRef for known wholesale-secret files that were excluded. */
function maybeRecordSecretFile(rel: string, secrets: SecretRef[]): void {
  const base = rel.split("/").pop() ?? rel;
  if (base === "auth.json") {
    secrets.push({
      tool: "codex",
      source: rel,
      key: "auth.json",
      description: "Codex auth token file (excluded; re-login required after restore).",
      kind: "file",
    });
  }
}

/** Gather npm globals for the manifest (shared helper; never fabricated). */
async function collectNpmGlobals(): Promise<NpmGlobalEntry[]> {
  try {
    const pkgs = await listNpmGlobals();
    return pkgs.map((p) => (p.version !== undefined ? { package: p.package, version: p.version } : { package: p.package }));
  } catch {
    return [];
  }
}

/**
 * Capture the Codex setup into a CaptureResult.
 *
 * @param opts.skipInstructions when true (R9 shared), do NOT emit AGENTS.md as a
 *        frozen file (the shared instructions file covers it).
 */
export async function capture(
  ctx: CaptureContext,
  opts?: { skipInstructions?: boolean },
): Promise<CaptureResult> {
  const skipInstructions = opts?.skipInstructions === true;
  const p = codexPaths(ctx.toolHome);

  const files: CapturedFile[] = [];
  const symlinks: CapturedSymlink[] = [];
  const secrets: SecretRef[] = [];
  const warnings: string[] = [];
  const skills: SkillEntry[] = [];

  const manifest: ToolManifest = {
    tool: "codex",
    plugins: [],
    marketplaces: [],
    skills,
    npmGlobals: [],
    enabledPlugins: {},
  };

  const out = { files, symlinks, secrets, warnings };

  // Build the list of frozen entries; add memories only when opted in.
  const frozen = [...FROZEN_PATHS];
  if (ctx.includeMemories) frozen.push(MEMORIES_DIR);

  for (const rel of frozen) {
    // 1) config.toml -> processConfigToml (sanitize + template + extract).
    if (rel === CONFIG_FILE) {
      await captureConfigToml(ctx, p.configToml, manifest, out);
      continue;
    }

    // 2) AGENTS.md -> skip when sharing instructions (R9).
    if (rel === INSTRUCTIONS_FILE) {
      if (skipInstructions) continue;
      const kind = await ctx.fs.statKind(p.agentsMd);
      if (kind === "file") {
        await captureFile(ctx, p.agentsMd, INSTRUCTIONS_FILE, out);
      }
      continue;
    }

    // 3) Everything else: stat, then walk dirs / capture files / record skills.
    const abs = path.join(p.home, rel);
    const kind = await ctx.fs.statKind(abs);
    if (kind === "missing") continue;

    if (kind === "file") {
      if (matchesDeny(rel, DENY)) {
        maybeRecordSecretFile(rel, secrets);
        continue;
      }
      await captureFile(ctx, abs, rel, out);
      continue;
    }

    if (kind === "symlink") {
      if (matchesDeny(rel, DENY)) continue;
      await captureSymlink(ctx, abs, rel, out);
      continue;
    }

    // dir
    if (matchesDeny(rel + "/", DENY)) continue;
    await walkDir(ctx, abs, rel, out);
    // Classify skills (symlink vs frozen) after freezing their files.
    if (rel === "skills") {
      await captureSkills(ctx, p.skillsDir, skills);
    }
  }

  // npm globals are workflow-level state shared across adapters.
  manifest.npmGlobals = await collectNpmGlobals();

  return {
    tool: "codex",
    files,
    symlinks,
    manifest,
    secrets,
    warnings,
  };
}

/**
 * Process config.toml: read it, run processConfigToml, and emit the sanitized
 * text as a CapturedFile plus fold the extracted plugins/marketplaces/secrets
 * into the manifest. Tolerates absence and parse failure gracefully.
 */
async function captureConfigToml(
  ctx: CaptureContext,
  configAbs: string,
  manifest: ToolManifest,
  out: { files: CapturedFile[]; secrets: SecretRef[]; warnings: string[] },
): Promise<void> {
  const kind = await ctx.fs.statKind(configAbs);
  if (kind !== "file") return; // no config.toml -> nothing to do.

  let raw: string;
  try {
    raw = await ctx.fs.read(configAbs);
  } catch {
    out.warnings.push("codex: could not read config.toml; skipped");
    return;
  }

  let processed;
  try {
    processed = processConfigToml(raw, ctx.templater, ctx.vars, {
      redactSecrets: !ctx.includeSecrets,
    });
  } catch (err) {
    // Malformed TOML: do NOT ship the raw file (it may contain secrets we failed
    // to strip). Skip it and warn loudly.
    const msg = err instanceof Error ? err.message : String(err);
    out.warnings.push(`codex: config.toml could not be parsed (${msg}); EXCLUDED for safety`);
    return;
  }

  out.files.push({
    repoPath: `${REPO_PREFIX}/${CONFIG_FILE}`,
    content: processed.sanitizedToml,
  });

  manifest.plugins = processed.plugins;
  manifest.marketplaces = processed.marketplaces;
  for (const s of processed.secrets) out.secrets.push(s);

  // Mirror plugin enabled-state into enabledPlugins (authoritative re-enable map).
  for (const plugin of processed.plugins) {
    manifest.enabledPlugins[plugin.id] = plugin.enabled;
  }
}
