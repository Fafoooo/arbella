/**
 * Unit tests for the SanitizerService (src/core/sanitizer).
 *
 * Two guarantees are exercised:
 *   1. value redaction — a settings blob carrying an API key comes back with the
 *      secret replaced by the {{REDACTED}} marker (and the raw key is GONE);
 *   2. denylist exclusion — Codex's auth.json (and Claude's credential files) are
 *      reported as denied so adapters never read them into the repo.
 */

import { describe, it, expect } from "vitest";

import { createSanitizer } from "../../src/core/sanitizer/index.js";
import { denylistFor, matchesDeny } from "../../src/core/sanitizer/denylist.js";
import { REDACTED, isSecretKey } from "../../src/core/sanitizer/patterns.js";

const sanitizer = createSanitizer();

describe("sanitizer: value redaction (sanitizeJson)", () => {
  it("redacts an API key value inside a settings blob", () => {
    const settings = {
      model: "claude-sonnet",
      mcpServers: {
        weather: {
          command: "npx",
          env: {
            // A genuine-looking Anthropic key whose KEY name screams secret.
            ANTHROPIC_API_KEY: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          },
        },
      },
    };

    const { value, found } = sanitizer.sanitizeJson(settings, "claude", "settings.json");

    const serialized = JSON.stringify(value);
    // The redaction marker is present...
    expect(serialized).toContain(REDACTED);
    // ...and the raw secret token is completely gone.
    expect(serialized).not.toContain("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    // The redacted value is exactly the marker (whole-value replacement on a secret key).
    expect((value as any).mcpServers.weather.env.ANTHROPIC_API_KEY).toBe(REDACTED);
    // At least one SecretRef was reported, pointing inside the file.
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.tool).toBe("claude");
    expect(found[0]!.kind).toBe("value");
    expect(found[0]!.source.startsWith("settings.json#")).toBe(true);
  });

  it("does not mutate the input object", () => {
    const original = { token: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const snapshot = JSON.parse(JSON.stringify(original));
    sanitizer.sanitizeJson(original, "claude", "x.json");
    expect(original).toEqual(snapshot);
  });

  it("leaves benign values untouched", () => {
    const blob = { name: "arbella", count: 3, nested: { note: "a plain string" } };
    const { value, found } = sanitizer.sanitizeJson(blob, "codex", "config.json");
    expect(value).toEqual(blob);
    expect(found).toHaveLength(0);
  });

  it("redacts a recognizable secret value even under a non-secret key", () => {
    // The KEY ("note") is not secret, but the VALUE is a GitHub token pattern.
    const blob = { note: "deploy with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xy and go" };
    const { value, found } = sanitizer.sanitizeJson(blob, "codex", "notes.json");
    expect((value as any).note).toContain(REDACTED);
    expect((value as any).note).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xy");
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("sanitizer: value redaction (sanitizeText)", () => {
  it("redacts every secret occurrence in free text", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const text =
      "key1=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and a token " + jwt;
    const result = sanitizer.sanitizeText(text, "codex", "config.toml");
    expect(result.changed).toBe(true);
    expect(result.content).toContain(REDACTED);
    expect(result.content).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(result.content).not.toContain(jwt);
    expect(result.found.length).toBeGreaterThan(0);
  });

  it("returns content unchanged when there is no secret", () => {
    const text = "just an ordinary line of markdown about ~/.claude paths";
    const result = sanitizer.sanitizeText(text, "claude", "CLAUDE.md");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(text);
    expect(result.found).toHaveLength(0);
  });
});

describe("sanitizer: denylist exclusion", () => {
  it("denies Codex auth.json (whole-file secret)", () => {
    expect(matchesDeny("auth.json", denylistFor("codex"))).toBe(true);
    // Even nested under the codex home.
    expect(matchesDeny("nested/auth.json", denylistFor("codex"))).toBe(true);
  });

  it("denies Claude credential/state files", () => {
    const deny = denylistFor("claude");
    expect(matchesDeny(".credentials.json", deny)).toBe(true);
    expect(matchesDeny(".claude.json", deny)).toBe(true);
  });

  it("isDenied() flags common junk but stays tool-agnostic", () => {
    // COMMON_DENY (sqlite/OS cruft) is caught by the service's tool-agnostic check.
    expect(sanitizer.isDenied("foo.sqlite")).toBe(true);
    expect(sanitizer.isDenied(".DS_Store")).toBe(true);
    expect(sanitizer.isDenied("sub/dir/cache/x")).toBe(true);
    // auth.json is a PER-TOOL deny (codex), not part of COMMON_DENY, so the
    // tool-agnostic service does NOT flag it on its own.
    expect(sanitizer.isDenied("auth.json")).toBe(false);
    // A perfectly shareable settings file is never denied.
    expect(sanitizer.isDenied("settings.json")).toBe(false);
  });

  it("keeps a shareable file (config.toml) out of the codex denylist", () => {
    expect(matchesDeny("config.toml", denylistFor("codex"))).toBe(false);
  });
});

describe("sanitizer: isSecretKey heuristics", () => {
  it("matches vendor-prefixed secret keys", () => {
    expect(isSecretKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretKey("github_token")).toBe(true);
    expect(isSecretKey("client_secret")).toBe(true);
    expect(isSecretKey("password")).toBe(true);
  });

  it("matches key-PRODUCING / suffixed compound keys (apiKeyHelper, etc.)", () => {
    // apiKeyHelper's output is a live credential — treat the key as secret.
    expect(isSecretKey("apiKeyHelper")).toBe(true);
    expect(isSecretKey("apiKeyHelperPath")).toBe(true);
    expect(isSecretKey("clientSecretRef")).toBe(true);
    expect(isSecretKey("privateKeyPem")).toBe(true);
  });

  it("does not match benign lookalikes", () => {
    expect(isSecretKey("tokenizer")).toBe(false);
    expect(isSecretKey("tokens_used")).toBe(false);
    expect(isSecretKey("model")).toBe(false);
    expect(isSecretKey("apiVersion")).toBe(false);
    expect(isSecretKey("keyboardLayout")).toBe(false);
  });
});

describe("sanitizer: sanitizeFile is the key-name-aware production path (§0.6)", () => {
  it("redacts an OPAQUE value under a secret KEY NAME in a JSON config", () => {
    // The VALUE matches NO known token shape; only the KEY NAME marks it secret.
    // sanitizeText alone would miss this (the original leak); sanitizeFile (the
    // production capture path) routes JSON through the structural sanitizer.
    const settings = JSON.stringify(
      { env: { ANTHROPIC_AUTH_TOKEN: "corp-gateway-OPAQUE-7766aabb" } },
      null,
      2,
    );
    const res = sanitizer.sanitizeFile(settings, "claude", "settings.json");
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain("corp-gateway-OPAQUE-7766aabb");
    expect(res.content).toContain(REDACTED);

    // Prove the gap sanitizeText left open (regression anchor): the value-pattern
    // pass does NOT redact an opaque value under a secret key.
    const textOnly = sanitizer.sanitizeText(settings, "claude", "settings.json");
    expect(textOnly.content).toContain("corp-gateway-OPAQUE-7766aabb");
  });

	  it("redacts an opaque api_token / apiKeyHelper value in a JSON config", () => {
    const blob = JSON.stringify(
      { api_token: "plain-opaque-no-prefix-001122", apiKeyHelper: "echo my-opaque-zzz999" },
      null,
      2,
    );
    const res = sanitizer.sanitizeFile(blob, "cursor", "mcp.json");
    expect(res.content).not.toContain("plain-opaque-no-prefix-001122");
    expect(res.content).not.toContain("my-opaque-zzz999");
	  });

	  it("redacts opaque secret-key values in JSONC Cursor settings", () => {
	    const jsonc = [
	      "{",
	      "  // Cursor settings allow comments",
	      "  \"mcpServers\": {",
	      "    \"internal\": {",
	      "      \"env\": {",
	      "        \"ANTHROPIC_AUTH_TOKEN\": \"plain-opaque-jsonc-secret\"",
	      "      },",
	      "    },",
	      "  },",
	      "}",
	    ].join("\n");

	    const res = sanitizer.sanitizeFile(jsonc, "cursor", "settings.json");
	    expect(res.changed).toBe(true);
	    expect(res.content).not.toContain("plain-opaque-jsonc-secret");
	    expect(res.content).toContain(REDACTED);
	    expect(res.found.some((ref) => ref.source.includes("ANTHROPIC_AUTH_TOKEN"))).toBe(true);
	  });

	  it("falls back to the text pass for non-JSON content (hook scripts)", () => {
    const hook = 'export ANTHROPIC_API_KEY="sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"';
    const res = sanitizer.sanitizeFile(hook, "claude", "hooks/run.sh");
    expect(res.content).toContain(REDACTED);
    expect(res.content).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("redacts LOWERCASE env-style secret assignments in hook scripts (§0.6)", () => {
    // Real users write lowercase env var names; the env-assignment pattern must
    // be case-insensitive so these don't leak from frozen *.sh/*.py hooks.
    const script = [
      'export my_api_key="literal-opaque-value-123456"',
      "api_token=plainsecretvalue7890",
      "export AWS_SECRET_ACCESS_KEY=uppercasevalue123456",
    ].join("\n");
    const res = sanitizer.sanitizeFile(script, "claude", "hooks/session.sh");
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain("literal-opaque-value-123456");
    expect(res.content).not.toContain("plainsecretvalue7890");
    expect(res.content).not.toContain("uppercasevalue123456");
  });

  it("leaves a benign JSON config semantically unchanged", () => {
    const benign = JSON.stringify({ model: "claude", count: 3 }, null, 2);
    const res = sanitizer.sanitizeFile(benign, "claude", "settings.json");
    expect(JSON.parse(res.content)).toEqual(JSON.parse(benign));
  });
});

describe("sanitizer: secret-named assignments never break code", () => {
  // A live push replaced `NAME=<first chunk of the value>` with the marker in 58
  // scripts, e.g. `TOTAL_INPUT_TOKENS=$(echo ...)` -> `{{REDACTED}} "$input" ...`.
  // Only a LITERAL value is a secret; the name, the operator and the quotes stay.

  it("leaves a statusline script that counts tokens byte-identical", () => {
    const script = [
      "#!/bin/bash",
      'input=$(cat)',
      "TOTAL_INPUT_TOKENS=$(echo \"$input\" | jq -r '.context_window.total_input_tokens // 0')",
      "TOTAL_OUTPUT_TOKENS=$(echo \"$input\" | jq -r '.context_window.total_output_tokens // 0')",
      'echo "in=$TOTAL_INPUT_TOKENS out=$TOTAL_OUTPUT_TOKENS"',
    ].join("\n");
    const res = sanitizer.sanitizeFile(script, "claude", "statusline.sh");
    expect(res.content).toBe(script);
    expect(res.changed).toBe(false);
  });

  it.each([
    "NPM_TOKEN=$(security find-generic-password -s npm -w)",
    'export API_TOKEN="${API_TOKEN:-}"',
    "SECRET=${1:-}",
    'api_key = os.environ["OPENAI_API_KEY"]',
    "const apiKey = process.env.OPENAI_API_KEY_V2;",
    "  token: string;",
    "  password: z.string().min(8),",
    "const token = `${prefix}-${id}`;",
    "API_TOKEN=`readtoken`",
    "TOKEN=`get_key2`",
    "TOKEN_URL=https://oauth2.googleapis.com/token",
    "PASSWORD_FILE=/run/secrets/db_password_v2",
    "TOKEN_FILE=config/token2.json",
    'TOKEN_FILE="${XDG_CONFIG_HOME}/app/token2.json"',
    'TOKEN_URL="${BASE_URL}/v1/token"',
    'TOKEN_CMD="gh auth token"',
    'PASSWORD_PROMPT="Enter your password:"',
    "PASSWORD_FILE=secrets/db_password_v2",
    'token_type_hint: "refresh_token"',
    'api_key_env = "OPENAI_API_KEY"',
    'GITHUB_TOKEN_VAR="GITHUB_TOKEN_2"',
    "GITHUB_TOKEN=<your-token>",
    'API_KEY="your-api-key-here"',
    'tokenizer_model = "bert-base-v2"',
    "MAX_OUTPUT_TOKENS=128000",
  ])("keeps %s intact (expansion, lookup, type, path, URL or placeholder)", (line) => {
    const res = sanitizer.sanitizeFile(line, "claude", "scripts/hook.sh");
    expect(res.content).toBe(line);
  });

  it("redacts a literal value but keeps the name, operator and quotes", () => {
    const script = [
      'export my_api_key="literal-opaque-value-123456"',
      "api_token=plainsecretvalue7890",
      "export AWS_SECRET_ACCESS_KEY=uppercasevalue123456",
      "password: 'Sup3r-Secret-Pw'",
    ].join("\n");
    const res = sanitizer.sanitizeFile(script, "claude", "hooks/session.sh");
    expect(res.content).toBe(
      [
        `export my_api_key="${REDACTED}"`,
        `api_token=${REDACTED}`,
        `export AWS_SECRET_ACCESS_KEY=${REDACTED}`,
        `password: '${REDACTED}'`,
      ].join("\n"),
    );
    expect(res.found.map((ref) => ref.key)).toEqual(["env-assignment-secret"]);
  });

  it("never pulls the next line into an assignment", () => {
    const yaml = "secret:\n  rotation_days: 30\napi_token:\n  - abc123def456\ntoken:\nabc123def456\n";
    expect(sanitizer.sanitizeFile(yaml, "claude", "skills/x/config.yaml").content).toBe(yaml);
  });

  it("is idempotent on already-redacted text", () => {
    const once = `export X_TOKEN="${REDACTED}"\nY_SECRET=${REDACTED}\n`;
    const res = sanitizer.sanitizeFile(once, "claude", "hooks/x.sh");
    expect(res.content).toBe(once);
    expect(res.changed).toBe(false);
  });

  it("leaves a hook command string in settings.json intact", () => {
    const command = "OPENAI_API_KEY=$(security find-generic-password -s openai -w) npx -y some-mcp";
    const settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command }] }] } }, null, 2);
    const res = sanitizer.sanitizeFile(settings, "claude", "settings.json");
    expect(res.content).toBe(settings);
  });

  // Leak paths an adversarial review proved against the first cut of this rule:
  // each input below was redacted before the rewrite and must stay redacted.
  it.each([
    ["DB_PASSWORD=P@ssw0rd!2024", `DB_PASSWORD=${REDACTED}`],
    [
      'curl -s "https://api.example.com/v1/data?api_key=abc123def456ghi&limit=10"',
      `curl -s "https://api.example.com/v1/data?api_key=${REDACTED}"`,
    ],
    [
      'export DB_PASSWORD="${DB_PASSWORD:-Sup3rS3cretPw}"',
      `export DB_PASSWORD="\${DB_PASSWORD:-"${REDACTED}"}"`,
    ],
    [
      "export API_TOKEN=${API_TOKEN:-abc123def456ghi}",
      `export API_TOKEN=\${API_TOKEN:-"${REDACTED}"}`,
    ],
    ["VAULT_TOKEN=hvs.CAESIFakeFakeFakeFakeFake1234567890abcd", `VAULT_TOKEN=${REDACTED}`],
    ["AWS_SECRET_ACCESS_KEY=/9xR4kFakeFakeFakeFakeFakeFakeuP8o", `AWS_SECRET_ACCESS_KEY=${REDACTED}`],
    ["AWS_SECRET_ACCESS_KEY=+9xR4kFakeFakeFakeFakeFakeFakeuP8o", `AWS_SECRET_ACCESS_KEY=${REDACTED}`],
    ['secretKey: "abc123def456ghi"', `secretKey: "${REDACTED}"`],
    ["SECRETKEY=abc123def456ghi", `SECRETKEY=${REDACTED}`],
    ['tokenValue: "abc123def456ghi"', `tokenValue: "${REDACTED}"`],
    // Any letter case, as on main: only a same-case run-on (TOKENS) is excluded.
    ["secretkey=abc123def456ghi", `secretkey=${REDACTED}`],
    // A literal glued to an expansion is still a hard-coded secret.
    ['DB_PASSWORD="${PREFIX}Sup3rS3cret9"', `DB_PASSWORD="${REDACTED}"`],
    // A quoted passphrase of four or more plain words.
    ['DB_PASSWORD="Correct Horse Battery Staple"', `DB_PASSWORD="${REDACTED}"`],
    // Only arbella's own marker means "already redacted"; other braces are data.
    ['DB_PASSWORD="s3cr3t{{not_a_template}}"', `DB_PASSWORD="${REDACTED}"`],
    // Only a value that IS the marker counts as redacted, not one that contains it.
    [`DB_PASSWORD="${REDACTED}abc123real"`, `DB_PASSWORD="${REDACTED}"`],
    // In sh, `#` inside a word is literal; only a word-initial `#` starts a comment.
    ["DB_PASSWORD=abc123#456", `DB_PASSWORD=${REDACTED}`],
    // `\$` is a literal dollar in sh, not an expansion.
    ['DB_PASSWORD="correct\\$horse123"', `DB_PASSWORD="${REDACTED}"`],
    // The default of any ${VAR:-…} inside a secret-named value is classified itself.
    [
      'DB_PASSWORD="${FALLBACK_VALUE:-Sup3rS3cretPw}"',
      `DB_PASSWORD="\${FALLBACK_VALUE:-"${REDACTED}"}"`,
    ],
    [
      'DB_PASSWORD="${FALLBACK_VALUE:-correct\\$horse123}"',
      `DB_PASSWORD="\${FALLBACK_VALUE:-"${REDACTED}"}"`,
    ],
    [
      `DB_PASSWORD="\${FALLBACK_VALUE:-"Sup3rS3cretPw"}"`,
      `DB_PASSWORD="\${FALLBACK_VALUE:-"${REDACTED}"}"`,
    ],
    [
      `DB_PASSWORD=\${FALLBACK_VALUE:-'Sup3rS3cretPw'}`,
      `DB_PASSWORD=\${FALLBACK_VALUE:-"${REDACTED}"}`,
    ],
    // Quoted, a single word is a literal even without digits.
    ['DB_PASSWORD="correcthorse"', `DB_PASSWORD="${REDACTED}"`],
    ["password: 'P@ssword!'", `password: '${REDACTED}'`],
    // Slash-separated but mixed case, no extension: base64, not a path.
    ["API_TOKEN=aB3xY9zQ/1kLmN0pQ", `API_TOKEN=${REDACTED}`],
    ["Api_KEY=abc123def456ghi", `Api_KEY=${REDACTED}`],
    ["PassWord=abc123def456ghi", `PassWord=${REDACTED}`],
    ['apiKeyValue = "abc123def456ghi"', `apiKeyValue = "${REDACTED}"`],
    ["X-API-Key: abc123def456ghi", `X-API-Key: "${REDACTED}"`],
    // A webhook carries its secret in the URL path (host kept generic so the
    // fixture does not trip GitHub's secret scanning).
    [
      "WEBHOOK_TOKEN=https://hooks.example.com/services/T0000/B0000/FakeFakeFakeFakeFake1234",
      `WEBHOOK_TOKEN=${REDACTED}`,
    ],
  ])("still redacts %s", (input, expected) => {
    expect(sanitizer.sanitizeFile(input, "claude", "hooks/x.sh").content).toBe(expected);
  });

  it.each([
    // `$$`, `$9` are literal outside a shell; only $( ${ $NAME and backticks expand.
    ['DB_PASSWORD="Pa$$w0rd123"', `DB_PASSWORD="${REDACTED}"`],
    ['password: "Xy$9abc!def"', `password: "${REDACTED}"`],
    // An escaped quote does not end the string.
    ['TOKEN="abcd1234\\"rest-of-secret99"', `TOKEN="${REDACTED}"`],
    ["password = 'abcdefgh1234\\'rest99'", `password = '${REDACTED}'`],
    // After `:` the marker is quoted: YAML keeps a string, ${X:-} keeps its brace.
    ["api_token: abc123def456", `api_token: "${REDACTED}"`],
  ])("redacts %s without breaking the syntax around it", (input, expected) => {
    expect(sanitizer.sanitizeFile(input, "claude", "skills/x/config.yaml").content).toBe(expected);
  });

  it.each(['TOKEN="$API_KEY_V2"', 'TOKEN_FILE="$HOME/.config/token2"'])(
    "keeps the variable expansion %s",
    (line) => {
      expect(sanitizer.sanitizeFile(line, "claude", "hooks/x.sh").content).toBe(line);
    },
  );

  it("fails closed past the nesting limit instead of shipping the literal", () => {
    const line = 'X_TOKEN="${A_TOKEN:-${B_TOKEN:-${C_TOKEN:-${D_TOKEN:-${E_TOKEN:-abc123def456ghi}}}}}"';
    expect(sanitizer.sanitizeText(line, "claude", "x.sh").content).not.toContain("abc123def456ghi");
  });

  it("redacts a shell single-quoted value that ends in a backslash", () => {
    // In sh, `\'` closes a single-quoted string; the escape-aware form must
    // not make the whole value unmatchable.
    expect(sanitizer.sanitizeFile("TOKEN='abc123def456\\'", "claude", "x.sh").content).toBe(
      `TOKEN='${REDACTED}'`,
    );
  });

  it("flags a quoted secret followed by binary junk inside a binary view", () => {
    const view = '\0API_TOKEN="abc123def456ghi\0\x01 junk"\0';
    expect(sanitizer.sanitizeText(view, "claude", "bin/tool").changed).toBe(true);
  });

  it("handles pathological lines without blowing the stack or the clock", () => {
    expect(() => sanitizer.sanitizeText("TOKEN=$".repeat(2000), "claude", "x.sh")).not.toThrow();
    expect(() =>
      sanitizer.sanitizeText(`\${A_TOKEN:-`.repeat(2000), "claude", "x.sh"),
    ).not.toThrow();
    const started = performance.now();
    sanitizer.sanitizeText("TOKEN_".repeat(35000), "claude", "bundle.js");
    // An unclosed quote over ${…} units must not backtrack exponentially.
    sanitizer.sanitizeText('X_TOKEN="' + "${a}".repeat(40), "claude", "x.sh");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("redacts a literal inside an auto-approved Bash rule in settings.local.json", () => {
    const rule = "Bash(PGPASSWORD=Pg!pass2024 psql -h db -U app:*)";
    const settings = JSON.stringify({ permissions: { allow: [rule] } }, null, 2);
    const res = sanitizer.sanitizeFile(settings, "claude", "settings.local.json");
    expect(JSON.parse(res.content).permissions.allow).toEqual([
      `Bash(PGPASSWORD=${REDACTED} psql -h db -U app:*)`,
    ]);
  });

  it("still flags secret-shaped bytes inside a binary blob (binary fail-safe)", () => {
    const view = "\x7fELF\0\0API_TOKEN=abc123def456ghi\0\0rest";
    expect(sanitizer.sanitizeText(view, "claude", "bin/tool").changed).toBe(true);
  });
});

describe("sanitizer: credential-bearing URLs", () => {
  const TOKEN = "s3cr3t-signed-value-0123456789";

  /** Sanitize one MCP-shaped server def and hand back its `url`. */
  function urlAfter(url: string, key = "url"): unknown {
    const { value } = sanitizer.sanitizeJson(
      { mcpServers: { remote: { type: "sse", [key]: url } } },
      "claude",
      ".claude.json#mcpServers",
    );
    const servers = (value as Record<string, Record<string, Record<string, unknown>>>).mcpServers;
    return servers.remote![key];
  }

  it("redacts a URL carrying userinfo", () => {
    // Neither rule that exists would see this: "url" is not a secret KEY, and a
    // URL matches no token SHAPE — the credential is a substring of the value.
    expect(urlAfter(`https://svc:${TOKEN}@mcp.example.com/sse`)).toBe(REDACTED);
    expect(urlAfter(`https://${TOKEN}@mcp.example.com/sse`)).toBe(REDACTED);
  });

  it("redacts a URL whose query names a credential parameter", () => {
    for (const param of [
      "key",
      "token",
      "access_token",
      "secret",
      "sig",
      "signature",
      "apikey",
      "api_key",
      "auth",
      "password",
    ]) {
      expect({ param, url: urlAfter(`https://mcp.example.com/sse?${param}=${TOKEN}`) }).toEqual({
        param,
        url: REDACTED,
      });
    }
  });

  it("applies to every URL-shaped key name", () => {
    for (const key of ["url", "URL", "uri", "endpoint", "href"]) {
      expect({ key, url: urlAfter(`https://u:p@mcp.example.com/sse`, key) }).toEqual({
        key,
        url: REDACTED,
      });
    }
  });

  it("leaves a plain endpoint URL alone — that is what a backup is FOR", () => {
    for (const url of [
      "https://mcp.example.com/sse",
      "https://mcp.example.com/sse?version=2&region=eu",
      "http://localhost:8080/mcp",
      "https://user.example.com/path/token/readme",
    ]) {
      expect({ url, after: urlAfter(url) }).toEqual({ url, after: url });
    }
  });

  it("leaves a non-URL value under a url-ish key alone", () => {
    expect(urlAfter("localhost:8080", "endpoint")).toBe("localhost:8080");
  });

  it("redacts a URL whose query names a credential param isSecretKey alone misses (session-shaped)", () => {
    // Bare "session"/"sid"/"code" etc. are not secret JSON KEY names (too
    // noisy there), but they are exactly how services hand back a live
    // credential in a URL query string.
    for (const param of ["session", "sessionid", "session_id", "sid", "code", "jwt", "assertion"]) {
      expect({ param, url: urlAfter(`https://mcp.example.com/sse?${param}=${TOKEN}`) }).toEqual({
        param,
        url: REDACTED,
      });
    }
  });

  it("redacts a URL whose query names a credential param only isSecretKey catches (vendor-shaped)", () => {
    // "X-API-Key" is not in the URL-specific extra set at all — only
    // isSecretKey's fuzzy vendor-prefix matching catches it.
    expect(urlAfter(`https://mcp.example.com/sse?X-API-Key=${TOKEN}`)).toBe(REDACTED);
  });

  it("redacts a presigned AWS URL (vendor-PREFIXED credential params)", () => {
    // A presigned S3 URL is a complete, working credential in a link. Its
    // parameters are vendor-prefixed — "X-Amz-Credential" normalizes to
    // "xamzcredential" and "X-Amz-Signature" to "xamzsignature", which match
    // nothing in the URL-specific extra set and nothing in isSecretKey either —
    // so this whole URL used to be stored verbatim under an `url:` key.
    const presigned =
      "https://my-bucket.s3.eu-central-1.amazonaws.com/artifacts/mcp.tar.gz" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260902%2Feu-central-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20260902T101500Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host" +
      `&X-Amz-Signature=${TOKEN}`;
    expect(urlAfter(presigned)).toBe(REDACTED);

    // Each of the three stems is enough on its own.
    for (const param of ["X-Amz-Credential", "X-Amz-Signature", "X-Amz-Security-Token"]) {
      expect({ param, url: urlAfter(`https://s3.example.com/o?${param}=${TOKEN}`) }).toEqual({
        param,
        url: REDACTED,
      });
    }
  });

  it("redacts a credential param whose NAME is percent-encoded", () => {
    // `?api%5Fkey=…` is `?api_key=…` as far as the server is concerned; only the
    // decoded form is recognizable as a credential name.
    expect(urlAfter(`https://mcp.example.com/sse?api%5Fkey=${TOKEN}`)).toBe(REDACTED);
    expect(urlAfter(`https://mcp.example.com/sse?X-Amz-Credential%2Dv4=${TOKEN}`)).toBe(REDACTED);
    // A malformed escape must not throw — it falls back to the raw name.
    expect(urlAfter(`https://mcp.example.com/sse?%zz=1&signature=${TOKEN}`)).toBe(REDACTED);
    expect(urlAfter("https://mcp.example.com/sse?%zz=1&version=2")).toBe(
      "https://mcp.example.com/sse?%zz=1&version=2",
    );
  });

  it("redacts a credential carried in the URL FRAGMENT, not just the query", () => {
    expect(urlAfter(`https://mcp.example.com/callback#access_token=${TOKEN}`)).toBe(REDACTED);
    // A fragment credential must be caught even when the query itself is benign.
    expect(urlAfter(`https://mcp.example.com/callback?state=abc#access_token=${TOKEN}`)).toBe(
      REDACTED,
    );
  });

  it("leaves ordinary query-only URLs alone (regression: no false positives)", () => {
    for (const url of [
      "https://api.example.com/v1?version=2&format=json",
      "http://localhost:8000",
      "https://mcp.x/sse?transport=sse",
    ]) {
      expect(urlAfter(url)).toBe(url);
    }
  });

  it("reports the redaction as a credential-bearing URL", () => {
    const { found } = sanitizer.sanitizeJson(
      { url: `https://mcp.example.com/sse?api_key=${TOKEN}` },
      "claude",
      ".claude.json#mcpServers.remote",
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("value");
    expect(found[0]!.key).toBe("url");
    expect(found[0]!.description).toContain("credential-bearing URL");
    // Metadata only: the SecretRef never carries the value.
    expect(JSON.stringify(found)).not.toContain(TOKEN);
  });
});

describe("sanitizer: env/environment/headers containers (E2E leak regression)", () => {
  // Found by a live end-to-end push: an opencode MCP env var named just "KEY"
  // (no api/token/secret stem, opaque value) sailed through the JSON pass while
  // codex's TOML pass would have caught it via its env-container rule. The JSON
  // pass now applies the same rule: EVERY leaf under env/environment/headers is
  // secret, whatever its name.
  it("redacts an arbitrarily-named env var (bare KEY) under an MCP environment map", () => {
    const blob = JSON.stringify(
      { mcp: { w: { environment: { KEY: "FAKE_OPENCODE_KEY_jkl" } } } },
      null,
      2,
    );
    const res = sanitizer.sanitizeFile(blob, "opencode", "opencode.json");
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain("FAKE_OPENCODE_KEY_jkl");
    expect(res.content).toContain(REDACTED);
  });

  it("redacts vendor-named vars (OPENAI_KEY) and header values too", () => {
    const blob = JSON.stringify(
      {
        mcpServers: {
          s: {
            env: { OPENAI_KEY: "opaque-vendor-key-000111" },
            headers: { "X-Custom-Auth": "opaque-header-cred-222333" },
          },
        },
      },
      null,
      2,
    );
    const res = sanitizer.sanitizeFile(blob, "cursor", "mcp.json");
    expect(res.content).not.toContain("opaque-vendor-key-000111");
    expect(res.content).not.toContain("opaque-header-cred-222333");
  });

  it("keeps switches under env (settings.json feature flags)", () => {
    // `{{REDACTED}}` in place of "1" switches a feature off on every machine
    // that pulls; a switch is never a credential.
    const env = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", DISABLE_TELEMETRY: "true", DEBUG: false, LEVEL: 3 };
    const res = sanitizer.sanitizeFile(JSON.stringify({ env }, null, 2), "claude", "settings.json");
    expect(JSON.parse(res.content).env).toEqual(env);
  });

  it("still redacts multi-digit numbers under env: they may be one-time codes", () => {
    // AUTH_CODE / OTP / MFA_CODE carry live codes under names no list knows.
    const env = { AUTH_CODE: "123456", OTP: 4711, MCP_TIMEOUT: "60000" };
    const res = sanitizer.sanitizeFile(JSON.stringify({ env }, null, 2), "claude", "settings.json");
    expect(JSON.parse(res.content).env).toEqual({ AUTH_CODE: REDACTED, OTP: REDACTED, MCP_TIMEOUT: REDACTED });
  });

  it("still redacts flag-shaped values under a secret NAME, and long digit strings", () => {
    const blob = JSON.stringify(
      { env: { DB_PASSWORD: "123456", ACCOUNT_NUMBER: "123456789012", ENABLE_X: "1" } },
      null,
      2,
    );
    const env = JSON.parse(sanitizer.sanitizeFile(blob, "claude", "settings.json").content).env;
    expect(env).toEqual({ DB_PASSWORD: REDACTED, ACCOUNT_NUMBER: REDACTED, ENABLE_X: "1" });
  });

  it("keeps blanket redaction under headers, even for flag-shaped values", () => {
    const blob = JSON.stringify(
      { mcpServers: { s: { headers: { "X-Custom-Auth": "123456", "X-Debug": "true" }, env: { DEBUG: "1" } } } },
      null,
      2,
    );
    const out = JSON.parse(sanitizer.sanitizeFile(blob, "claude", "mcp.json").content).mcpServers.s;
    expect(out.headers).toEqual({ "X-Custom-Auth": REDACTED, "X-Debug": REDACTED });
    expect(out.env).toEqual({ DEBUG: "1" });
  });

  it("treats everything below a secret-named key as a credential, as the TOML pass does", () => {
    const blob = JSON.stringify({ env: { DB_PASSWORD: { value: "1" } } }, null, 2);
    const out = JSON.parse(sanitizer.sanitizeFile(blob, "claude", "mcp.json").content);
    expect(out.env.DB_PASSWORD).toEqual({ value: REDACTED });
  });

  it("keeps an MCP server whose NAME contains a secret stem (an identifier, not a secret)", () => {
    const servers = { "token-optimizer": { command: "npx", args: ["-y", "token-optimizer-mcp"] } };
    const blob = JSON.stringify({ mcpServers: servers }, null, 2);
    expect(JSON.parse(sanitizer.sanitizeFile(blob, "claude", "mcp.json").content).mcpServers).toEqual(servers);
  });

  it("treats objects under secret names as credentials at every level, like the TOML pass", () => {
    const blob = JSON.stringify({ credentials: { pass: "x1" }, auth: { value: "opaque" } }, null, 2);
    const out = JSON.parse(sanitizer.sanitizeFile(blob, "claude", "x.json").content);
    expect(out).toEqual({ credentials: { pass: REDACTED }, auth: { value: REDACTED } });
  });

  it("keeps entry names of plugin and marketplace maps (identifiers, not secrets)", () => {
    const settings = {
      enabledPlugins: { "token-optimizer@market": true },
      extraKnownMarketplaces: { "secret-tools": { source: { source: "github", repo: "acme/secret-tools" } } },
    };
    const res = sanitizer.sanitizeFile(JSON.stringify(settings, null, 2), "claude", "settings.json");
    expect(JSON.parse(res.content)).toEqual(settings);
  });

  it("keeps flags whose name merely ends in BYPASS", () => {
    const env = { CLAUDE_BYPASS: "1", ENABLE_BYPASS: "true" };
    const res = sanitizer.sanitizeFile(JSON.stringify({ env }, null, 2), "claude", "settings.json");
    expect(JSON.parse(res.content).env).toEqual(env);
  });

  it("still redacts numeric passwords and PINs under names isSecretKey does not know", () => {
    const env = { PGPASSWORD: "123456", MYSQL_PWD: "4711", DB_PASS: "2024", YUBIKEY_PIN: 123456 };
    const blob = JSON.stringify({ mcpServers: { db: { env } } }, null, 2);
    const out = JSON.parse(sanitizer.sanitizeFile(blob, "claude", "mcp.json").content);
    expect(out.mcpServers.db.env).toEqual({
      PGPASSWORD: REDACTED,
      MYSQL_PWD: REDACTED,
      DB_PASS: REDACTED,
      YUBIKEY_PIN: REDACTED,
    });
  });

  it("isSecretKey catches separator-suffixed *_key / *-key names anywhere", () => {
    expect(isSecretKey("OPENAI_KEY")).toBe(true);
    expect(isSecretKey("deepl-key")).toBe(true);
    expect(isSecretKey("service_key")).toBe(true);
  });

  it("does NOT treat bare 'key' as secret outside containers — keybindings survive", () => {
    expect(isSecretKey("key")).toBe(false);
    expect(isSecretKey("monkey")).toBe(false);
    expect(isSecretKey("keybindings")).toBe(false);

    const keybindings = JSON.stringify(
      [{ key: "cmd+k", command: "workbench.action.terminal.clear" }],
      null,
      2,
    );
    const res = sanitizer.sanitizeFile(keybindings, "cursor", "keybindings.json");
    expect(res.content).toContain("cmd+k");
    expect(res.content).not.toContain(REDACTED);
  });

  it("does not misread dotted VS Code settings keys as containers", () => {
    // "terminal.integrated.env.osx" is ONE key (not an env container); its
    // object value is a real env map though — but only once a key literally
    // named env/environment/headers introduces it.
    const settings = JSON.stringify(
      { "editor.fontSize": 14, "workbench.colorTheme": "Dark" },
      null,
      2,
    );
    const res = sanitizer.sanitizeFile(settings, "cursor", "settings.json");
    expect(res.changed).toBe(false);
  });
});
