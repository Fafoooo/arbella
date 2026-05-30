/**
 * Credential store: arbella's local-only token vault.
 *
 * Tokens obtained by the device flow (or pasted by the user) are persisted here
 * so the user authenticates once per host, not once per command. The store lives
 * at `dataDir()/credentials.json` (cross-OS, resolved via src/platform/os.ts —
 * never hardcoded) and is keyed by HOST (e.g. "github.com"), so a machine that
 * pushes to several hosts keeps a token for each.
 *
 * HARD SECURITY RULES (BUILD_CONTRACT §0.6 + the auth task):
 *   - This file is the ONLY place a token is written at rest, and it lives ONLY
 *     in arbella's own data dir — NEVER in the backup repo, a manifest, the
 *     README, git history, or arbella's machine config.
 *   - The file is written with mode 0600 (owner read/write only) on every save,
 *     and we proactively chmod it to 0600 even if it already existed, so a token
 *     can never sit world-readable.
 *   - Token VALUES are never logged or returned in error messages. Listing /
 *     status surfaces metadata only (host, provider, createdAt, a masked hint).
 *
 * LIBRARY PURITY (BUILD_CONTRACT §0.5): no system clock is read here. When a
 * caller saves a token it passes the `createdAt` ISO string (the command layer
 * owns the clock); the store just records it.
 *
 * FILE IO goes through src/utils/fs.ts; the one extra primitive the FsService
 * doesn't expose — chmod-ing an existing file — uses node:fs/promises directly
 * and is best-effort (a platform without POSIX modes, e.g. some Windows volumes,
 * simply skips it).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import { dataDir } from "../../platform/os.js";
import { fs } from "../../utils/fs.js";

import type { AuthProviderId } from "./providers.js";

/* -------------------------------------------------------------------------- */
/* Stored shapes                                                               */
/* -------------------------------------------------------------------------- */

/** How a stored token was obtained (informational; shown in `auth status`). */
export type CredentialSource = "device-flow" | "token-paste";

/**
 * One stored credential, keyed by host in the store. The `token` is the access
 * token used to build the authenticated clone/push URL. It is a SECRET — never
 * log or print it. Everything else is safe metadata.
 */
export interface StoredCredential {
  /** Host this credential authenticates (e.g. "github.com"). */
  host: string;
  /** Which provider issued it (so `status` can label it). */
  provider: AuthProviderId;
  /** The access token. SECRET — used only to build the auth URL. */
  token: string;
  /** OAuth token type (typically "bearer"); informational. */
  tokenType?: string;
  /** Granted scope string, when known. */
  scope?: string;
  /** Optional refresh token (GitLab). SECRET — same handling as `token`. */
  refreshToken?: string;
  /** ISO-8601 capture time, SUPPLIED BY CALLER (no clock in library code). */
  createdAt: string;
  /** How the token was acquired. */
  source: CredentialSource;
}

/** Public, secret-free view of a stored credential for status/listing. */
export interface CredentialInfo {
  host: string;
  provider: AuthProviderId;
  scope?: string;
  createdAt: string;
  source: CredentialSource;
  /** A masked, non-reversible hint like "ghp_…last4" — safe to display. */
  tokenHint: string;
  /** Whether a refresh token is also stored (boolean only; never the value). */
  hasRefreshToken: boolean;
}

/** On-disk container. Versioned so the format can evolve compatibly. */
interface CredentialFile {
  version: 1;
  /** Credentials keyed by host. */
  hosts: Record<string, StoredCredential>;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Owner-only permissions: a credential file must never be world-readable. */
const CREDENTIALS_MODE = 0o600;

/** Current on-disk format version. */
const FILE_VERSION = 1 as const;

/* -------------------------------------------------------------------------- */
/* Location                                                                     */
/* -------------------------------------------------------------------------- */

/** Absolute path to the credential store: `dataDir()/credentials.json`. */
export function credentialsPath(): string {
  return path.join(dataDir(), "credentials.json");
}

/* -------------------------------------------------------------------------- */
/* Load                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Load the whole credential file. A missing file yields an empty store (first
 * run). A present-but-corrupt file is tolerated as empty rather than throwing —
 * a damaged token cache must never block a backup/restore; the user simply
 * re-authenticates. (We do not surface the parse error's text, which could in
 * principle echo file bytes.)
 */
async function loadFile(): Promise<CredentialFile> {
  const file = credentialsPath();
  if (!(await fs.exists(file))) {
    return { version: FILE_VERSION, hosts: {} };
  }

  let raw: string;
  try {
    raw = await fs.read(file);
  } catch {
    return { version: FILE_VERSION, hosts: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: FILE_VERSION, hosts: {} };
  }

  return normalizeFile(parsed);
}

/** Coerce arbitrary parsed JSON into a well-formed CredentialFile (best-effort). */
function normalizeFile(parsed: unknown): CredentialFile {
  if (typeof parsed !== "object" || parsed === null) {
    return { version: FILE_VERSION, hosts: {} };
  }
  const obj = parsed as Record<string, unknown>;
  const hostsRaw =
    typeof obj.hosts === "object" && obj.hosts !== null
      ? (obj.hosts as Record<string, unknown>)
      : {};

  const hosts: Record<string, StoredCredential> = {};
  for (const [host, value] of Object.entries(hostsRaw)) {
    const cred = normalizeCredential(host, value);
    if (cred) hosts[cred.host] = cred;
  }
  return { version: FILE_VERSION, hosts };
}

/** Validate a single stored credential; returns null when unusable. */
function normalizeCredential(host: string, value: unknown): StoredCredential | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  const token = typeof v.token === "string" ? v.token : "";
  if (token === "") return null; // a credential with no token is useless.

  const provider: AuthProviderId =
    v.provider === "gitlab" ? "gitlab" : "github";
  const source: CredentialSource =
    v.source === "token-paste" ? "token-paste" : "device-flow";
  const normHost =
    typeof v.host === "string" && v.host.trim() !== ""
      ? v.host.trim().toLowerCase()
      : host.trim().toLowerCase();

  return {
    host: normHost,
    provider,
    token,
    ...(typeof v.tokenType === "string" ? { tokenType: v.tokenType } : {}),
    ...(typeof v.scope === "string" ? { scope: v.scope } : {}),
    ...(typeof v.refreshToken === "string" ? { refreshToken: v.refreshToken } : {}),
    createdAt:
      typeof v.createdAt === "string" ? v.createdAt : new Date(0).toISOString(),
    source,
  };
}

/* -------------------------------------------------------------------------- */
/* Save                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Persist the whole file with strict 0600 permissions. We write via fs.write
 * (which passes the mode to writeFile) AND then chmod the existing inode, so a
 * pre-existing, looser-permissioned file is tightened too.
 */
async function saveFile(data: CredentialFile): Promise<void> {
  const file = credentialsPath();
  await fs.ensureDir(path.dirname(file));
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fs.write(file, json, CREDENTIALS_MODE);
  await chmodBestEffort(file, CREDENTIALS_MODE);
}

/** chmod that never throws (no-op where modes aren't supported). */
async function chmodBestEffort(file: string, mode: number): Promise<void> {
  try {
    await fsp.chmod(file, mode);
  } catch {
    // Platform without POSIX modes (or a transient error): the 0600 passed to
    // writeFile is our primary guard; this is belt-and-braces.
  }
}

/* -------------------------------------------------------------------------- */
/* Public API: per-host operations                                             */
/* -------------------------------------------------------------------------- */

/** Normalize a host key the way detection/storage expects (lowercase, no port). */
function hostKey(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

/** Return the stored credential for a host, or undefined if none. */
export async function getCredential(host: string): Promise<StoredCredential | undefined> {
  const data = await loadFile();
  return data.hosts[hostKey(host)];
}

/** True when a usable token is stored for `host`. */
export async function hasCredential(host: string): Promise<boolean> {
  return (await getCredential(host)) !== undefined;
}

/**
 * Store (or replace) the credential for its host. The credential's own `host`
 * field is the key (normalized). Returns the normalized credential as stored.
 */
export async function saveCredential(cred: StoredCredential): Promise<StoredCredential> {
  const data = await loadFile();
  const normalized: StoredCredential = { ...cred, host: hostKey(cred.host) };
  data.hosts[normalized.host] = normalized;
  await saveFile(data);
  return normalized;
}

/**
 * Remove the credential for `host`. Returns true if one was removed, false if
 * there was nothing stored. When the store becomes empty the file is left in
 * place (an empty `{ hosts: {} }`), still 0600.
 */
export async function deleteCredential(host: string): Promise<boolean> {
  const data = await loadFile();
  const key = hostKey(host);
  if (!(key in data.hosts)) return false;
  delete data.hosts[key];
  await saveFile(data);
  return true;
}

/**
 * Remove every stored credential (used by `auth logout` with no provider).
 * Returns the number of hosts cleared.
 */
export async function clearAllCredentials(): Promise<number> {
  const data = await loadFile();
  const count = Object.keys(data.hosts).length;
  if (count === 0) return 0;
  await saveFile({ version: FILE_VERSION, hosts: {} });
  return count;
}

/**
 * Remove every stored credential for a given provider id (used by `auth logout
 * --provider github`). Returns the number of hosts cleared.
 */
export async function deleteCredentialsForProvider(
  provider: AuthProviderId,
): Promise<number> {
  const data = await loadFile();
  let count = 0;
  for (const [host, cred] of Object.entries(data.hosts)) {
    if (cred.provider === provider) {
      delete data.hosts[host];
      count += 1;
    }
  }
  if (count > 0) await saveFile(data);
  return count;
}

/* -------------------------------------------------------------------------- */
/* Listing (metadata only — never token values)                               */
/* -------------------------------------------------------------------------- */

/**
 * List all stored credentials as SECRET-FREE {@link CredentialInfo} records, in
 * stable host order. Safe for `auth status` output: the token itself is reduced
 * to a masked hint that reveals only a short suffix.
 */
export async function listCredentials(): Promise<CredentialInfo[]> {
  const data = await loadFile();
  return Object.values(data.hosts)
    .map((c) => toInfo(c))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** Project a stored credential to its secret-free info view. */
export function toInfo(cred: StoredCredential): CredentialInfo {
  return {
    host: cred.host,
    provider: cred.provider,
    ...(cred.scope ? { scope: cred.scope } : {}),
    createdAt: cred.createdAt,
    source: cred.source,
    tokenHint: maskToken(cred.token),
    hasRefreshToken: typeof cred.refreshToken === "string" && cred.refreshToken !== "",
  };
}

/**
 * Produce a non-reversible display hint for a token: show at most the last 4
 * characters, everything else as a fixed ellipsis. Never reveals enough to
 * reconstruct the token. Very short tokens are fully masked.
 */
export function maskToken(token: string): string {
  const t = token ?? "";
  if (t.length <= 4) return "…";
  return `…${t.slice(-4)}`;
}
