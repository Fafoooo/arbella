/**
 * Unit tests for the auth provider catalog + URL/redaction/failure helpers
 * (src/core/auth/providers.ts and the URL helpers re-exported from
 * src/core/auth/index.ts).
 *
 * These are PURE (no network, no fs, no spawn) so they are tested directly:
 *   - provider DETECTION from a host or full remote URL (github / gitlab /
 *     unknown-self-hosted), the cornerstone of "authenticate against the host the
 *     repo URL points at, not a hard-wired provider field";
 *   - host PARSING across https / scp-style / ssh / bare-host / file/local shapes;
 *   - client_id resolution order (override -> env var -> placeholder) and the
 *     `providerHasClientId` gate that decides device-flow-vs-paste;
 *   - authenticated-URL construction (`oauth2:<token>@host`) + redaction, and the
 *     HARD guarantee that a token is URL-encoded and never survives redaction;
 *   - `isAuthFailure` classification (so the repo layer retries on the right errors).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  AUTH_PROVIDER_SPECS,
  buildAuthenticatedUrl,
  detectProvider,
  isAuthFailure,
  parseHost,
  PLACEHOLDER_CLIENT_ID,
  providerById,
  providerHasClientId,
  redactAuthUrl,
  resolveClientId,
} from "../../src/core/auth/index.js";
import { buildEndpoints } from "../../src/core/auth/providers.js";

/* -------------------------------------------------------------------------- */
/* Provider detection                                                          */
/* -------------------------------------------------------------------------- */

describe("auth providers: detection (github / gitlab / unknown)", () => {
  it("detects GitHub from a host and from full remote URLs", () => {
    expect(detectProvider("github.com")?.id).toBe("github");
    expect(detectProvider("https://github.com/me/backup.git")?.id).toBe("github");
    expect(detectProvider("git@github.com:me/backup.git")?.id).toBe("github");
    expect(detectProvider("ssh://git@github.com:22/me/backup.git")?.id).toBe("github");
    // Defensive www. prefix + case-insensitivity.
    expect(detectProvider("https://WWW.GitHub.com/me/backup.git")?.id).toBe("github");
  });

  it("detects GitLab from a host and from full remote URLs", () => {
    expect(detectProvider("gitlab.com")?.id).toBe("gitlab");
    expect(detectProvider("https://gitlab.com/group/backup.git")?.id).toBe("gitlab");
    expect(detectProvider("git@gitlab.com:group/backup.git")?.id).toBe("gitlab");
  });

  it("returns undefined for unknown / self-hosted hosts (token-paste fallback)", () => {
    // Self-hosted GHE / GitLab instances are intentionally NOT auto-detected:
    // their endpoints differ per install, so they degrade to token paste.
    expect(detectProvider("git.mycorp.example")).toBeUndefined();
    expect(detectProvider("https://gitlab.internal.acme.net/x/y.git")).toBeUndefined();
    expect(detectProvider("bitbucket.org")).toBeUndefined();
    // A look-alike that is NOT the canonical host must not match github/gitlab.
    expect(detectProvider("github.com.evil.example")).toBeUndefined();
    expect(detectProvider("notgithub.com")).toBeUndefined();
  });

  it("returns undefined when there is no host at all", () => {
    expect(detectProvider("")).toBeUndefined();
    expect(detectProvider("/home/me/local-repo")).toBeUndefined();
    expect(detectProvider("file:///srv/git/backup.git")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Host parsing                                                                 */
/* -------------------------------------------------------------------------- */

describe("auth providers: parseHost across remote shapes", () => {
  it("parses https / ssh / scp-style / bare host", () => {
    expect(parseHost("https://github.com/me/backup.git")).toBe("github.com");
    expect(parseHost("http://example.com:8080/x.git")).toBe("example.com"); // port stripped
    expect(parseHost("git@gitlab.com:group/backup.git")).toBe("gitlab.com");
    expect(parseHost("ssh://git@gitlab.com:22/group/backup.git")).toBe("gitlab.com");
    expect(parseHost("GitHub.com")).toBe("github.com"); // lowercased
    expect(parseHost("github.com:443")).toBe("github.com");
  });

  it("returns undefined for file:// paths, absolute/Windows local paths, and junk", () => {
    expect(parseHost("file:///srv/git/backup.git")).toBeUndefined();
    expect(parseHost("/home/me/backup")).toBeUndefined();
    expect(parseHost("C:\\Users\\me\\backup")).toBeUndefined();
    expect(parseHost("")).toBeUndefined();
    expect(parseHost("   ")).toBeUndefined();
    // A bare word with no dot is not a host.
    expect(parseHost("localrepo")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Provider catalog + client_id resolution                                     */
/* -------------------------------------------------------------------------- */

describe("auth providers: catalog + client_id resolution", () => {
  // resolveClientId reads process.env; isolate it.
  const ENV_VARS = ["ARBELLA_GITHUB_CLIENT_ID", "ARBELLA_GITLAB_CLIENT_ID"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_VARS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("exposes exactly github + gitlab specs with the documented OAuth scopes", () => {
    expect(AUTH_PROVIDER_SPECS.map((s) => s.id)).toEqual(["github", "gitlab"]);
    expect(providerById("github").scope).toBe("repo");
    expect(providerById("gitlab").scope).toBe("read_repository write_repository");
    expect(providerById("github").host).toBe("github.com");
    expect(providerById("gitlab").host).toBe("gitlab.com");
  });

  it("resolves client_id: override > env var > placeholder", () => {
    const gh = providerById("github");

    // Nothing configured -> placeholder, and the gate is false.
    delete process.env.ARBELLA_GITHUB_CLIENT_ID;
    expect(resolveClientId(gh)).toBe(PLACEHOLDER_CLIENT_ID);
    expect(providerHasClientId(gh)).toBe(false);

    // Env var configured -> used, gate true.
    process.env.ARBELLA_GITHUB_CLIENT_ID = "env-client-id";
    expect(resolveClientId(gh)).toBe("env-client-id");
    expect(providerHasClientId(gh)).toBe(true);

    // Explicit override beats the env var.
    expect(resolveClientId(gh, { github: "override-id" })).toBe("override-id");
    expect(providerHasClientId(gh, { github: "override-id" })).toBe(true);

    // A blank/whitespace override falls through to the env var (not treated as set).
    expect(resolveClientId(gh, { github: "   " })).toBe("env-client-id");
  });

  it("buildEndpoints throws when no real client_id is configured (placeholder)", () => {
    const gl = providerById("gitlab");
    delete process.env.ARBELLA_GITLAB_CLIENT_ID;
    expect(() => buildEndpoints(gl)).toThrow(/client_id/i);

    // With a configured id it produces the device-flow endpoints (no throw).
    const eps = buildEndpoints(gl, { gitlab: "real-id" });
    expect(eps.clientId).toBe("real-id");
    expect(eps.deviceCodeUrl).toContain("gitlab.com");
    expect(eps.tokenUrl).toContain("gitlab.com");
    expect(eps.scope).toBe("read_repository write_repository");
  });
});

/* -------------------------------------------------------------------------- */
/* Authenticated URL build + redaction (HARD security)                         */
/* -------------------------------------------------------------------------- */

describe("auth providers: authenticated-URL build + redaction", () => {
  const TOKEN = "ghp_SUPERSECRETtoken_DO_NOT_LEAK_0123456789";

  it("embeds the token as oauth2:<token> and url-encodes it", () => {
    const url = buildAuthenticatedUrl("https://github.com/me/backup.git", TOKEN);
    expect(url).toBe(`https://oauth2:${TOKEN}@github.com/me/backup.git`);

    // A token with URL-reserved characters is percent-encoded so it can't break
    // the URL (the parsed password decodes back to the original).
    const weird = "tok/with:reserved@chars?and#more";
    const wurl = buildAuthenticatedUrl("https://gitlab.com/g/b.git", weird);
    const parsed = new URL(wurl);
    expect(parsed.username).toBe("oauth2");
    expect(decodeURIComponent(parsed.password)).toBe(weird);
    // The raw reserved characters do not appear unescaped in the authority.
    expect(wurl).not.toContain("with:reserved@chars");
  });

  it("never injects credentials into ssh / file / non-https remotes", () => {
    expect(buildAuthenticatedUrl("git@github.com:me/backup.git", TOKEN)).toBe(
      "git@github.com:me/backup.git",
    );
    expect(buildAuthenticatedUrl("file:///srv/git/backup.git", TOKEN)).toBe(
      "file:///srv/git/backup.git",
    );
    expect(buildAuthenticatedUrl("/home/me/backup", TOKEN)).toBe("/home/me/backup");
  });

  it("redactAuthUrl masks the token to oauth2:*** and never reveals it", () => {
    const url = buildAuthenticatedUrl("https://github.com/me/backup.git", TOKEN);
    const red = redactAuthUrl(url);
    expect(red).toBe("https://oauth2:***@github.com/me/backup.git");
    // HARD: the redacted form must NOT contain any part of the token.
    expect(red).not.toContain(TOKEN);
    expect(red).not.toContain("SUPERSECRET");
  });

  it("redactAuthUrl leaves token-free / non-https URLs unchanged", () => {
    expect(redactAuthUrl("https://github.com/me/backup.git")).toBe(
      "https://github.com/me/backup.git",
    );
    expect(redactAuthUrl("git@github.com:me/backup.git")).toBe(
      "git@github.com:me/backup.git",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Auth-failure classification                                                 */
/* -------------------------------------------------------------------------- */

describe("auth providers: isAuthFailure classification", () => {
  it("flags the well-known auth/permission phrases", () => {
    const samples = [
      "remote: Support for password authentication was removed.",
      "fatal: Authentication failed for 'https://github.com/me/backup.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "fatal: unable to access 'https://github.com/...': The requested URL returned error: 403",
      "error: 401 Unauthorized",
      "remote: HTTP Basic: Access denied",
      "remote: Repository not found.",
      "fatal: repository 'https://github.com/me/private.git/' not found",
    ];
    for (const s of samples) {
      expect(isAuthFailure(s)).toBe(true);
    }
  });

  it("reads message + stderr off an execa-like error object", () => {
    const err = Object.assign(new Error("Command failed: git clone"), {
      stderr: "remote: Invalid username or password.\nfatal: Authentication failed",
      exitCode: 128,
    });
    expect(isAuthFailure(err)).toBe(true);
  });

  it("does NOT flag unrelated errors (so they propagate)", () => {
    expect(isAuthFailure("fatal: destination path already exists")).toBe(false);
    expect(isAuthFailure("error: could not resolve host: no-such-host.invalid")).toBe(false);
    expect(isAuthFailure(new Error("ENOSPC: no space left on device"))).toBe(false);
    expect(isAuthFailure("")).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});
