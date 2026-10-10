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
  /**
   * Builds the replacement for one match (a String#replace callback). Absent,
   * the whole match becomes REDACTED; returning the match itself keeps it.
   */
  replace?: (match: string, ...captures: string[]) => string;
}

/** Apply one pattern to `text`. Returns `text` itself when nothing was redacted. */
export function applySecretPattern(text: string, pat: SecretPattern): string {
  // A fresh copy: a shared global regex carries lastIndex between calls.
  const re = new RegExp(pat.regex.source, pat.regex.flags);
  return pat.replace ? text.replace(re, pat.replace) : text.replace(re, REDACTED);
}

/** Shortest assigned literal treated as a credential (below that: flags, words). */
const LITERAL_SECRET_MIN_LENGTH = 8;

/**
 * True when the value side of a secret-named assignment, as written (quotes
 * included), is a LITERAL credential rather than code that produces one.
 *
 * Kept: shell expansions (`$(...)`, `${...}`, `$VAR`, backticks — except inside
 * single quotes or after a backslash; a `$` before anything else, as in
 * `Pa$$w0rd`, is literal),
 * already-redacted text, plain URLs, paths, environment variable
 * names, numbers, unquoted words (a generated credential mixes letters and
 * digits; a bare word is an identifier or a type) and unquoted expressions such
 * as `process.env.X` or `os.environ[`. A run of 20+ letters/digits is a token
 * even when it looks like a URL, a path or a dotted name (a webhook path,
 * `/9xR4k…`, Vault `hvs.CAES…`).
 */
function isLiteralSecret(written: string): boolean {
  const quote = /^["'`]/.test(written) ? written[0] : "";
  const value = quote ? written.slice(1, -1) : written;
  // Control characters only occur in a binary view: fail closed there.
  if (/[\0-\x08\x0e-\x1f\uFFFD]/.test(value)) return true;
  // Backticks run their content in sh, like $(…): code, not a value.
  if (quote === "`") return false;
  // A backslash escape (`\$`) is literal data; drop escapes before looking for expansions.
  const unescaped = value.replace(/\\[\s\S]/g, "");
  if (quote !== "'" && /(?<!\$)\$[({A-Za-z_]|`/.test(unescaped)) return false;
  // Already redacted (idempotence): the value IS the marker — unquoted, it stops
  // at `}`. A value that merely contains braces or the marker is data.
  if (value === REDACTED || value === "{{REDACTED") return false;
  const tokenRun = /[A-Za-z0-9]{20,}/.test(value);
  // A webhook URL carries its secret in the path: hooks.slack.com/services/T…/B…/<token>.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return tokenRun || isCredentialBearingUrl(value);
  if (value.length < LITERAL_SECRET_MIN_LENGTH || /\s/.test(value)) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  // An environment variable NAME is a reference: "OPENAI_API_KEY", GITHUB_TOKEN_2.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return false;
  if (!tokenRun && isPathLike(value)) return false;
  // Quoted, a single word is a literal even without digits ("correcthorse",
  // "P@ssword!"); a separated identifier ("refresh_token", "your-api-key") is not.
  if (quote) return /\d/.test(value) || !/[_.\/-]/.test(value);
  // Unquoted, a word without digits is an identifier or a type: `token: string`.
  if (!/\d/.test(value)) return false;
  return !/[(\[{<>|\\]/.test(unescaped) && (tokenRun || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value));
}

/**
 * Absolute, home- or dot-relative paths, and relative ones that end in a file
 * extension or are all lower case (config/token2.json, secrets/db_password_v2)
 * — unlike mixed-case base64 such as `aB3xY9zQ/1kLmN0pQ`.
 */
function isPathLike(value: string): boolean {
  if (/^(?:\/|~\/|\.{1,2}\/)/.test(value)) return true;
  return /^[\w.-]+(?:\/[\w.-]+)+$/.test(value) && (/\.[A-Za-z]\w{0,5}$/.test(value) || !/[A-Z]/.test(value));
}

/**
 * NAME [:=] VALUE where NAME contains a secret stem in any letter case; the
 * replacer decides with isSecretName whether the stem ends a word. The name
 * parts are bounded so a megabyte-long identifier stays linear. The
 * operator never spans a line, and `:-`/`:=` cover shell defaults. A `${…}`
 * without nested braces is one unit, on its own and inside "…", as in sh, so
 * `"${X:-"default"}"` is read whole. A quoted
 * value honours backslash escapes, falling back to the plain form (in sh, `\'`
 * ends a single-quoted string); an unquoted one stops at control characters so
 * a NUL-separated binary view still trips the binary fail-safe, and treats `#`
 * as a comment only where a word starts (in sh, `abc#123` is one word). Captures:
 * 1 name, 2 operator with spacing, 3 value as written.
 */
const ENV_ASSIGNMENT =
  /\b([A-Za-z0-9_]{0,64}(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_]{0,64})([ \t]*(?::[-=]?(?![=>~:+?])|=(?![=>~:?]))[ \t]*)(\$\{[^{}\n]*\}|"(?:\\.|\$\{[^{}\n]*\}|[^"\\\n])*"|"[^"\n]*"|'(?:\\.|[^'\\\n])*'|'[^'\n]*'|`[^`\n]*`|[^\s\0-\x1f\uFFFD"'`;,)\]}#][^\s\0-\x1f\uFFFD"'`;,)\]}]*)/gi;

/**
 * "…" > ${X:-…} > literal is as deep as real code nests. Deeper is
 * pathological; it is redacted whole rather than recursed into.
 */
const MAX_ASSIGNMENT_DEPTH = 4;

/**
 * The default of a shell expansion, `${VAR:-default}` / `${VAR:=default}` (or
 * without the colon), when it is a plain or quoted word; backslash escapes such
 * as `\$` are part of the word. The closing brace may lie just past an unquoted
 * value, which stops at `}`.
 */
const SHELL_DEFAULT = /(\$\{[A-Za-z_]\w*:?[-=])("(?:\\.|[^"\\\n])*"|'[^'\n]*'|(?:\\.|[^\s{}$`"'\\])+)(?=\}|$)/g;

/** Secret stems inside a name, in any letter case. */
const SECRET_NAME_STEM =
  /api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|client[_-]?secret/gi;

/**
 * True when a stem in `name` ends a word: nothing or a non-letter follows, a
 * `k` follows (secretKey, SECRETKEY, secretkey), or a camel hump does
 * (tokenValue, apiKeyValue). A same-case run-on is another word: TOKENS,
 * tokenizer, secretary.
 */
function isSecretName(name: string): boolean {
  for (const m of name.matchAll(SECRET_NAME_STEM)) {
    const next = name[(m.index ?? 0) + m[0].length] ?? "";
    if (!/[A-Za-z]/.test(next) || /k/i.test(next)) return true;
    if (/[a-z]/.test(m[0].slice(-1)) && /[A-Z]/.test(next)) return true;
  }
  return false;
}

/**
 * Replacer that swaps only the literal VALUE of a secret-named assignment. A
 * value that is code is kept but scanned again, because it can carry a literal
 * default: `"${DB_PASSWORD:-…}"` keeps its expansion and loses the literal.
 * After `:` an unquoted marker is quoted — bare, `{{REDACTED}}` is a YAML map
 * and its `}}` closes a shell `${X:-…}` early.
 */
function literalRedactor(depth: number) {
  return (match: string, name: string, op: string, written: string): string => {
    const secretName = isSecretName(name);
    const atLimit = depth >= MAX_ASSIGNMENT_DEPTH;
    // Past the nesting limit a value that may hold a secret is redacted whole:
    // fail closed rather than recurse further.
    const redact = atLimit
      ? secretName || new RegExp(SECRET_NAME_STEM.source, "i").test(written)
      : secretName && isLiteralSecret(written);
    if (redact) {
      const own = /^["'`]/.test(written) ? written[0] : "";
      const quote = own || (op.includes(":") ? '"' : "");
      return `${name}${op}${quote}${REDACTED}${quote}`;
    }
    if (atLimit) return match;
    // A secret-named value's fallbacks are its value too: "${OTHER:-<literal>}".
    const fallbacks = secretName
      ? written.replace(SHELL_DEFAULT, (whole: string, head: string, fallback: string) =>
          isLiteralSecret(fallback) ? `${head}"${REDACTED}"` : whole,
        )
      : written;
    return `${name}${op}${fallbacks.replace(new RegExp(ENV_ASSIGNMENT), literalRedactor(depth + 1))}`;
  };
}

/**
 * Ordered list of secret-value patterns. Order matters only for reporting (the
 * first matching name is used to describe a hit); replacement applies them all.
 *
 * Each regex uses the `g` flag so String#replace swaps every occurrence, and is
 * written to match the TOKEN itself (not surrounding quotes/keys) so the redacted
 * marker drops cleanly in place — or carries a `replace` that keeps them.
 * Patterns are intentionally specific to keep the false-positive rate low on
 * ordinary prose and paths.
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
  // key name itself screams secret (env-style), for the free-text fallback
  // (shell/python hook scripts, YAML, docs); JSON/TOML use SECRET_KEY_NAMES
  // structurally. Case-INSENSITIVE so `export my_api_key=...` is caught too.
  // Only a LITERAL value is replaced (see ENV_ASSIGNMENT): rewriting the whole
  // assignment turned `TOTAL_INPUT_TOKENS=$(echo ...)` into
  // `{{REDACTED}} "$input" ...` and broke every script it touched.
  {
    name: "env-assignment-secret",
    regex: ENV_ASSIGNMENT,
    replace: literalRedactor(0),
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
 * puts under one of these maps is treated as a credential, except — under an
 * env map only — a switch under a non-secret name
 * (isSwitchValue). Shared by the JSON
 * structural pass (sanitizeJson) and codex's TOML pass so both stay consistent.
 */
export const SECRET_CONTAINER_KEYS: readonly string[] = ["env", "environment", "headers"];

/** True if a JSON/TOML key introduces a secret container (env/environment/headers). */
export function isSecretContainerKey(key: string): boolean {
  return SECRET_CONTAINER_KEYS.includes(key.toLowerCase());
}

/**
 * The containers that hold settings rather than request credentials: env maps.
 * Only below these does isSwitchValue spare a flag or a number; header
 * values stay redacted whatever they look like (a numeric OTP is a credential).
 */
export function isSettingsContainerKey(key: string): boolean {
  return ["env", "environment"].includes(key.toLowerCase());
}

/** true/false, yes/no, on/off or a single digit. */
const SWITCH = /^(?:true|false|yes|no|on|off|\d)$/i;

/**
 * True for a feature switch ("1", "false", "on", true), which is never a
 * credential. Exempts such leaves from the blanket env-container rule only; a
 * secret KEY NAME still redacts them. Multi-digit numbers stay redacted: under
 * names like AUTH_CODE, OTP or MFA_CODE they are live one-time codes.
 */
export function isSwitchValue(value: unknown): boolean {
  return (
    typeof value === "boolean" ||
    ((typeof value === "string" || typeof value === "number") && SWITCH.test(String(value)))
  );
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

/**
 * Credential stems matched as a normalized SUBSTRING of a parameter name, so a
 * VENDOR-PREFIXED parameter is caught too. AWS presigned URLs are the case that
 * forced this: `X-Amz-Credential` / `X-Amz-Signature` normalize to
 * "xamzcredential" / "xamzsignature", which equal nothing in the exact set above
 * and match no rule in {@link isSecretKey} either — so a presigned S3 URL under
 * an `url:` key used to be stored verbatim, signature and all.
 *
 * Kept deliberately short and specific: these three read as credentials wherever
 * they appear in a query-parameter name, unlike a bare "key" or "auth" (already
 * handled exactly above, where a false positive would be noisier).
 */
const CREDENTIAL_PARAM_STEMS: readonly string[] = [
  "credential",
  "signature",
  "securitytoken",
];

/**
 * The parameter name as the SERVER will read it: percent-decoded, lowercased,
 * with "-"/"_" removed. Decoding matters because `?api%5Fkey=…` and `?api_key=…`
 * are the same parameter, and only the second one is recognizable as text.
 * A malformed escape (`%zz`) makes decodeURIComponent throw — that is not a
 * reason to skip the pair, so the raw name is normalized instead.
 */
function normalizeParamName(rawName: string): string {
  let decoded = rawName;
  try {
    decoded = decodeURIComponent(rawName);
  } catch {
    // Malformed percent-escape: fall back to the raw name.
  }
  return decoded.toLowerCase().replace(/[-_]/g, "");
}

/** True if any `k=v` pair (split on "&"/";") names a credential parameter. */
function hasCredentialParam(pairs: string): boolean {
  if (pairs === "") return false;
  for (const part of pairs.split(/[&;]/)) {
    const rawName = (part.split("=")[0] ?? "").trim();
    if (rawName === "") continue;
    const normalized = normalizeParamName(rawName);
    if (isSecretKey(rawName) || isSecretKey(normalized)) return true;
    if (CREDENTIAL_QUERY_PARAMS_EXTRA.has(normalized)) return true;
    if (CREDENTIAL_PARAM_STEMS.some((stem) => normalized.includes(stem))) return true;
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
