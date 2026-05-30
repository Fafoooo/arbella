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
