import { describe, expect, it } from "vitest";
import {
  describeMissingSecret,
  hasMarker,
  isRedactedFormOf,
  markerPaths,
  matchesWithSecrets,
  secretBlindText,
  wildcardMatch,
  mergeRedacted,
  mergeRedactedText,
  parseStructured,
  scopeOf,
  repairRedacted,
  repairRedactedText,
  structuredKind,
  tildify,
} from "../../src/core/placement/redacted.js";
import { REDACTED } from "../../src/core/sanitizer/patterns.js";

const R = REDACTED;

describe("hasMarker", () => {
  it("finds markers deeply and rejects clean values", () => {
    expect(hasMarker(`Bearer ${R}`)).toBe(true);
    expect(hasMarker({ a: [{ b: R }] })).toBe(true);
    expect(hasMarker({ a: ["x", 1, null] })).toBe(false);
    expect(hasMarker(42)).toBe(false);
  });
});

describe("mergeRedacted", () => {
  it("keeps a real local value for a redacted env key", () => {
    const repo = { mcpServers: { u: { command: "x", env: { P: R, Q: "1" } } } };
    const local = { mcpServers: { u: { command: "x", env: { P: "local-value", Q: "1" } } } };
    const r = mergeRedacted(repo, local);
    expect(r.value).toEqual({ mcpServers: { u: { command: "x", env: { P: "local-value", Q: "1" } } } });
    expect(r.unsafe).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("a local marker counts as no value: key omitted, path reported", () => {
    const r = mergeRedacted({ env: { P: R } }, { env: { P: R } });
    expect(r.value).toEqual({ env: {} });
    expect(r.missing).toEqual([["env", "P"]]);
  });

  it("omits only the key; the server object survives", () => {
    const r = mergeRedacted({ s: { env: { P: R } } }, undefined);
    expect(r.value).toEqual({ s: { env: {} } });
    expect(r.missing).toEqual([["s", "env", "P"]]);
  });

  it("treats a partial-string marker as a marker leaf", () => {
    const r = mergeRedacted({ h: `Bearer ${R}` }, { h: "Bearer real" });
    expect(r.value).toEqual({ h: "Bearer real" });
  });

  it("treats an array containing a marker as one leaf", () => {
    const repo = { args: ["--token", R] };
    expect(mergeRedacted(repo, { args: ["--token", "t"] }).value).toEqual({ args: ["--token", "t"] });
    const r = mergeRedacted(repo, {});
    expect(r.value).toEqual({});
    expect(r.missing).toEqual([["args"]]);
  });

  it("keeps clean arrays and scalars and ignores non-object local at object paths", () => {
    const r = mergeRedacted({ a: [1], b: { c: R }, d: true }, { b: "nope" });
    expect(r.value).toEqual({ a: [1], b: {}, d: true });
    expect(r.missing).toEqual([["b", "c"]]);
  });

  it("returns non-object roots untouched", () => {
    expect(mergeRedacted("x", {})).toEqual({ value: "x", missing: [], unsafe: [] });
    expect(mergeRedacted([1], {})).toEqual({ value: [1], missing: [], unsafe: [] });
    expect(mergeRedacted(null, {})).toEqual({ value: null, missing: [], unsafe: [] });
  });
});

describe("structuredKind", () => {
  it("maps extensions", () => {
    expect(structuredKind("/a/b.json")).toBe("json");
    expect(structuredKind("/a/b.JSONC")).toBe("json");
    expect(structuredKind("/a/config.toml")).toBe("toml");
    expect(structuredKind("/a/b.md")).toBeUndefined();
  });
});

describe("mergeRedactedText", () => {
  it("returns the repo text byte-identical when it has no marker", () => {
    const t = '{"a":   1}';
    expect(mergeRedactedText("json", t, '{"a":2}')).toEqual({ text: t, missing: [], unsafe: [] });
    expect(mergeRedactedText("toml", "a  =  1", undefined)).toEqual({ text: "a  =  1", missing: [], unsafe: [] });
  });

  it("merges JSON keeping indent and trailing newline", () => {
    const repo = `{\n    "env": { "P": "${R}" }\n}\n`;
    const out = mergeRedactedText("json", repo, '{"env":{"P":"real"}}');
    expect(out?.text).toBe('{\n    "env": {\n        "P": "real"\n    }\n}\n');
    const noNl = mergeRedactedText("json", `{"env":{"P":"${R}"}}`, undefined);
    expect(noNl?.text.endsWith("\n")).toBe(false);
    expect(noNl?.missing).toEqual([["env", "P"]]);
  });

  it("parses JSONC local text", () => {
    const local = '{\n // c\n "env": {"P": "real",},\n}';
    const out = mergeRedactedText("json", `{"env":{"P":"${R}"}}`, local);
    expect(JSON.parse(out!.text)).toEqual({ env: { P: "real" } });
  });

  it("treats unparseable local text as no local", () => {
    const out = mergeRedactedText("json", `{"k":"${R}"}`, "{nope");
    expect(out?.missing).toEqual([["k"]]);
  });

  it("round-trips TOML keeping the local value", () => {
    const repo = `[mcp_servers.u.env]\nP = "${R}"\nQ = "1"\n`;
    const local = `[mcp_servers.u.env]\nP = "real"\nQ = "1"\n`;
    const out = mergeRedactedText("toml", repo, local);
    expect(out?.text).toContain('P = "real"');
    expect(out?.text).toContain('Q = "1"');
    expect(out?.missing).toEqual([]);
  });

  it("returns undefined when the repo text does not parse or the root is not an object", () => {
    expect(mergeRedactedText("json", `{ ${R}`, undefined)).toBeUndefined();
    expect(mergeRedactedText("toml", `= ${R}`, undefined)).toBeUndefined();
    expect(mergeRedactedText("json", `"${R}"`, undefined)).toBeUndefined();
  });
});

describe("matchesWithSecrets", () => {
  it("matches real values in place of markers", () => {
    expect(matchesWithSecrets(`a=${R};b`, "a=secret;b")).toBe(true);
    expect(matchesWithSecrets("same", "same")).toBe(true);
    expect(matchesWithSecrets("same", "diff")).toBe(false);
  });

  it("rejects mismatches elsewhere", () => {
    expect(matchesWithSecrets(`a=${R};b`, "a=secret;c")).toBe(false);
    expect(matchesWithSecrets(`a=${R};b`, "x=secret;b")).toBe(false);
    expect(matchesWithSecrets(`a${R}b${R}c`, "aXbYd")).toBe(false);
    expect(matchesWithSecrets(`a${R}b${R}c`, "aXQc")).toBe(false);
  });

  it("requires at least one char per marker", () => {
    expect(matchesWithSecrets(`a${R}b`, "ab")).toBe(false);
    expect(matchesWithSecrets(`a${R}${R}b`, "aXb")).toBe(false);
    expect(matchesWithSecrets(`a${R}`, "a")).toBe(false);
  });

  it("rejects a local text that contains the marker", () => {
    expect(matchesWithSecrets(`a=${R}`, `a=${R}`)).toBe(false);
    expect(matchesWithSecrets(`a=${R};b`, `a=x${R};b`)).toBe(false);
  });

  it("rejects a middle segment that would overlap the suffix", () => {
    expect(matchesWithSecrets(`a${R}bc${R}c`, "aXbc")).toBe(false);
  });

  it("handles adjacent markers", () => {
    expect(matchesWithSecrets(`a${R}${R}b`, "aXYb")).toBe(true);
  });

  it("does not backtrack catastrophically on 1000 markers", () => {
    const repo = Array.from({ length: 1000 }, () => "k").join(R);
    const ok = Array.from({ length: 1000 }, () => "k").join("vv");
    const t0 = Date.now();
    expect(matchesWithSecrets(repo, ok)).toBe(true);
    expect(matchesWithSecrets(repo, ok + "z")).toBe(false);
    expect(matchesWithSecrets(repo, "k".repeat(5000) + "x")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("describeMissingSecret", () => {
  it("formats the mcp form", () => {
    expect(
      describeMissingSecret(
        {
          tool: "codex",
          file: "/h/.codex/config.toml",
          keyPath: ["mcp_servers", "unifi-network", "env", "UNIFI_NETWORK_PASSWORD"],
        },
        "/h",
      ),
    ).toBe("codex mcp unifi-network → UNIFI_NETWORK_PASSWORD");
    expect(
      describeMissingSecret(
        {
          tool: "claude",
          file: "/h/.claude.json",
          keyPath: ["projects", "/p", "mcpServers", "s", "headers", "Authorization"],
        },
        "/h",
      ),
    ).toBe("claude mcp s → Authorization");
  });

  it("formats the generic form with the tildified absolute file path", () => {
    expect(
      describeMissingSecret({ tool: "claude", file: "/h/.claude/settings.json", keyPath: ["env", "API_KEY"] }, "/h"),
    ).toBe("claude ~/.claude/settings.json → env.API_KEY");
    expect(
      describeMissingSecret({ tool: "home", file: "/h/.config/x/c.json", keyPath: ["a"] }, "/h"),
    ).toBe("home ~/.config/x/c.json → a");
    expect(
      describeMissingSecret({ tool: "claude", file: "/h/.claude.json", keyPath: ["mcpServers", "s", "command"] }, "/h"),
    ).toBe("claude ~/.claude.json → mcpServers.s.command");
    expect(describeMissingSecret({ tool: "t", file: "/elsewhere/c.json", keyPath: ["a"] }, "/h")).toBe(
      "t /elsewhere/c.json → a",
    );
  });

  it("strips control characters from key segments and paths", () => {
    const esc = "\x1b[31m";
    expect(
      describeMissingSecret(
        { tool: "codex", file: "/h/c.toml", keyPath: ["mcp_servers", `s${esc}\n`, "env", `K\r\n${esc}`] },
        "/h",
      ),
    ).toBe("codex mcp s[31m → K[31m");
    const line = describeMissingSecret(
      { tool: "claude", file: `/h/.claude/a${esc}\n.json`, keyPath: ["env", `X\u0007\nY`] },
      "/h",
    );
    expect(line).toBe("claude ~/.claude/a[31m.json → env.XY");
    expect(line).not.toMatch(/\p{C}/u);
  });
});

describe("repairRedacted", () => {
  it("starts from the local document and keeps local-only keys", () => {
    const local = { model: R, projects: { "/p": { trust_level: "trusted" } }, permissions: { allow: ["Bash(ls)"] } };
    const repo = { model: "o3" };
    expect(repairRedacted(local, repo)).toEqual({
      value: { model: "o3", projects: { "/p": { trust_level: "trusted" } }, permissions: { allow: ["Bash(ls)"] } },
      missing: [],
    });
  });

  it("omits a local marker leaf the repo has no real value for, and reports it", () => {
    const local = { env: { A: R, B: R, C: "real" }, x: 1 };
    const repo = { env: { A: R, C: "other" } };
    expect(repairRedacted(local, repo)).toEqual({
      value: { env: { C: "real" }, x: 1 },
      missing: [["env", "A"], ["env", "B"]],
    });
  });

  it("treats an array containing a marker as one leaf", () => {
    expect(repairRedacted({ args: ["--t", R] }, { args: ["--t", "v"] }).value).toEqual({ args: ["--t", "v"] });
    expect(repairRedacted({ args: ["--t", R] }, { args: ["--t", R] })).toEqual({ value: {}, missing: [["args"]] });
  });

  it("returns a non-object local untouched", () => {
    expect(repairRedacted([R], {})).toEqual({ value: [R], missing: [] });
  });
});

describe("repairRedactedText", () => {
  it("keeps the local JSON indent and trailing newline", () => {
    const local = `{\n    "env": { "S": "${R}" },\n    "permissions": { "allow": [] }\n}`;
    const out = repairRedactedText("json", local, '{"env":{"S":"1"}}');
    expect(out?.text).toBe('{\n    "env": {\n        "S": "1"\n    },\n    "permissions": {\n        "allow": []\n    }\n}');
    expect(repairRedactedText("json", `{"k":"${R}"}\n`, "{nope")).toEqual({ text: "{}\n", missing: [["k"]], unsafe: [] });
  });

  it("round-trips TOML and keeps a local-only table", () => {
    const local = `model = "${R}"\n\n[projects."/home/u/p"]\ntrust_level = "trusted"\n`;
    const out = repairRedactedText("toml", local, 'model = "o3"\n');
    expect(out?.missing).toEqual([]);
    expect(parseStructured("toml", out!.text)).toEqual({ model: "o3", projects: { "/home/u/p": { trust_level: "trusted" } } });
  });

  it("is undefined when the local text does not parse to an object", () => {
    expect(repairRedactedText("json", `{ ${R}`, "{}")).toBeUndefined();
    expect(repairRedactedText("json", `["${R}"]`, "{}")).toBeUndefined();
  });
});

describe("markerPaths", () => {
  it("lists marker leaves with the mergeObject leaf rule", () => {
    expect(markerPaths({ a: { b: R, c: "x" }, d: ["--t", R], e: [1], f: `Bearer ${R}` })).toEqual([
      ["a", "b"],
      ["d"],
      ["f"],
    ]);
    expect(markerPaths("x")).toEqual([]);
    expect(markerPaths([R])).toEqual([]);
  });
});

describe("secretBlindText", () => {
  it("drops the given paths and ignores everything else", () => {
    const a = secretBlindText("json", '{"env":{"K":"real"},"x":1}', [["env", "K"]]);
    const b = secretBlindText("json", `{"x":1,"env":{}}`, [["env", "K"]]);
    expect(JSON.parse(a!)).toEqual({ env: {}, x: 1 });
    expect(JSON.parse(b!)).toEqual({ env: {}, x: 1 });
  });
  it("handles toml, absent paths and non-object intermediates", () => {
    expect(secretBlindText("toml", '[e]\nK = "v"\n', [["e", "K"]])).toBe('{"e":{}}');
    expect(secretBlindText("json", '{"e":"s"}', [["e", "K"], ["zz", "y"]])).toBe('{"e":"s"}');
  });
  it("is undefined for unparseable or non-object text", () => {
    expect(secretBlindText("json", "{nope", [["a"]])).toBeUndefined();
    expect(secretBlindText("json", "[1]", [["a"]])).toBeUndefined();
  });
  it("does not mutate shared structure between calls", () => {
    const text = '{"a":{"b":1,"c":2}}';
    secretBlindText("json", text, [["a", "b"]]);
    expect(secretBlindText("json", text, [])).toBe('{"a":{"b":1,"c":2}}');
  });
});

describe("wildcardMatch / isRedactedFormOf", () => {
  it("treats pattern markers as >=1 char wildcards", () => {
    expect(wildcardMatch(`a${R}c`, "abc")).toBe(true);
    expect(wildcardMatch(`a${R}c`, "ac")).toBe(false);
  });
  it("isRedactedFormOf needs a local marker and an exact wildcard match", () => {
    expect(isRedactedFormOf(`T=${R}\nx`, "T=abc\nx")).toBe(true);
    expect(isRedactedFormOf("T=abc", "T=abc")).toBe(false);
    expect(isRedactedFormOf(`note ${R} edited`, "old")).toBe(false);
    expect(isRedactedFormOf(`T=${R}`, `T=${R}`)).toBe(true);
  });
  it("a marker never stands for more than one line", () => {
    expect(isRedactedFormOf(`note: ${R}`, "note: abc\nmore\nlines\n")).toBe(false);
    expect(isRedactedFormOf(`a ${R} b\nc`, "a x\ny b\nc")).toBe(false);
    expect(isRedactedFormOf(`a ${R} b\nc ${R}`, "a x b\nc y")).toBe(true);
    expect(matchesWithSecrets(`K=${R}\n`, "K=line1\nline2\n")).toBe(false);
    expect(wildcardMatch(`${R}\n`, "\n\n")).toBe(false);
  });
});

describe("mergeRedacted: binding keys", () => {
  const local = { mcpServers: { s: { command: "good", args: ["a"], env: { T: "real" } } } };

  it("reports unsafe paths and reuses nothing when command, args or url differ", () => {
    for (const changed of [{ command: "evil" }, { args: ["b"] }, { url: "https://evil.example" }]) {
      const repo = { mcpServers: { s: { command: "good", args: ["a"], ...changed, env: { T: R } } } };
      const r = mergeRedacted(repo, local);
      expect(r.unsafe).toEqual([["mcpServers", "s", "env", "T"]]);
      expect(JSON.stringify(r.value)).not.toContain("real");
    }
  });

  it("is safe when nothing is reused, even if a binding key differs", () => {
    const r = mergeRedacted(
      { mcpServers: { s: { command: "evil", env: { T: R } } } },
      { mcpServers: { s: { command: "good" } } },
    );
    expect(r.unsafe).toEqual([]);
    expect(r.missing).toEqual([["mcpServers", "s", "env", "T"]]);
  });

  it("reuses the local value when binding keys are deep-equal", () => {
    const r = mergeRedacted({ mcpServers: { s: { command: "good", args: ["a"], env: { T: R } } } }, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual(local);
  });

  it("mergeRedactedText carries unsafe through", () => {
    const text = JSON.stringify({ mcpServers: { s: { command: "evil", env: { T: R } } } });
    expect(mergeRedactedText("json", text, JSON.stringify(local))?.unsafe).toEqual([["mcpServers", "s", "env", "T"]]);
  });
});

describe("mergeRedacted: scope must be unchanged", () => {
  const unsafeOf = (repo: unknown, local: unknown) => {
    const r = mergeRedacted(repo, local);
    expect(JSON.stringify(r.value)).not.toContain("real");
    return r.unsafe;
  };

  it("a changed env.API_BASE_URL next to a redacted env.TOKEN is unsafe", () => {
    const local = { mcpServers: { s: { command: "c", env: { API_BASE_URL: "https://good.example", TOKEN: "real" } } } };
    const repo = { mcpServers: { s: { command: "c", env: { API_BASE_URL: "https://evil.example", TOKEN: R } } } };
    expect(unsafeOf(repo, local)).toEqual([["mcpServers", "s", "env", "TOKEN"]]);
  });

  it("a new repo-side env.HTTPS_PROXY is unsafe", () => {
    const local = { mcpServers: { s: { command: "c", env: { TOKEN: "real" } } } };
    const repo = { mcpServers: { s: { command: "c", env: { TOKEN: R, HTTPS_PROXY: "http://evil.example" } } } };
    expect(unsafeOf(repo, local)).toEqual([["mcpServers", "s", "env", "TOKEN"]]);
  });

  it("a changed cwd is unsafe", () => {
    const local = { mcpServers: { s: { command: "c", cwd: "/good", env: { TOKEN: "real" } } } };
    const repo = { mcpServers: { s: { command: "c", cwd: "/evil", env: { TOKEN: R } } } };
    expect(unsafeOf(repo, local)).toEqual([["mcpServers", "s", "env", "TOKEN"]]);
  });

  it("a local-only key counts as a change", () => {
    const local = { mcpServers: { s: { command: "c", cwd: "/x", env: { TOKEN: "real" } } } };
    const repo = { mcpServers: { s: { command: "c", env: { TOKEN: R } } } };
    expect(unsafeOf(repo, local)).toEqual([["mcpServers", "s", "env", "TOKEN"]]);
  });

  it("a codex model_providers entry with a changed base_url next to a redacted api_key is unsafe", () => {
    const local = { model_providers: { x: { base_url: "https://good.example", api_key: "real" } } };
    const repo = { model_providers: { x: { base_url: "https://evil.example", api_key: R } } };
    expect(unsafeOf(repo, local)).toEqual([["model_providers", "x", "api_key"]]);
  });

  it("settings.json env with a changed ANTHROPIC_BASE_URL next to a redacted ANTHROPIC_API_KEY is unsafe", () => {
    const local = { env: { ANTHROPIC_BASE_URL: "https://good.example", ANTHROPIC_API_KEY: "real" } };
    const repo = { env: { ANTHROPIC_BASE_URL: "https://evil.example", ANTHROPIC_API_KEY: R } };
    expect(unsafeOf(repo, local)).toEqual([["env", "ANTHROPIC_API_KEY"]]);
  });

  it("an unchanged server (only the marker differs) reuses the real value", () => {
    const local = { mcpServers: { s: { command: "c", env: { A: "1", TOKEN: "real" } } } };
    const repo = { mcpServers: { s: { command: "c", env: { A: "1", TOKEN: R } } } };
    const r = mergeRedacted(repo, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual(local);
  });

  it("an unchanged server with the marker inside args reuses the local args", () => {
    const local = { mcpServers: { s: { command: "c", args: ["--token", "real"] } } };
    const repo = { mcpServers: { s: { command: "c", args: ["--token", R] } } };
    const r = mergeRedacted(repo, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual(local);
  });

  it("a change outside the scope does not block reuse", () => {
    const local = { mcpServers: { s: { command: "c", env: { T: "real" } }, o: { command: "old" } }, theme: "a" };
    const repo = { mcpServers: { s: { command: "c", env: { T: R } }, o: { command: "new" } }, theme: "b" };
    const r = mergeRedacted(repo, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual({ mcpServers: { s: { command: "c", env: { T: "real" } }, o: { command: "new" } }, theme: "b" });
  });

  it("a changed top-level settings key does not block an unchanged env", () => {
    const r = mergeRedacted({ model: "b", env: { K: R } }, { model: "a", env: { K: "real" } });
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual({ model: "b", env: { K: "real" } });
  });

  it("key order differences do not count as a change", () => {
    const local = { mcpServers: { s: { env: { B: "2", TOKEN: "real" }, command: "c" } } };
    const repo = { mcpServers: { s: { command: "c", env: { TOKEN: R, B: "2" } } } };
    expect(mergeRedacted(repo, local).unsafe).toEqual([]);
  });

  it("a server under an unrecognised map with a changed command is unsafe", () => {
    const local = { context_servers: { x: { command: "good", env: { TOKEN: "real" } } } };
    const repo = { context_servers: { x: { command: "evil", env: { TOKEN: R } } } };
    expect(unsafeOf(repo, local)).toEqual([["context_servers", "x", "env", "TOKEN"]]);
  });

  it("a changed base_url outside any known entry next to a redacted api_key is unsafe", () => {
    const local = { provider: { base_url: "https://good.example", api_key: "real" } };
    const repo = { provider: { base_url: "https://evil.example", api_key: R } };
    expect(unsafeOf(repo, local)).toEqual([["provider", "api_key"]]);
  });

  it("an unchanged server under an unrecognised map still reuses the value", () => {
    const local = { context_servers: { x: { command: "c", env: { TOKEN: "real" } } } };
    const repo = { context_servers: { x: { command: "c", env: { TOKEN: R } } } };
    const r = mergeRedacted(repo, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual(local);
  });

  it("a settings-style top-level env with only the marker differing reuses the value while other keys change", () => {
    const r = mergeRedacted(
      { model: "b", theme: "t2", env: { A: "1", K: R } },
      { model: "a", theme: "t1", env: { A: "1", K: "real" } },
    );
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual({ model: "b", theme: "t2", env: { A: "1", K: "real" } });
  });

  it("a missing local object at a required level means no reuse", () => {
    const repo = { context_servers: { x: { command: "c", env: { TOKEN: R } } } };
    expect(mergeRedacted(repo, { other: 1 }).missing).toEqual([["context_servers", "x", "env", "TOKEN"]]);
  });

  it("rootIsEntry makes a bare server definition the scope", () => {
    const local = { command: "c", cwd: "/good", env: { T: "real" } };
    const repo = { command: "c", cwd: "/evil", env: { T: R } };
    expect(mergeRedacted(repo, local, { rootIsEntry: true }).unsafe).toEqual([["env", "T"]]);
    // Without rootIsEntry the root is a document: only the [env] scope applies.
    expect(mergeRedacted(repo, local).unsafe).toEqual([]);
    const plain = { mode: "a", env: { T: R } };
    expect(mergeRedacted(plain, { mode: "b", env: { T: "real" } }).unsafe).toEqual([]);
    expect(mergeRedacted(plain, { mode: "b", env: { T: "real" } }, { rootIsEntry: true }).unsafe).toEqual([["env", "T"]]);
  });

  it("a nested config.servers.y.token inside mcpServers.x is scoped to x, not y", () => {
    const local = { mcpServers: { x: { command: "good", config: { servers: { y: { token: "real" } } } } } };
    const repo = { mcpServers: { x: { command: "evil", config: { servers: { y: { token: R } } } } } };
    expect(unsafeOf(repo, local)).toEqual([["mcpServers", "x", "config", "servers", "y", "token"]]);
  });

  it("an unknown endpoint key (host) changed in an unrecognised map is unsafe", () => {
    const local = { context_servers: { x: { host: "good.example", env: { TOKEN: "real" } } } };
    const repo = { context_servers: { x: { host: "evil.example", env: { TOKEN: R } } } };
    expect(unsafeOf(repo, local)).toEqual([["context_servers", "x", "env", "TOKEN"]]);
  });

  it("an unchanged context_servers.x with a changed sibling z is unsafe (coarse top-level fallback)", () => {
    const local = { context_servers: { x: { command: "c", env: { TOKEN: "real" } }, z: { command: "old" } } };
    const repo = { context_servers: { x: { command: "c", env: { TOKEN: R } }, z: { command: "new" } } };
    expect(unsafeOf(repo, local)).toEqual([["context_servers", "x", "env", "TOKEN"]]);
  });

  it("mcp.servers.x (VS Code shape) reuses when only the marker differs, and is unsafe when x.uri changes", () => {
    const local = { mcp: { servers: { x: { uri: "https://good.example", headers: { A: "real" } }, z: { uri: "old" } } } };
    const same = { mcp: { servers: { x: { uri: "https://good.example", headers: { A: R } }, z: { uri: "new" } } } };
    const r = mergeRedacted(same, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual({ mcp: { servers: { x: { uri: "https://good.example", headers: { A: "real" } }, z: { uri: "new" } } } });
    const moved = { mcp: { servers: { x: { uri: "https://evil.example", headers: { A: R } } } } };
    expect(unsafeOf(moved, local)).toEqual([["mcp", "servers", "x", "headers", "A"]]);
  });

  it("profiles.p.api_key with a changed profiles.p.base_url is unsafe", () => {
    const local = { profiles: { p: { base_url: "https://good.example", api_key: "real" } } };
    const repo = { profiles: { p: { base_url: "https://evil.example", api_key: R } } };
    expect(unsafeOf(repo, local)).toEqual([["profiles", "p", "api_key"]]);
  });

  it("a top-level apiKey is scoped to the whole document", () => {
    const local = { apiKey: "real", theme: "a" };
    expect(unsafeOf({ apiKey: R, theme: "b" }, local)).toEqual([["apiKey"]]);
    const r = mergeRedacted({ apiKey: R, theme: "a" }, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual(local);
  });
});

describe("scopeOf", () => {
  it("rootIsEntry makes the whole object the scope", () => {
    expect(scopeOf(["env", "T"], true)).toEqual([]);
    expect(scopeOf(["mcpServers", "x", "env", "T"], true)).toEqual([]);
  });

  it("a leaf under an anchored entry map is scoped to its entry", () => {
    expect(scopeOf(["mcpServers", "x", "env", "T"])).toEqual(["mcpServers", "x"]);
    expect(scopeOf(["model_providers", "p", "api_key"])).toEqual(["model_providers", "p"]);
    expect(scopeOf(["profiles", "p", "api_key"])).toEqual(["profiles", "p"]);
  });

  it("the longest matching map wins", () => {
    expect(scopeOf(["mcp", "servers", "x", "uri", "k"])).toEqual(["mcp", "servers", "x"]);
    expect(scopeOf(["mcp", "other", "k"])).toEqual(["mcp", "other"]);
  });

  it("an entry map not anchored at the root is ignored", () => {
    expect(scopeOf(["mcpServers", "x", "config", "servers", "y", "t"])).toEqual(["mcpServers", "x"]);
    expect(scopeOf(["a", "servers", "x", "t"])).toEqual(["a"]);
  });

  it("an unknown map, or a leaf directly in a map, falls back to the top-level subtree", () => {
    expect(scopeOf(["context_servers", "x", "env", "T"])).toEqual(["context_servers"]);
    expect(scopeOf(["env", "K"])).toEqual(["env"]);
    expect(scopeOf(["mcpServers", "x"])).toEqual(["mcpServers"]);
  });

  it("a top-level leaf is scoped to the whole document", () => {
    expect(scopeOf(["apiKey"])).toEqual([]);
  });
});

describe("tildify", () => {
  it("shows a Windows home as ~ with forward slashes", () => {
    expect(tildify("C:\\Users\\u\\.claude\\settings.json", "C:\\Users\\u")).toBe("~/.claude/settings.json");
    expect(tildify("C:\\Users\\u", "C:\\Users\\u")).toBe("~");
    expect(tildify("/home/u/.claude/a.md", "/home/u")).toBe("~/.claude/a.md");
  });
});
