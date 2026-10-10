import { describe, expect, it } from "vitest";
import {
  describeMissingSecret,
  hasMarker,
  matchesWithSecrets,
  mergeRedacted,
  mergeRedactedText,
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
    const local = { mcpServers: { u: { env: { P: "local-value" } } } };
    const r = mergeRedacted(repo, local);
    expect(r.value).toEqual({ mcpServers: { u: { command: "x", env: { P: "local-value", Q: "1" } } } });
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
    expect(mergeRedacted("x", {})).toEqual({ value: "x", missing: [] });
    expect(mergeRedacted([1], {})).toEqual({ value: [1], missing: [] });
    expect(mergeRedacted(null, {})).toEqual({ value: null, missing: [] });
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
    expect(mergeRedactedText("json", t, '{"a":2}')).toEqual({ text: t, missing: [] });
    expect(mergeRedactedText("toml", "a  =  1", undefined)).toEqual({ text: "a  =  1", missing: [] });
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
      describeMissingSecret({
        tool: "codex",
        file: "/h/.codex/config.toml",
        keyPath: ["mcp_servers", "unifi-network", "env", "UNIFI_NETWORK_PASSWORD"],
      }),
    ).toBe("codex mcp unifi-network → UNIFI_NETWORK_PASSWORD");
    expect(
      describeMissingSecret({
        tool: "claude",
        file: "/h/.claude.json",
        keyPath: ["projects", "/p", "mcpServers", "s", "headers", "Authorization"],
      }),
    ).toBe("claude mcp s → Authorization");
  });

  it("formats the generic form relative to the tool home", () => {
    expect(
      describeMissingSecret({ tool: "claude", file: "/h/.claude/settings.json", keyPath: ["env", "API_KEY"] }),
    ).toBe("claude settings.json → env.API_KEY");
    expect(
      describeMissingSecret({ tool: "claude", file: "/h/.claude/sub/x.json", keyPath: ["a"] }),
    ).toBe("claude sub/x.json → a");
    expect(
      describeMissingSecret({ tool: "claude", file: "/h/.claude.json", keyPath: ["mcpServers", "s", "command"] }),
    ).toBe("claude .claude.json → mcpServers.s.command");
  });
});
