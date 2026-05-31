/**
 * The Adapter contract: one adapter per tool (Claude, Codex, Cursor).
 *
 * Adapters own ALL tool-specific knowledge (paths, file layout, settings shape,
 * plugin/marketplace formats). They are tool-AGNOSTIC about *how* things are
 * sanitized, templated, written, or logged — those come in via injected core
 * services on the context objects. This keeps adapters small and unit-testable.
 *
 * Lifecycle:
 *   backup:  registry.detectAll() -> adapter.capture(ctx) -> CaptureResult
 *   restore: registry.forTools()  -> adapter.restore(ctx, data)
 */

import type {
  ToolId,
  OS,
  CaptureResult,
  CapturedFile,
  CapturedSymlink,
  ToolManifest,
  Logger,
  FsService,
  SanitizerService,
  TemplaterService,
  TemplateVariables,
  SourceOfTruth,
  EnvVars,
} from "../types.js";

/* Re-export ToolManifest so consumers can import it from the interface module
 * as the task specifies, without reaching into the schema file. */
export type { ToolManifest } from "../types.js";

/* -------------------------------------------------------------------------- */
/* Shared service bundle                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The core services every adapter receives. Injected so adapters never import
 * concrete implementations (enables fakes in tests).
 */
export interface CoreServices {
  fs: FsService;
  log: Logger;
  sanitizer: SanitizerService;
  templater: TemplaterService;
  /** Variable map for path <-> placeholder conversion on THIS machine. */
  vars: TemplateVariables;
  /** Current OS (from platform/os.ts). */
  os: OS;
  /** Process environment, injected so path logic can respect platform env vars in tests. */
  env: EnvVars;
}

/* -------------------------------------------------------------------------- */
/* Capture context                                                             */
/* -------------------------------------------------------------------------- */

/** Context passed to Adapter.capture(). */
export interface CaptureContext extends CoreServices {
  /**
   * Absolute path to this tool's home dir on the source machine
   * (e.g. ~/.claude, ~/.codex, ~/.cursor). Resolved by the adapter's paths
   * module but passed in so tests can point it at a fixture dir.
   */
  toolHome: string;
  /** Whether to redact-and-keep secrets (true) vs. exclude wholesale (false). */
  includeSecrets: boolean;
  /** Whether to include memories/ (R13). */
  includeMemories: boolean;
  /** When true, compute the result but the caller will not write anything. */
  dryRun: boolean;
}

/* -------------------------------------------------------------------------- */
/* Restore context                                                             */
/* -------------------------------------------------------------------------- */

/** Context passed to Adapter.restore(). */
export interface RestoreContext extends CoreServices {
  /** Absolute path to this tool's home dir on the TARGET machine. */
  toolHome: string;
  /**
   * Absolute path to this tool's subtree inside the cloned backup repo
   * (e.g. <repoRoot>/claude). Adapters read frozen files + manifest from here.
   */
  repoToolDir: string;
  /** Absolute path to the repo root (for cross-tool files like shared/). */
  repoRoot: string;
  /** Direction policy (R12): "repo" => allowed to overwrite local. */
  sourceOfTruth: SourceOfTruth;
  /** When true, plan + report only; perform no filesystem or install actions. */
  dryRun: boolean;
}

/**
 * The data an adapter consumes on restore: the parsed manifest plus the set of
 * frozen files/symlinks already materialized (or to be materialized) from the
 * repo. The restore command loads + validates these and hands them over so the
 * adapter focuses on placement + reinstall, not parsing.
 */
export interface RestoreData {
  manifest: ToolManifest;
  files: CapturedFile[];
  symlinks: CapturedSymlink[];
}

/* -------------------------------------------------------------------------- */
/* The Adapter interface                                                       */
/* -------------------------------------------------------------------------- */

export interface Adapter {
  /** Stable tool id. */
  readonly id: ToolId;

  /** Human-friendly display name (e.g. "Claude Code"). */
  readonly displayName: string;

  /**
   * True if this tool's setup is present on the machine (home dir exists with
   * recognizable content). Used to skip tools the user doesn't have. Graceful:
   * returns false rather than throwing when the dir is absent.
   */
  detect(): Promise<boolean>;

  /** True if the tool's CLI/app is installed (via `command -v` / platform check). */
  isCliInstalled(): Promise<boolean>;

  /**
   * Install the tool's CLI/app for the given OS (R6). No-op semantics if already
   * installed should be handled by the caller checking isCliInstalled() first,
   * but implementations must be safe to call regardless.
   */
  installCli(os: OS): Promise<void>;

  /** Capture this tool's setup into a CaptureResult (frozen files + manifest). */
  capture(ctx: CaptureContext): Promise<CaptureResult>;

  /** Restore this tool's setup from repo data onto the target machine. */
  restore(ctx: RestoreContext, data: RestoreData): Promise<void>;
}
