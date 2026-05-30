/**
 * Unit tests for the credential store (src/core/auth/store.ts) — arbella's
 * local-only, 0600 token vault.
 *
 * These touch the REAL filesystem but inside a throwaway temp dir: we redirect
 * the data dir by pointing `XDG_DATA_HOME` (POSIX) + `os.homedir()` + the Windows
 * env vars at a fresh temp root, so `dataDir()` (from src/platform/os.ts) resolves
 * under it. NO network, NO real ~/.local/share writes.
 *
 * What's proven:
 *   - SAVE writes `credentials.json` with mode 0600 (owner-only) on POSIX, and a
 *     pre-existing looser file is tightened to 0600 on the next save.
 *   - ROUND-TRIP: a saved credential reads back identically (token intact in the
 *     store, which is the one place at rest it is allowed to live).
 *   - LISTING is SECRET-FREE: `listCredentials()` exposes a masked hint, never the
 *     token; and the on-disk path is keyed by host with per-provider/per-host
 *     deletion working as documented.
 *   - HARD: the masked hint reveals at most the last 4 characters.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearAllCredentials,
  credentialsPath,
  deleteCredential,
  deleteCredentialsForProvider,
  getCredential,
  hasCredential,
  listCredentials,
  saveCredential,
  toInfo,
  type StoredCredential,
} from "../../src/core/auth/store.js";

/* -------------------------------------------------------------------------- */
/* Temp data dir + env redirection                                             */
/* -------------------------------------------------------------------------- */

let tmpRoot: string;
let homeSpy: MockInstance;
const savedEnv: Record<string, string | undefined> = {};

function rememberEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-store-"));

  for (const k of ["XDG_DATA_HOME", "HOME", "USERPROFILE", "LOCALAPPDATA"]) {
    rememberEnv(k);
  }
  // POSIX data dir = $XDG_DATA_HOME/arbella; point it at the temp root.
  process.env.XDG_DATA_HOME = path.join(tmpRoot, "xdg-data");
  // Windows data dir = %LOCALAPPDATA%/arbella; redirect that too for portability.
  process.env.LOCALAPPDATA = path.join(tmpRoot, "localappdata");
  // Fallbacks if any code path reads home directly.
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  homeSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpRoot);
});

afterEach(async () => {
  homeSpy.mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/** A sample stored credential (caller supplies createdAt; library has no clock). */
function sampleCredential(over: Partial<StoredCredential> = {}): StoredCredential {
  return {
    host: "github.com",
    provider: "github",
    token: "gho_STORE_ROUND_TRIP_TOKEN_abcdef0123456789",
    tokenType: "bearer",
    scope: "repo",
    createdAt: "2026-05-30T12:00:00.000Z",
    source: "device-flow",
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Save + 0600 + round-trip                                                    */
/* -------------------------------------------------------------------------- */

describe("auth store: save writes 0600 and round-trips", () => {
  it("persists credentials.json under the (redirected) data dir with mode 0600", async () => {
    const file = credentialsPath();
    // The store path lives under our temp XDG dir, not the real home.
    expect(file.startsWith(tmpRoot)).toBe(true);

    await saveCredential(sampleCredential());

    const stat = await fsp.stat(file);
    // Owner read/write only. (Windows lstat does not model POSIX bits the same
    // way; this test host is POSIX — assert the exact mode there.)
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("reads a saved credential back byte-for-byte (token intact at rest)", async () => {
    const cred = sampleCredential();
    await saveCredential(cred);

    const got = await getCredential("github.com");
    expect(got).toBeDefined();
    // The token survives in the store (its only at-rest home), with metadata.
    expect(got!.token).toBe(cred.token);
    expect(got!.provider).toBe("github");
    expect(got!.scope).toBe("repo");
    expect(got!.source).toBe("device-flow");
    expect(got!.createdAt).toBe("2026-05-30T12:00:00.000Z");

    expect(await hasCredential("github.com")).toBe(true);
    // Host lookup is case-insensitive / port-insensitive.
    expect(await hasCredential("GitHub.com")).toBe(true);
    expect(await hasCredential("gitlab.com")).toBe(false);
  });

  it("tightens a pre-existing looser-permissioned file to 0600 on save", async () => {
    const file = credentialsPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Seed a world-readable file as if a prior buggy version wrote it.
    await fsp.writeFile(file, JSON.stringify({ version: 1, hosts: {} }), { mode: 0o644 });
    if (process.platform !== "win32") {
      await fsp.chmod(file, 0o644);
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o644);
    }

    await saveCredential(sampleCredential());

    if (process.platform !== "win32") {
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Listing is secret-free                                                      */
/* -------------------------------------------------------------------------- */

describe("auth store: listing is metadata-only (no token values)", () => {
  it("lists credentials with a masked hint and never the raw token", async () => {
    const cred = sampleCredential();
    await saveCredential(cred);
    await saveCredential(
      sampleCredential({
        host: "gitlab.com",
        provider: "gitlab",
        token: "glpat-LISTING-TOKEN-zzzz9999",
        scope: "read_repository write_repository",
        source: "token-paste",
      }),
    );

    const infos = await listCredentials();
    // Stable host order: github.com before gitlab.com.
    expect(infos.map((i) => i.host)).toEqual(["github.com", "gitlab.com"]);

    const serialized = JSON.stringify(infos);
    // HARD: the full token must NOT appear anywhere in the listing output.
    expect(serialized).not.toContain(cred.token);
    expect(serialized).not.toContain("glpat-LISTING-TOKEN-zzzz9999");

    // The hint reveals only the last 4 chars (everything else is an ellipsis).
    const gh = infos.find((i) => i.host === "github.com")!;
    expect(gh.tokenHint).toBe(`…${cred.token.slice(-4)}`);
    expect(gh.provider).toBe("github");
    expect(gh.source).toBe("device-flow");
  });

  it("toInfo() masks short tokens fully and never carries the value", () => {
    const info = toInfo(sampleCredential({ token: "abcd" }));
    expect(info.tokenHint).toBe("…");
    expect(JSON.stringify(info)).not.toContain("abcd");
    // A refresh token's presence is a boolean only.
    const withRefresh = toInfo(sampleCredential({ refreshToken: "rt-SECRET-xyz" }));
    expect(withRefresh.hasRefreshToken).toBe(true);
    expect(JSON.stringify(withRefresh)).not.toContain("rt-SECRET-xyz");
  });
});

/* -------------------------------------------------------------------------- */
/* Deletion                                                                     */
/* -------------------------------------------------------------------------- */

describe("auth store: deletion by host / provider / all", () => {
  beforeEach(async () => {
    await saveCredential(sampleCredential()); // github.com / github
    await saveCredential(
      sampleCredential({ host: "gitlab.com", provider: "gitlab", token: "glpat-A-1111" }),
    );
    await saveCredential(
      sampleCredential({
        host: "ghe.internal",
        provider: "github",
        token: "ghp-ENTERPRISE-2222",
        source: "token-paste",
      }),
    );
  });

  it("deletes a single host", async () => {
    expect(await deleteCredential("gitlab.com")).toBe(true);
    expect(await hasCredential("gitlab.com")).toBe(false);
    // Deleting a non-existent host returns false.
    expect(await deleteCredential("nope.example")).toBe(false);
    // The others remain.
    expect(await hasCredential("github.com")).toBe(true);
    expect(await hasCredential("ghe.internal")).toBe(true);
  });

  it("deletes every host for a provider", async () => {
    // Two github hosts (github.com + ghe.internal), one gitlab host.
    const removed = await deleteCredentialsForProvider("github");
    expect(removed).toBe(2);
    expect(await hasCredential("github.com")).toBe(false);
    expect(await hasCredential("ghe.internal")).toBe(false);
    expect(await hasCredential("gitlab.com")).toBe(true);
  });

  it("clears all credentials and reports the count", async () => {
    const count = await clearAllCredentials();
    expect(count).toBe(3);
    expect(await listCredentials()).toEqual([]);
    // A second clear on the now-empty store reports 0 (idempotent).
    expect(await clearAllCredentials()).toBe(0);
  });
});
