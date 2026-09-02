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
