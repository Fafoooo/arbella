/**
 * Secrets — LOCAL-ONLY encrypted transfer of secret files (R5).
 *
 * This module is the *only* sanctioned way to move secret material (auth tokens,
 * credentials) between machines. It NEVER touches git and is never invoked by
 * the backup/restore repo flow. The user explicitly runs `arbella secrets
 * export` to produce an encrypted, passphrase-protected blob, copies it out of
 * band (USB stick, password manager, secure channel), and runs `arbella
 * secrets import` on the new machine.
 *
 * Crypto (normative):
 *   - key derivation: scryptSync(passphrase, salt(16), 32, SCRYPT_PARAMS)
 *   - cipher:         aes-256-gcm, random iv(12)
 *   - wire format:    base64( MAGIC(4) | salt(16) | iv(12) | authTag(16) | ciphertext )
 *   - the GCM auth tag makes a wrong passphrase / tampered blob fail loudly on
 *     decrypt rather than silently returning garbage.
 *
 * HARD security rules honored here:
 *   - secret VALUES are never logged, printed, or returned in error messages;
 *   - the only artifacts that leave this module are (a) the encrypted blob and
 *     (b) plaintext written back onto the user's own tool homes during import;
 *   - bundle files are restored with their original restrictive mode (default
 *     0o600) so credentials never land world-readable.
 *
 * No system clock is read in library code: `createdAt` is always supplied by the
 * caller (the command layer) as an ISO-8601 string.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { ToolId, SecretRef } from "../../types.js";
import { toolHomeDir } from "../../platform/os.js";
import { fs } from "../../utils/fs.js";

/* -------------------------------------------------------------------------- */
/* Bundle shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One secret file bundled into the blob. `contentB64` is base64 of the raw file
 * bytes (so binary credential blobs survive intact). `relPath` is POSIX-relative
 * to the owning tool's home dir, e.g. ".credentials.json" or "auth.json".
 */
export interface SecretBundleEntry {
  tool: ToolId;
  /** Path relative to the tool home, POSIX separators. */
  relPath: string;
  /** base64 of the raw file bytes. */
  contentB64: string;
  /** Original POSIX file mode (e.g. 0o600). Restored verbatim on import. */
  mode?: number;
}

/** The decrypted, in-memory bundle. `createdAt` is supplied by the caller. */
export interface SecretBundle {
  version: 1;
  /** ISO-8601 timestamp, SUPPLIED BY CALLER (no clock in library code). */
  createdAt: string;
  entries: SecretBundleEntry[];
}

/* -------------------------------------------------------------------------- */
/* Crypto parameters                                                          */
/* -------------------------------------------------------------------------- */

/**
 * scrypt work factors. N=2^15 keeps derivation well under a second on a laptop
 * while remaining costly to brute-force. Exported so tests can assert the exact
 * parameters a blob was produced with.
 */
export const SCRYPT_PARAMS: { N: number; r: number; p: number; keyLen: 32 } = {
  N: 1 << 15, // 32768
  r: 8,
  p: 1,
  keyLen: 32,
};

/** 4-byte magic prefix for format detection ("RSK1" = Arbella Secrets v1). */
const MAGIC = Buffer.from("RSK1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Default mode for restored secret files when the bundle entry didn't capture
 * one. Credentials must never be world-readable, so we default to owner-only.
 */
const DEFAULT_SECRET_MODE = 0o600;

/**
 * scrypt's default `maxmem` (32 MiB) is too small for N=2^15; raise the ceiling
 * so derivation does not throw. 64 MiB is comfortably above the requirement.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Key derivation                                                             */
/* -------------------------------------------------------------------------- */

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/* -------------------------------------------------------------------------- */
/* Encrypt / decrypt                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Encrypt a bundle with a passphrase. Returns an opaque, self-describing,
 * single-line base64 string safe to write to a file or paste into a manager.
 *
 * The plaintext is the UTF-8 JSON serialization of the bundle. Each per-file
 * payload inside is already base64, so the JSON contains no raw secret bytes
 * (and is, of course, encrypted regardless).
 */
export function encryptBundle(bundle: SecretBundle, passphrase: string): string {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("A non-empty passphrase is required to encrypt secrets.");
  }

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const blob = Buffer.concat([MAGIC, salt, iv, authTag, ciphertext]);
  return blob.toString("base64");
}

/**
 * Decrypt a blob produced by `encryptBundle`. Throws a clear (secret-free) error
 * when the passphrase is wrong, the blob is truncated, or the magic/version is
 * unrecognized — the GCM auth tag guarantees tamper/wrong-key detection.
 */
export function decryptBundle(blob: string, passphrase: string): SecretBundle {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("A passphrase is required to decrypt secrets.");
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(blob.trim(), "base64");
  } catch {
    throw new Error("Secret blob is not valid base64.");
  }

  const minLen = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (raw.length < minLen) {
    throw new Error("Secret blob is truncated or corrupt.");
  }

  let offset = 0;
  const magic = raw.subarray(offset, (offset += MAGIC.length));
  if (!magic.equals(MAGIC)) {
    throw new Error("Unrecognized secret blob format (bad magic / version).");
  }

  const salt = raw.subarray(offset, (offset += SALT_LEN));
  const iv = raw.subarray(offset, (offset += IV_LEN));
  const authTag = raw.subarray(offset, (offset += TAG_LEN));
  const ciphertext = raw.subarray(offset);

  const key = deriveKey(passphrase, Buffer.from(salt));

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv));
  decipher.setAuthTag(Buffer.from(authTag));

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure: wrong passphrase or tampered blob. Never leak details.
    throw new Error(
      "Failed to decrypt secrets: wrong passphrase or corrupted blob.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Decrypted secret bundle is not valid JSON.");
  }

  return assertBundle(parsed);
}

/* -------------------------------------------------------------------------- */
/* Discover -> collect -> apply                                              */
/* -------------------------------------------------------------------------- */

/**
 * Known secret FILES per tool, relative to that tool's home dir. These are the
 * `kind:"file"` denylisted artifacts verified to exist on real machines.
 * Kept here as the self-contained source of truth for
 * secret-file discovery so this module never depends on the sanitizer module's
 * full denylist (which also lists non-secret junk like caches/sqlite).
 *
 * Only entries that genuinely hold credentials/tokens belong here — never
 * settings or history.
 */
const SECRET_FILES_BY_TOOL: Record<ToolId, ReadonlyArray<{ relPath: string; description: string }>> = {
  claude: [
    { relPath: ".credentials.json", description: "Claude OAuth credentials / API token store" },
    { relPath: ".claude.json", description: "Claude global state (contains auth tokens)" },
  ],
  codex: [
    { relPath: "auth.json", description: "Codex authentication tokens" },
  ],
  cursor: [
    // Cursor stores auth in the desktop app keychain, not a flat file; nothing
    // portable to bundle here. Present for completeness / forward-compat.
  ],
  opencode: [
    // opencode's credentials live at ~/.local/share/opencode/auth.json — OUTSIDE
    // the config home this adapter captures — so there is nothing under the tool
    // home to bundle. Re-auth via `opencode auth login` after a restore.
  ],
  copilot: [
    // Copilot CLI signs in via gh/device flow; no portable flat credential file
    // under ~/.copilot to bundle.
  ],
  kilo: [
    // Kilo CLI keeps no portable flat credential file under ~/.config/kilo.
  ],
};

/**
 * Scan a tool's home for the known secret files and return `SecretRef`s
 * (metadata only — NEVER the secret value) for the ones that actually exist.
 *
 * Used by `arbella secrets export` to decide what to bundle, independent of a
 * full capture pass. Tolerates a missing tool home (returns []).
 */
export async function gatherSecretRefs(toolId: ToolId): Promise<SecretRef[]> {
  const refs: SecretRef[] = [];
  const home = toolHomeDir(toolId);

  for (const spec of SECRET_FILES_BY_TOOL[toolId]) {
    const abs = path.join(home, spec.relPath);
    if (await fs.exists(abs)) {
      refs.push({
        tool: toolId,
        source: spec.relPath,
        key: spec.relPath,
        description: spec.description,
        kind: "file",
      });
    }
  }

  return refs;
}

/**
 * Gather the actual secret files named by `refs` into an (unencrypted, in-memory)
 * bundle, reading each tool home. Only `kind:"file"` refs are collected; `value`
 * refs describe secrets that live inside otherwise-safe files and are handled by
 * the sanitizer/redaction path, not by file copy.
 *
 * Missing files are skipped silently (the ref may predate a logout). `createdAt`
 * is supplied by the caller.
 */
export async function collectSecretFiles(
  refs: SecretRef[],
  createdAt: string,
): Promise<SecretBundle> {
  const entries: SecretBundleEntry[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (ref.kind !== "file") continue;

    // `source` is the path relative to the tool home; strip any "#fragment"
    // (value-locator syntax) defensively, though file refs shouldn't carry one.
    const relPath = ref.source.split("#")[0]!.replace(/\\/g, "/");
    const dedupeKey = `${ref.tool}:${relPath}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const abs = path.join(toolHomeDir(ref.tool), relPath);
    if (!(await fs.exists(abs))) continue;

    const bytes = await fs.readBytes(abs);
    const mode = await readMode(abs);

    entries.push({
      tool: ref.tool,
      relPath,
      contentB64: bytes.toString("base64"),
      mode,
    });
  }

  return { version: 1, createdAt, entries };
}

/**
 * Write a decrypted bundle's files back onto this machine's tool homes (used by
 * `arbella secrets import`). Each file is written to `toolHome/relPath` with its
 * captured mode (default 0o600). Parent dirs are created as needed.
 *
 * Defends against path traversal: any entry whose resolved destination escapes
 * its tool home is refused (so a malicious blob can't write outside ~/.<tool>).
 */
export async function applySecretBundle(bundle: SecretBundle): Promise<void> {
  for (const entry of bundle.entries) {
    const home = toolHomeDir(entry.tool);
    const rel = entry.relPath.replace(/\\/g, "/");
    const dest = path.resolve(home, rel);

    // Containment check: dest must stay within the tool home.
    const homeResolved = path.resolve(home);
    const withinHome =
      dest === homeResolved ||
      dest.startsWith(homeResolved + path.sep);
    if (!withinHome) {
      throw new Error(
        `Refusing to write secret outside ${entry.tool} home (suspicious path: ${rel}).`,
      );
    }

    const bytes = Buffer.from(entry.contentB64, "base64");
    const mode = entry.mode ?? DEFAULT_SECRET_MODE;
    await fs.writeBytes(dest, bytes, mode);
  }
}

/* -------------------------------------------------------------------------- */
/* High-level convenience wrappers                                            */
/* -------------------------------------------------------------------------- */

/**
 * One-call export: collect the `kind:"file"` secret refs from disk and return
 * the encrypted, portable blob. `createdAt` is supplied by the caller (command
 * layer) so library code stays clock-free.
 *
 * `refs` are typically the secrets surfaced during capture or by
 * `gatherSecretRefs`. The resulting string is the only artifact that leaves the
 * machine; it contains no plaintext.
 */
export async function exportSecrets(
  refs: SecretRef[],
  passphrase: string,
  createdAt: string,
): Promise<string> {
  const bundle = await collectSecretFiles(refs, createdAt);
  return encryptBundle(bundle, passphrase);
}

/**
 * One-call import: decrypt a blob and write its files back onto this machine's
 * tool homes. Throws on a wrong passphrase / tampered blob before touching the
 * filesystem.
 */
export async function importSecrets(blob: string, passphrase: string): Promise<void> {
  const bundle = decryptBundle(blob, passphrase);
  await applySecretBundle(bundle);
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort read of a file's POSIX permission bits. Falls back to the
 * owner-only default when the platform/stat doesn't surface a usable mode
 * (e.g. some Windows filesystems).
 */
async function readMode(abs: string): Promise<number> {
  try {
    const st = await fsp.lstat(abs);
    // Mask to the low 12 bits (perm + setuid/gid/sticky) like `chmod` expects.
    const m = st.mode & 0o7777;
    return m === 0 ? DEFAULT_SECRET_MODE : m;
  } catch {
    return DEFAULT_SECRET_MODE;
  }
}

/**
 * Validate the decrypted JSON has the SecretBundle shape before handing it to
 * callers. Keeps `decryptBundle` honest against malformed-but-decryptable input.
 */
function assertBundle(value: unknown): SecretBundle {
  if (typeof value !== "object" || value === null) {
    throw new Error("Decrypted secret bundle has the wrong shape.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Unsupported secret bundle version: ${String(obj.version)}.`);
  }
  if (typeof obj.createdAt !== "string") {
    throw new Error("Secret bundle is missing a valid createdAt timestamp.");
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error("Secret bundle is missing its entries array.");
  }

  const entries: SecretBundleEntry[] = obj.entries.map((e, i) => {
    if (typeof e !== "object" || e === null) {
      throw new Error(`Secret bundle entry #${i} is malformed.`);
    }
    const rec = e as Record<string, unknown>;
    if (rec.tool !== "claude" && rec.tool !== "codex" && rec.tool !== "cursor") {
      throw new Error(`Secret bundle entry #${i} has an invalid tool id.`);
    }
    if (typeof rec.relPath !== "string" || rec.relPath.length === 0) {
      throw new Error(`Secret bundle entry #${i} has an invalid relPath.`);
    }
    if (typeof rec.contentB64 !== "string") {
      throw new Error(`Secret bundle entry #${i} has invalid content.`);
    }
    const mode = typeof rec.mode === "number" ? rec.mode : undefined;
    return {
      tool: rec.tool as ToolId,
      relPath: rec.relPath,
      contentB64: rec.contentB64,
      mode,
    };
  });

  return { version: 1, createdAt: obj.createdAt, entries };
}
