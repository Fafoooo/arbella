/**
 * Secret VALUE detection: regexes for high-entropy / well-known credential
 * shapes, plus the set of key NAMES whose values are always secret regardless of
 * shape. Used by the SanitizerService to redact values that slip into otherwise
 * shareable files (settings.json, config.toml, mcp.json, ...).
 *
 * Pure module: no imports, no fs, no clock. The redaction marker is a constant
 * so restore/round-trip code can recognize it and so it is obvious in diffs.
 */

/** The placeholder written in place of a redacted secret value. */
export const REDACTED = "{{REDACTED}}";

/** A named secret-value pattern. */
export interface SecretPattern {
  /** Stable identifier surfaced in SecretRef.key / descriptions. */
  name: string;
  /** Regex matching the secret token. SHOULD be global so all hits are replaced. */
  regex: RegExp;
}

/**
 * Ordered list of secret-value patterns. Order matters only for reporting (the
 * first matching name is used to describe a hit); replacement applies them all.
 *
 * Each regex uses the `g` flag so String#replace swaps every occurrence, and is
 * written to match the TOKEN itself (not surrounding quotes/keys) so the redacted
 * marker drops cleanly in place. Patterns are intentionally specific to keep the
 * false-positive rate low on ordinary prose and paths.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // OpenAI-style keys: sk-..., sk-proj-..., sk-ant-... (>= 20 token chars).
  {
    name: "openai-style-key",
    regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  // Anthropic API keys.
  {
    name: "anthropic-api-key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ (classic + app) and fine-grained.
  {
    name: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  {
    name: "github-fine-grained-token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  },
  // GitLab personal/runner/feed tokens.
  {
    name: "gitlab-token",
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxr-, xoxs-.
  {
    name: "slack-token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // AWS access key id.
  {
    name: "aws-access-key-id",
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  // Google API key.
  {
    name: "google-api-key",
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  // Stripe live/test secret keys.
  {
    name: "stripe-secret-key",
    regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  // OpenAI org/project-scoped service tokens sometimes start with these.
  {
    name: "openai-service-account-key",
    regex: /\bsk-svcacct-[A-Za-z0-9_-]{20,}\b/g,
  },
  // npm automation tokens.
  {
    name: "npm-token",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  // JSON Web Tokens (three base64url parts). Conservative length floors.
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // Bearer / Authorization header values: "Bearer <token>".
  {
    name: "bearer-token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  // "Basic <base64>" Authorization values.
  {
    name: "basic-auth",
    regex: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g,
  },
  // PEM private key blocks (RSA/EC/OPENSSH/PGP/etc). DOTALL via [\s\S].
  {
    name: "private-key-block",
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  // Generic "<SECRETKEY>=<value>" / "<SECRETKEY>: <value>" assignments where the
  // key name itself screams secret (env-style). Captures the VALUE only via a
  // replacer-aware group reference is NOT possible from a flat list, so this
  // pattern matches the whole assignment; the sanitizer treats SECRET_KEY_NAMES
  // structurally for JSON/TOML and uses this for free-text fallback (shell/python
  // hook scripts). Case-INSENSITIVE (the "i" flag) + a mixed-case key class so
  // lowercase assignments like `export my_api_key=...` / `api_token=...` that
  // real users write in hooks are caught too, not just SCREAMING_CASE.
  {
    name: "env-assignment-secret",
    regex:
      /\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"'#]{6,}["']?/gi,
  },
];

/**
 * Key NAMES whose value is ALWAYS treated as secret (case-insensitive, and
 * matched flexibly so "apiKey", "api_key", "API-KEY" all hit). Used by
 * sanitizeJson and by configToml's structural pass. This is broader than the
 * value patterns: it catches custom/opaque tokens that match no known shape.
 */
export const SECRET_KEY_NAMES: readonly string[] = [
  "api_key",
  "apikey",
  "api_token",
  "token",
  "secret",
  "secret_key",
  "password",
  "passwd",
  "passphrase",
  "authorization",
  "auth",
  "auth_token",
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "client_secret",
  "private_key",
  "secret_access_key",
  "encryption_key",
  "credentials",
  "cookie",
  "bearer",
  "pat",
  "x-api-key",
];

/**
 * Container key names whose ENTIRE subtree holds secret leaves: MCP server env
 * maps and request headers. Env vars are named arbitrarily (KEY, OPENAI_KEY,
 * GROQ_WHATEVER), so key-name matching alone cannot catch them — anything a user
 * puts under one of these maps is treated as a credential. Shared by the JSON
 * structural pass (sanitizeJson) and codex's TOML pass so both stay consistent.
 */
export const SECRET_CONTAINER_KEYS: readonly string[] = ["env", "environment", "headers"];

/** True if a JSON/TOML key introduces a secret container (env/environment/headers). */
export function isSecretContainerKey(key: string): boolean {
  return SECRET_CONTAINER_KEYS.includes(key.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Credential-bearing URLs                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Key names whose value is a URL. A URL is not itself a secret — `url:
 * "https://mcp.example.com/sse"` is exactly the kind of value a backup exists to
 * carry — so these keys are NOT in SECRET_KEY_NAMES. They only matter as the
 * gate for {@link isCredentialBearingUrl}.
 */
const URL_KEY_NAMES: ReadonlySet<string> = new Set(["url", "uri", "endpoint", "href"]);

/** True when a key names a URL value. Case-insensitive. */
export function isUrlKey(key: string): boolean {
  return URL_KEY_NAMES.has(key.toLowerCase());
}

/**
 * Query/fragment parameter names that carry a credential but are NOT reliably
 * caught by {@link isSecretKey} — which is tuned for JSON/TOML key names and
 * deliberately excludes bare endings like "key" (VS Code `keybindings.json`
 * entries are literally `{"key": "cmd+k"}`) or short tokens like "sig"/"auth"
 * that would be noisy in that context. In a URL query/fragment those same bare
 * names are exactly what real services use: Google Maps `?key=`, OAuth implicit
 * grants `#access_token=`/`#code=`, SSE session URLs `?session=`. Compared in
 * NORMALIZED form (lowercased, `-`/`_` removed), so `session_id`/`sessionId`
 * both collapse to `sessionid`.
 */
const CREDENTIAL_QUERY_PARAMS_EXTRA: ReadonlySet<string> = new Set([
  "session",
  "sessionid",
  "sid",
  "code",
  "jwt",
  "assertion",
  "sig",
  "signature",
  "key",
  "auth",
  "credential",
  "credentials",
]);

/** True if any `k=v` pair (split on "&"/";") names a credential parameter. */
function hasCredentialParam(pairs: string): boolean {
  if (pairs === "") return false;
  for (const part of pairs.split(/[&;]/)) {
    const rawName = (part.split("=")[0] ?? "").trim();
    if (rawName === "") continue;
    const normalized = rawName.toLowerCase().replace(/[-_]/g, "");
    if (isSecretKey(rawName) || CREDENTIAL_QUERY_PARAMS_EXTRA.has(normalized)) return true;
  }
  return false;
}

/**
 * True when a URL carries a credential IN THE URL ITSELF — the shapes that hide
 * a secret from every key-name and token-shape rule the sanitizer has:
 *
 *   userinfo          `https://user:pa55@host/…`, `https://ghp_xxx@host/…`
 *   query parameter   `https://host/sse?api_key=…`, `…?session=…`
 *   fragment          `https://host/cb#access_token=…` (OAuth implicit grant)
 *
 * All three are routine in MCP server definitions (a hosted server
 * authenticated by a signed URL, or an OAuth callback URL) and would otherwise
 * be stored verbatim: the KEY is `url`, which is not secret, and the VALUE is a
 * URL, which matches no token pattern. The whole value is redacted rather than
 * the credential inside it — a URL with a hole in it restores to something
 * broken either way, and the surviving half would still describe the account.
 *
 * A plain `https://mcp.example.com/sse?version=2&format=json` is not
 * credential-bearing and survives. Pure.
 */
export function isCredentialBearingUrl(value: string): boolean {
  // Must actually look like a URL; `endpoint: "localhost:8080"` is not one.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;

  // userinfo: anything between "://" and an "@" that precedes the host.
  if (/:\/\/[^/?#\s@]+@/.test(value)) return true;

  const queryStart = value.indexOf("?");
  const hashStart = value.indexOf("#");

  const query =
    queryStart === -1
      ? ""
      : value.slice(queryStart + 1, hashStart > queryStart ? hashStart : undefined);
  const fragment = hashStart === -1 ? "" : value.slice(hashStart + 1);

  return hasCredentialParam(query) || hasCredentialParam(fragment);
}

/**
 * Normalize a key for fuzzy matching against SECRET_KEY_NAMES: lowercased with
 * separators (-, _, space) stripped, so "ANTHROPIC_API_KEY" -> "anthropicapikey".
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Pre-normalized secret key names (and their separator-stripped forms). */
const NORMALIZED_SECRET_KEYS: readonly string[] = SECRET_KEY_NAMES.map(normalizeKey);

/**
 * True if a JSON/TOML key name denotes a secret value.
 *
 * Matching is fuzzy and substring-aware so vendor-prefixed keys are caught:
 *   - exact normalized equality (e.g. "token" === "token"); and
 *   - the key ENDS WITH / CONTAINS a known secret token in normalized form, so
 *     "anthropic_api_key", "github_token", "myClientSecret" all match — while a
 *     benign "tokenizer" or "tokens_used" is excluded via word-boundary checks
 *     on the original key.
 */
export function isSecretKey(key: string): boolean {
  if (!key) return false;
  const norm = normalizeKey(key);

  for (const secret of NORMALIZED_SECRET_KEYS) {
    if (norm === secret) return true;
  }

  // High-signal compound stems matched as a normalized SUBSTRING so vendor- and
  // helper-suffixed keys are caught even when they don't END with the token, e.g.
  // "apiKeyHelper" (a key-PRODUCING command — its output is a live credential),
  // "apiKeyHelperPath", "clientSecretRef", "privateKeyPem". These stems are
  // specific enough not to fire on ordinary words ("tokenizer" lacks them).
  const CONTAINS_STEMS = [
    "apikey",
    "secretkey",
    "secretaccesskey",
    "accesskey",
    "privatekey",
    "clientsecret",
    "accesstoken",
    "refreshtoken",
    "sessiontoken",
    "authtoken",
  ];
  for (const stem of CONTAINS_STEMS) {
    if (norm.includes(stem)) return true;
  }

  // Boundary-aware substring check on the ORIGINAL key to avoid "tokenizer".
  const lower = key.toLowerCase();
  const boundaryTokens = [
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "access-key",
    "secret_key",
    "secret-key",
    "client_secret",
    "client-secret",
    "private_key",
    "private-key",
    "refresh_token",
    "access_token",
    "session_token",
    "auth_token",
    "id_token",
    "_token",
    "-token",
    "_secret",
    "-secret",
    "_password",
    "-password",
    "passphrase",
    "credentials",
    // Separator-suffixed "key" so vendor env names like OPENAI_KEY / DEEPL-KEY /
    // service_key are caught. Deliberately NOT bare "key": VS Code-style
    // keybindings.json entries are literally {"key": "cmd+k"} and must survive.
    "_key",
    "-key",
  ];
  for (const tok of boundaryTokens) {
    if (lower.endsWith(tok)) return true;
  }
  // Whole-word "token"/"secret"/"password" (not "tokenizer"/"tokens"/"secretary").
  if (/(^|[^a-z])(token|secret|password|passwd|authorization)([^a-z]|$)/.test(lower)) {
    return true;
  }
  return false;
}
