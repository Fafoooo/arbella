/**
 * Zod schema + inferred type for the arbella tool config.
 *
 * Location on disk: configDir()/config.json
 *   - macOS/Linux: ~/.config/arbella/config.json
 *   - Windows:     %APPDATA%/arbella/config.json
 * (configDir() is resolved by src/platform/os.ts — never hardcode this.)
 *
 * This config is LOCAL to the machine (it is NOT the backup repo). It records
 * where the backup repo lives, the source-of-truth direction, auto-backup
 * cadence, and which tools/options are in scope.
 */

import { z } from "zod";

const toolIdSchema = z.enum([
  "claude",
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "kilo",
  "antigravity",
]);

/** Repo connection details (R11). */
export const repoConfigSchema = z.object({
  /** Hosting provider. "generic" = any git remote (no auto-create). */
  provider: z.enum(["github", "gitlab", "generic"]),
  /**
   * Remote URL (https or ssh). For github/gitlab this may be derived from a
   * "owner/name" pair during init; stored fully-qualified here.
   */
  url: z.string(),
  /**
   * Absolute path to the local clone/working copy of the backup repo on THIS
   * machine. Defaults under a arbella data dir; resolved at init time.
   */
  localPath: z.string(),
});

/**
 * What this machine does with the backup repo:
 *  - "source":   pushes and pulls (the default; every pre-1.1 config).
 *  - "follower": only pulls. Never pushes, not even via the autobackup hook.
 */
export const roleSchema = z.enum(["source", "follower"]);

export const arbellaConfigSchema = z.object({
  /** Backup repo connection. */
  repo: repoConfigSchema,
  /** This machine's role. LOCAL only: never written to the backup repo. */
  role: roleSchema.default("source"),
  /** Random id of this machine, generated lazily on first push. Never shared. */
  machineId: z.string().min(1).optional(),
  /**
   * The arbella.json `createdAt` this machine last pushed or pulled. LOCAL only:
   * it tells a push whether another machine pushed since this one last synced.
   */
  lastSyncedPush: z.string().optional(),
  /**
   * Source-of-truth direction (R12):
   *  - "local": this machine pushes; backup is authoritative from here.
   *  - "repo":  the repo wins; restore overwrites local on conflict.
   */
  sourceOfTruth: z.enum(["local", "repo"]).default("local"),
  /**
   * Auto-backup cadence (R4), enforced by a throttled SessionStart hook:
   *  - "off":           never auto-backup.
   *  - "session-start": back up on every session start (still throttled to avoid
   *                     hammering on rapid restarts).
   *  - "daily":         back up at most once per 24h.
   */
  autoBackup: z.enum(["off", "session-start", "daily"]).default("off"),
  /** Allow secrets into the (private) repo. Default OFF for safety (R5). */
  includeSecrets: z.boolean().default(false),
  /** Include memories/ in the backup. Opt-in, default OFF (R13). */
  includeMemories: z.boolean().default(false),
  /** Tools to manage. Order is respected during backup/restore. */
  tools: z.array(toolIdSchema).default(["claude", "codex"]),
  /**
   * Extra $HOME-relative paths (files or directories) to carry in `shared/home`,
   * on top of the scripts arbella discovers from the tool configs themselves.
   * "~/x" and "x" both mean "$HOME/x"; an absolute path is accepted as long as it
   * resolves under $HOME. Anything outside $HOME is warned about and skipped.
   */
  extraPaths: z.array(z.string()).default([]),
});

export type Role = z.infer<typeof roleSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type ArbellaConfig = z.infer<typeof arbellaConfigSchema>;

/**
 * The default config used to seed a fresh install before `init` fills in the
 * repo. Exported so config/index.ts and tests share one definition. `repo` is
 * intentionally left as a placeholder that init must overwrite.
 */
export const DEFAULT_CONFIG: ArbellaConfig = {
  repo: { provider: "generic", url: "", localPath: "" },
  role: "source",
  sourceOfTruth: "local",
  autoBackup: "off",
  includeSecrets: false,
  includeMemories: false,
  tools: ["claude", "codex"],
  extraPaths: [],
};
