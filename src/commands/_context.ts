/**
 * Shared command-layer context factories.
 *
 * Commands are thin: they parse flags, assemble the injected `CoreServices`
 * bundle (plus the capture/restore extensions), and delegate to core/adapters.
 * This module is the ONE place that wires the concrete singletons
 * (`fs`, `log`, `sanitizer`, `templater`) together with the per-machine
 * variable map + detected OS, so every command builds contexts identically.
 *
 * Per BUILD_CONTRACT §5.17 the agreed shape is `buildCoreServices(toolHome)`;
 * we also provide `buildCaptureContext` / `buildRestoreContext` so the
 * backup/restore/status commands don't each hand-roll the extra fields.
 *
 * No system clock here — timestamps are owned by the command entrypoints and
 * passed inward (BUILD_CONTRACT §0.5). This file is pure wiring.
 */

import { confirm, isCancel, password } from "@clack/prompts";

import type {
  CaptureContext,
  CoreServices,
  RestoreContext,
} from "../adapters/adapter.interface.js";
import type { SourceOfTruth } from "../types.js";
import { detectOS } from "../platform/os.js";
import { install, type DependencyId, type InstallOutcome } from "../platform/install.js";
import { sanitizer } from "../core/sanitizer/index.js";
import { templater } from "../core/templater/index.js";
import { buildVariables } from "../core/templater/variables.js";
import type {
  CliInstaller,
  ProviderCli,
  TokenPaster,
} from "../core/auth/index.js";
import type { RepoAuthHooks } from "../core/repo/index.js";
import { fs } from "../utils/fs.js";
import { log } from "../utils/log.js";

/**
 * Assemble the core service bundle injected into every adapter call.
 *
 * `toolHome` is folded into the template variable map so that machine paths
 * under that tool's home collapse to `{{TOOL_HOME}}` (more specific than
 * `{{HOME}}`) on capture and expand back on restore. Pass the absolute tool
 * home of the tool currently being processed.
 */
export function buildCoreServices(toolHome: string): CoreServices {
  return {
    fs,
    log,
    sanitizer,
    templater,
    vars: buildVariables(toolHome),
    os: detectOS(),
  };
}

/** Extra inputs the capture side needs beyond CoreServices. */
export interface CaptureContextInput {
  toolHome: string;
  includeSecrets: boolean;
  includeMemories: boolean;
  dryRun: boolean;
}

/** Build a full CaptureContext for an adapter's `capture()` call. */
export function buildCaptureContext(input: CaptureContextInput): CaptureContext {
  return {
    ...buildCoreServices(input.toolHome),
    toolHome: input.toolHome,
    includeSecrets: input.includeSecrets,
    includeMemories: input.includeMemories,
    dryRun: input.dryRun,
  };
}

/** Extra inputs the restore side needs beyond CoreServices. */
export interface RestoreContextInput {
  toolHome: string;
  repoToolDir: string;
  repoRoot: string;
  sourceOfTruth: SourceOfTruth;
  dryRun: boolean;
}

/** Build a full RestoreContext for an adapter's `restore()` call. */
export function buildRestoreContext(input: RestoreContextInput): RestoreContext {
  return {
    ...buildCoreServices(input.toolHome),
    toolHome: input.toolHome,
    repoToolDir: input.repoToolDir,
    repoRoot: input.repoRoot,
    sourceOfTruth: input.sourceOfTruth,
    dryRun: input.dryRun,
  };
}

/* -------------------------------------------------------------------------- */
/* Repo-auth hooks (gh/glab-first, device-flow/token fallback)                 */
/* -------------------------------------------------------------------------- */

/**
 * The @clack token-paste prompt the auth core uses when it falls back to a PAT.
 * Masked input; points at the provider's token page; returns the trimmed token
 * or null on cancel/empty. Defined once here so init/backup/restore share it.
 */
const tokenPaster: TokenPaster = async ({ provider, host, hint }) => {
  log.info(`Paste a Personal Access Token for ${host}.`);
  if (provider.patHelpUrl) log.step(`Create one here: ${provider.patHelpUrl}`);
  log.step(hint);
  const value = await password({
    message: `${provider.displayName} token (input hidden):`,
    validate: (v) =>
      v && v.trim() !== "" ? undefined : "Enter a token, or Esc to cancel.",
  });
  if (isCancel(value)) return null;
  const token = String(value).trim();
  return token === "" ? null : token;
};

/**
 * The install-on-demand seam the auth core uses when a preferred provider CLI
 * (gh/glab) is missing: confirm, then install via the platform layer.
 */
const cliInstaller: CliInstaller = {
  async confirm({ cli, host }: { cli: ProviderCli; host: string }): Promise<boolean> {
    const answer = await confirm({
      message:
        `${cli.label} is not installed. It is the easiest way to sign in to ` +
        `${host} (it handles the login for you). Install it now?`,
      initialValue: true,
    });
    if (isCancel(answer)) return false;
    return answer === true;
  },
  async install(dependency: DependencyId): Promise<InstallOutcome> {
    return install(dependency);
  },
};

/**
 * Build the {@link RepoAuthHooks} passed into the repo layer's clone/pull/push so
 * a private backup repo can trigger a gh/glab login (installing the CLI on demand)
 * or arbella's device-flow/token fallback — without the repo/auth core importing
 * any UI deps. `createdAt` is the command's clock value (for any stored token);
 * `interactive` defaults to true. Pass `interactive:false` (e.g. `backup --auto`)
 * to forbid prompts so a background run never blocks on stdin.
 */
export function buildRepoAuthHooks(args: {
  createdAt: string;
  interactive?: boolean;
}): RepoAuthHooks {
  return {
    interactive: args.interactive ?? true,
    paste: tokenPaster,
    installer: cliInstaller,
    createdAt: args.createdAt,
  };
}
