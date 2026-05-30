/**
 * Auth provider catalog: maps a git HOST to its OAuth device-flow endpoints,
 * scopes, client_id, and personal-access-token (PAT) help page.
 *
 * arbella authenticates against the host parsed from the backup repo URL, NOT
 * against a hard-wired "github vs gitlab" config field — the same machine may
 * push to github.com for one repo and gitlab.com for another. {@link
 * detectProvider} therefore takes a host string and returns the matching
 * provider (or undefined for an unknown/self-hosted host, where arbella falls
 * back to interactive token paste).
 *
 * CLIENT_ID (honesty, A6): a real device flow needs an OAuth App registered with
 * the provider, with the Device Flow grant enabled. That client_id is PUBLIC
 * (not a secret), but it is account-specific, so arbella cannot ship a working
 * default. Resolution order:
 *   1. an explicit override injected by the caller (e.g. from arbella config),
 *   2. the provider's environment variable
 *      (ARBELLA_GITHUB_CLIENT_ID / ARBELLA_GITLAB_CLIENT_ID),
 *   3. a clearly-marked PLACEHOLDER constant.
 * When the resolved client_id is still the placeholder, {@link providerHasClientId}
 * is false and the index module skips the device flow and offers token paste
 * instead. The README "Authentication" section documents how to register the App.
 *
 * SCOPES (A1): the minimum needed to clone + push a private repo over https:
 *   - GitHub: `repo` (full control of private repositories — clone & push).
 *   - GitLab: `read_repository` + `write_repository` (clone & push over https).
 *
 * This module performs NO network or filesystem I/O and reads no secrets; it is
 * a pure description layer over `process.env`.
 */

import process from "node:process";

import type { DeviceFlowEndpoints } from "./device-flow.js";

/* -------------------------------------------------------------------------- */
/* Provider ids                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The OAuth providers arbella knows how to run a device flow against. This is a
 * SUPERSET-compatible subset of the repo `RepoProvider` ("generic" has no OAuth
 * provider — it always uses token paste), kept local so this module does not
 * couple the auth layer to repo-provider semantics.
 */
export type AuthProviderId = "github" | "gitlab";

/* -------------------------------------------------------------------------- */
/* Placeholder client ids                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sentinel client_id used when no real OAuth App is configured. It is
 * intentionally NOT a valid client id: its presence means "device flow is not
 * available; fall back to token paste". The "ARBELLA_PLACEHOLDER" marker also
 * makes it obvious in any debug output that no App was registered.
 */
export const PLACEHOLDER_CLIENT_ID = "ARBELLA_PLACEHOLDER_CLIENT_ID";

/** True when a resolved client_id is the placeholder (i.e. unconfigured). */
export function isPlaceholderClientId(clientId: string): boolean {
  return clientId.trim() === "" || clientId === PLACEHOLDER_CLIENT_ID;
}

/* -------------------------------------------------------------------------- */
/* Static provider descriptors                                                  */
/* -------------------------------------------------------------------------- */

/** Everything about a provider EXCEPT the runtime-resolved client_id. */
export interface AuthProviderSpec {
  /** Stable provider id. */
  readonly id: AuthProviderId;
  /** Human label for prompts/logs ("GitHub", "GitLab"). */
  readonly displayName: string;
  /** Canonical host this provider serves (e.g. "github.com"). */
  readonly host: string;
  /** RFC 8628 device authorization endpoint. */
  readonly deviceCodeUrl: string;
  /** OAuth token endpoint polled for the access token. */
  readonly tokenUrl: string;
  /** Space-joined OAuth scopes requested (clone + push a private repo). */
  readonly scope: string;
  /** Environment variable that supplies the OAuth App client_id. */
  readonly clientIdEnvVar: string;
  /** Page where a user creates a PAT as the zero-setup fallback. */
  readonly patHelpUrl: string;
  /** One-line hint shown above the token-paste prompt. */
  readonly patHint: string;
}

/** GitHub.com device-flow + token-paste descriptor. */
const GITHUB_SPEC: AuthProviderSpec = {
  id: "github",
  displayName: "GitHub",
  host: "github.com",
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  // `repo` grants clone + push for private repositories over https.
  scope: "repo",
  clientIdEnvVar: "ARBELLA_GITHUB_CLIENT_ID",
  patHelpUrl: "https://github.com/settings/tokens/new?scopes=repo&description=arbella",
  patHint:
    "Create a GitHub token with the `repo` scope at " +
    "https://github.com/settings/tokens (classic) or a fine-grained token with " +
    "Contents: Read and write for the backup repo.",
};

/** GitLab.com device-flow + token-paste descriptor. */
const GITLAB_SPEC: AuthProviderSpec = {
  id: "gitlab",
  displayName: "GitLab",
  host: "gitlab.com",
  deviceCodeUrl: "https://gitlab.com/oauth/authorize_device",
  tokenUrl: "https://gitlab.com/oauth/token",
  // read+write repository grant clone + push over https.
  scope: "read_repository write_repository",
  clientIdEnvVar: "ARBELLA_GITLAB_CLIENT_ID",
  patHelpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
  patHint:
    "Create a GitLab Personal Access Token with the `read_repository` and " +
    "`write_repository` scopes at " +
    "https://gitlab.com/-/user_settings/personal_access_tokens.",
};

/** All known provider specs, keyed by id. */
const SPEC_BY_ID: Readonly<Record<AuthProviderId, AuthProviderSpec>> = {
  github: GITHUB_SPEC,
  gitlab: GITLAB_SPEC,
};

/** All known provider specs (stable order: github, gitlab). */
export const AUTH_PROVIDER_SPECS: readonly AuthProviderSpec[] = [
  GITHUB_SPEC,
  GITLAB_SPEC,
];

/* -------------------------------------------------------------------------- */
/* Host parsing + detection                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract the bare host (lowercased, no port, no `user@`) from a git remote URL
 * or a host string. Handles the three remote shapes arbella sees:
 *   - https://github.com/owner/repo.git        -> "github.com"
 *   - git@github.com:owner/repo.git            -> "github.com"
 *   - ssh://git@gitlab.com:22/owner/repo.git   -> "gitlab.com"
 * and a plain "github.com" passthrough. Returns undefined when no host can be
 * determined (e.g. a `file://` path or a bare local path).
 */
export function parseHost(repoUrlOrHost: string): string | undefined {
  const raw = repoUrlOrHost.trim();
  if (raw === "") return undefined;

  // file:// and bare local paths have no meaningful host for auth purposes.
  if (/^file:\/\//i.test(raw) || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return undefined;
  }

  // scp-like syntax: [user@]host:path  (no scheme, a ":" before the first "/").
  const scpLike = raw.match(/^(?:[^@/]+@)?([^/:]+):(?!\/\/)/);
  if (scpLike) {
    return normalizeHost(scpLike[1]);
  }

  // Anything with a scheme: let URL parse it (covers https/http/ssh/git).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return u.hostname ? normalizeHost(u.hostname) : undefined;
    } catch {
      return undefined;
    }
  }

  // A bare host like "github.com" (optionally "github.com:443").
  if (/^[A-Za-z0-9.-]+(?::\d+)?$/.test(raw) && raw.includes(".")) {
    return normalizeHost(raw);
  }

  return undefined;
}

/** Lowercase + strip a trailing ":port" from a hostname. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "");
}

/**
 * Detect the OAuth provider for a host or repo URL. Matches github.com /
 * gitlab.com exactly (and their `www.`-prefixed forms defensively). Returns
 * undefined for unknown / self-hosted hosts, where the caller uses token paste.
 *
 * NOTE: self-hosted GitHub Enterprise / GitLab instances are intentionally NOT
 * auto-detected here — their endpoints differ per install. They still work via
 * the interactive token-paste fallback in the index module.
 */
export function detectProvider(repoUrlOrHost: string): AuthProviderSpec | undefined {
  const host = parseHost(repoUrlOrHost);
  if (!host) return undefined;
  const bare = host.replace(/^www\./, "");
  if (bare === "github.com") return GITHUB_SPEC;
  if (bare === "gitlab.com") return GITLAB_SPEC;
  return undefined;
}

/** Look up a provider spec by its id. */
export function providerById(id: AuthProviderId): AuthProviderSpec {
  return SPEC_BY_ID[id];
}

/* -------------------------------------------------------------------------- */
/* Client id resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the client_id for a provider. Order: explicit override (e.g. from
 * arbella config) -> the provider's env var -> the placeholder.
 *
 * `overrides` lets the command/config layer inject a client_id read from the
 * arbella config WITHOUT this module importing the config schema (which it must
 * not modify). Keys are provider ids.
 */
export function resolveClientId(
  spec: AuthProviderSpec,
  overrides?: Partial<Record<AuthProviderId, string>>,
): string {
  const override = overrides?.[spec.id];
  if (typeof override === "string" && override.trim() !== "") {
    return override.trim();
  }
  const fromEnv = process.env[spec.clientIdEnvVar];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return PLACEHOLDER_CLIENT_ID;
}

/**
 * True when a real (non-placeholder) client_id is configured for the provider —
 * i.e. the device flow is actually runnable. Used by the index module to decide
 * device-flow vs. token-paste.
 */
export function providerHasClientId(
  spec: AuthProviderSpec,
  overrides?: Partial<Record<AuthProviderId, string>>,
): boolean {
  return !isPlaceholderClientId(resolveClientId(spec, overrides));
}

/**
 * Build the concrete {@link DeviceFlowEndpoints} (endpoints + resolved client_id
 * + scope) the device-flow engine consumes for a provider. Throws when no real
 * client_id is configured — callers should gate on {@link providerHasClientId}
 * first, but this guard keeps a misuse from silently sending the placeholder.
 */
export function buildEndpoints(
  spec: AuthProviderSpec,
  overrides?: Partial<Record<AuthProviderId, string>>,
): DeviceFlowEndpoints {
  const clientId = resolveClientId(spec, overrides);
  if (isPlaceholderClientId(clientId)) {
    throw new Error(
      `No OAuth App client_id is configured for ${spec.displayName}. ` +
        `Set ${spec.clientIdEnvVar} (see the Authentication section of the README) ` +
        "or use the interactive token paste instead.",
    );
  }
  return {
    deviceCodeUrl: spec.deviceCodeUrl,
    tokenUrl: spec.tokenUrl,
    clientId,
    scope: spec.scope,
  };
}
