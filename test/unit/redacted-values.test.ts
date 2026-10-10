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
  repairRedacted,
  repairRedactedText,
  structuredKind,
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
    const local = { mcpServers: { u: { command: "x", env: { P: "local-value" } } } };
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
    const local = `[mcp_servers.u.env]\nP = "real"\n`;
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
  const local = { s: { command: "good", args: ["a"], env: { T: "real" } } };

  it("reports unsafe paths and reuses nothing when command, args or url differ", () => {
    for (const changed of [{ command: "evil" }, { args: ["b"] }, { url: "https://evil.example" }]) {
      const repo = { s: { command: "good", args: ["a"], ...changed, env: { T: R } } };
      const r = mergeRedacted(repo, local);
      expect(r.unsafe).toEqual([["s", "env", "T"]]);
      expect(JSON.stringify(r.value)).not.toContain("real");
    }
  });

  it("is safe when nothing is reused, even if a binding key differs", () => {
    const r = mergeRedacted({ s: { command: "evil", env: { T: R } } }, { s: { command: "good" } });
    expect(r.unsafe).toEqual([]);
    expect(r.missing).toEqual([["s", "env", "T"]]);
  });

  it("reuses the local value when binding keys are deep-equal", () => {
    const r = mergeRedacted({ s: { command: "good", args: ["a"], env: { T: R } } }, local);
    expect(r.unsafe).toEqual([]);
    expect(r.value).toEqual(local);
  });

  it("mergeRedactedText carries unsafe through", () => {
    const text = JSON.stringify({ s: { command: "evil", env: { T: R } } });
    expect(mergeRedactedText("json", text, JSON.stringify(local))?.unsafe).toEqual([["s", "env", "T"]]);
  });
});
