/**
 * Shared domain types for arbella.
 *
 * This file is the single source of truth for the vocabulary used across every
 * module: adapters, core services, and commands all import from here. Keep it
 * dependency-free (no imports) so it can be consumed anywhere without cycles.
 *
 * NOTE: zod-derived types (config + manifest schemas) live next to their schemas
 * in src/core/config/schema.ts and src/core/manifest/schema.ts and are re-exported
 * from here for convenience. This file owns the hand-written structural types.
 */

import type { z } from "zod";

// Type-only import (erased at runtime, so it introduces no module cycle) so the
// schema-owned ToolManifest can be referenced in the hand-written structural
// types below. It is also re-exported for convenience at the bottom of the file.
import type { ToolManifest } from "./core/manifest/schema.js";

/* -------------------------------------------------------------------------- */
/* Tools & OS                                                                  */
/* -------------------------------------------------------------------------- */

/** The AI coding tools arbella knows how to back up / restore. */
export type ToolId = "claude" | "codex" | "cursor";

/** All known tool ids, in canonical processing order. */
export const TOOL_IDS: readonly ToolId[] = ["claude", "codex", "cursor"] as const;

/** node:os style platform identifiers arbella supports. */
export type OS = "darwin" | "linux" | "win32";

/* -------------------------------------------------------------------------- */
/* Captured files (the "frozen" half of hybrid capture)                        */
/* -------------------------------------------------------------------------- */

/**
 * A single file captured from the local machine to be written into the backup
 * repo. `content` is already sanitized + templated (placeholders substituted)
 * by the time it lives here.
 */
export interface CapturedFile {
  /**
   * Path RELATIVE to the backup repo root, using POSIX separators ("/").
   * e.g. "claude/files/settings.json", "shared/instructions.md".
   * Adapters MUST NOT include absolute machine paths here.
   */
  repoPath: string;
  /** UTF-8 text content of the file (post-sanitize, post-template). */
  content: string;
  /**
   * Optional POSIX file mode (e.g. 0o755 for executable hooks). When omitted,
   * the writer uses the default for a regular file (0o644).
   */
  mode?: number;
  /**
   * True when `content` is base64-encoded binary rather than UTF-8 text.
   * Defaults to false. Used for the rare binary asset (e.g. an image in a skill).
   */
  binary?: boolean;
}

/**
 * A symlink that existed on the source machine and should be re-created on
 * restore (e.g. ~/.claude/skills/<name> -> ../../.agents/skills/<name>).
 * Captured separately from CapturedFile because the link itself is the data.
 */
export interface CapturedSymlink {
  /** Link path relative to the backup repo's notion of the tool home. */
  repoPath: string;
  /** Raw link target as read from disk (kept relative when it was relative). */
  target: string;
}

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A reference to a secret that was detected and intentionally EXCLUDED (or, when
 * includeSecrets is on, redacted/templated) during capture. This is metadata
 * ONLY — the secret VALUE is never stored on a SecretRef. It exists so the user
 * can be told "you'll need to re-supply X" after a restore, and so `secrets
 * export` knows what to bundle.
 */
export interface SecretRef {
  /** Owning tool. */
  tool: ToolId;
  /**
   * Where the secret lives on disk, relative to the tool home (e.g.
   * ".credentials.json", "auth.json", "config.toml#mcp_servers.foo.env.API_KEY").
   */
  source: string;
  /** Logical key/name of the secret (e.g. "ANTHROPIC_API_KEY", "auth.json"). */
  key: string;
  /** Human-readable description shown to the user. */
  description: string;
  /**
   * Kind of secret artifact:
   *  - "file": an entire file is secret (excluded wholesale, e.g. auth.json)
   *  - "value": a single value inside an otherwise-safe file (redacted in place)
   */
  kind: "file" | "value";
}

/* -------------------------------------------------------------------------- */
/* Manifests (the "reinstall" half of hybrid capture)                          */
/* -------------------------------------------------------------------------- */
/* The authoritative zod schemas + inferred types live in                      */
/* src/core/manifest/schema.ts. They are re-exported at the bottom of this      */
/* file so callers can `import type { ToolManifest } from "../types.js"`.       */

/* -------------------------------------------------------------------------- */
/* Capture / Restore results                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The full result of capturing one tool. Returned by Adapter.capture().
 * The backup command aggregates these across tools, writes files + manifests to
 * the repo working tree, then commits + pushes.
 */
export interface CaptureResult {
  /** Which tool produced this result. */
  tool: ToolId;
  /** Frozen files to write into the repo (already sanitized + templated). */
  files: CapturedFile[];
  /** Symlinks to recreate on restore. */
  symlinks: CapturedSymlink[];
  /** Reinstall manifest for registry-style state (plugins, skills, npm globals). */
  manifest: ToolManifest;
  /** Secrets that were found (excluded or redacted). Metadata only. */
  secrets: SecretRef[];
  /** Non-fatal problems worth surfacing to the user (missing files, skips). */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Restore planning                                                            */
/* -------------------------------------------------------------------------- */

/** A single intended filesystem action computed during restore planning. */
export interface RestoreAction {
  /** What kind of action. */
  type:
    | "write-file"
    | "write-symlink"
    | "install-cli"
    | "install-plugin"
    | "add-marketplace"
    | "install-skill"
    | "install-npm-global"
    | "enable-plugin"
    | "run-command";
  /** Owning tool, or "system" for cross-cutting actions (CLI/npm installs). */
  tool: ToolId | "system";
  /** Absolute destination path on the target machine, when applicable. */
  targetPath?: string;
  /** Short human-readable description of the action (used in --dry-run output). */
  description: string;
  /**
   * True when this action would overwrite existing content on the target
   * machine. Drives the safety backup + dry-run reporting.
   */
  overwrites?: boolean;
}

/**
 * The full plan for restoring everything. Built by the restore command from the
 * repo contents + manifests BEFORE any mutation, so --dry-run can print it and
 * the safety backup (R14) can be sized correctly.
 */
export interface RestorePlan {
  /** Tools that will be restored (intersection of repo contents + config.tools). */
  tools: ToolId[];
  /** Ordered actions to perform. */
  actions: RestoreAction[];
  /** CLIs that are missing on this machine and will be auto-installed (R6). */
  missingClis: ToolId[];
  /** Whether a pre-restore safety backup of existing homes will be taken (R14). */
  willBackupExisting: boolean;
}

/* -------------------------------------------------------------------------- */
/* Sanitizer / Templater results                                               */
/* -------------------------------------------------------------------------- */

/** Outcome of sanitizing a single file's text content. */
export interface SanitizeResult {
  /** The cleaned content (secret values replaced with REDACTED markers). */
  content: string;
  /** Secrets found while sanitizing (value-kind), for reporting. */
  found: SecretRef[];
  /** True if any redaction happened. */
  changed: boolean;
}

/**
 * The variable map used by the templater to convert machine values <-> {{TOKENS}}.
 * Keys are placeholder names WITHOUT braces (e.g. "HOME", "USER", "OS").
 */
export interface TemplateVariables {
  HOME: string;
  USER: string;
  OS: OS;
  /** Absolute path to the tool home being processed (e.g. ~/.claude). Optional. */
  TOOL_HOME?: string;
  /** Allow forward-compatible extra variables without widening everywhere. */
  [key: string]: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Core services injected into adapters                                         */
/* -------------------------------------------------------------------------- */

/**
 * Direction of capture vs. restore (R12). "local" means the machine is the
 * source of truth and backup pushes; "repo" means the repo wins and restore
 * overwrites local. Mirrors config.sourceOfTruth.
 */
export type SourceOfTruth = "local" | "repo";

/** Auto-backup cadence (R4). */
export type AutoBackupMode = "off" | "session-start" | "daily";

/** Repo provider (R11). */
export type RepoProvider = "github" | "gitlab" | "generic";

/**
 * The logger contract (implemented by src/utils/log.ts). Adapters receive this
 * so all output is consistent and testable.
 */
export interface Logger {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** A numbered/indented sub-step line. */
  step(msg: string): void;
  /** Verbose-only line (suppressed unless --verbose). */
  debug(msg: string): void;
}

/**
 * Minimal filesystem surface adapters are allowed to use (implemented by
 * src/utils/fs.ts). Keeping this narrow makes adapters trivially unit-testable
 * against a temp dir and prevents direct node:fs sprawl.
 */
export interface FsService {
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Buffer>;
  write(path: string, content: string, mode?: number): Promise<void>;
  writeBytes(path: string, content: Buffer, mode?: number): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Recursive remove (rm -rf). No-op if path is absent. */
  rmrf(path: string): Promise<void>;
  /** List immediate entries (names only). Returns [] if dir is absent. */
  list(path: string): Promise<string[]>;
  /** True if path is a symlink. */
  isSymlink(path: string): Promise<boolean>;
  /** Read a symlink's raw target. */
  readLink(path: string): Promise<string>;
  /** Create a symlink (target -> linkPath). */
  symlink(target: string, linkPath: string): Promise<void>;
  /** Stat helper: classify a path. Returns "missing" when absent. */
  statKind(path: string): Promise<"file" | "dir" | "symlink" | "missing">;
}

/**
 * The sanitizer service contract (implemented by src/core/sanitizer/index.ts).
 */
export interface SanitizerService {
  /** True if a path (relative to tool home) must be excluded wholesale. */
  isDenied(relativePath: string): boolean;
  /** Redact secret VALUES inside text content (pattern-based, free text). */
  sanitizeText(content: string, tool: ToolId, source: string): SanitizeResult;
  /** Redact secrets inside a parsed JSON object, returning a cleaned clone. */
  sanitizeJson(obj: unknown, tool: ToolId, source: string): { value: unknown; found: SecretRef[] };
  /**
   * The production capture path for stored file content. When `source` is a JSON
   * file (settings.json, settings.local.json, mcp.json, ...) and it parses, the
   * STRUCTURAL, key-name-aware sanitizer (sanitizeJson) runs and the redacted
   * object is re-serialized — so an opaque secret stored under a secret KEY NAME
   * (whose value matches no token pattern) is still redacted before it is written
   * to the repo. Non-JSON content (and JSON that fails to parse) falls back to the
   * pattern-based sanitizeText.
   */
  sanitizeFile(content: string, tool: ToolId, source: string): SanitizeResult;
}

/**
 * The templater service contract (implemented by src/core/templater/index.ts).
 */
export interface TemplaterService {
  /** Replace machine values with {{TOKENS}} for storage in the repo. */
  toTemplate(content: string, vars: TemplateVariables): string;
  /** Replace {{TOKENS}} with this machine's values on restore. */
  fromTemplate(content: string, vars: TemplateVariables): string;
}

/* -------------------------------------------------------------------------- */
/* Adapter execution contexts                                                  */
/* -------------------------------------------------------------------------- */
/* The Adapter interface itself lives in                                        */
/* src/adapters/adapter.interface.ts. The context shapes live there too and are */
/* NOT duplicated here to avoid a second source of truth. Import them from      */
/* "./adapters/adapter.interface.js".                                           */

/* -------------------------------------------------------------------------- */
/* Re-exports of schema-derived types (config + manifest)                       */
/* -------------------------------------------------------------------------- */
/* These come from the zod schemas. We import the TYPES only (no runtime), so    */
/* there is exactly one definition of each and no circular runtime dependency.  */

export type { ArbellaConfig } from "./core/config/schema.js";
export type {
  ToolManifest,
  PluginEntry,
  MarketplaceEntry,
  SkillEntry,
  NpmGlobalEntry,
  ArbellaMeta,
} from "./core/manifest/schema.js";

/**
 * Helper alias: a zod-validated value. Used in signatures where a module accepts
 * "anything that the schema parses to" without importing zod everywhere.
 */
export type Infer<T extends z.ZodTypeAny> = z.infer<T>;
