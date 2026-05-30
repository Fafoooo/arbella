/**
 * Unit tests for the TemplaterService (src/core/templater).
 *
 * Core guarantee: a machine path folds to a {{TOKEN}} on capture (toTemplate) and
 * expands back to the exact same path on restore (fromTemplate) — a round-trip —
 * for darwin, linux, AND win32 value shapes. We also assert the cross-OS matching
 * subtlety: a win32 home written with forward slashes or JSON-doubled backslashes
 * still collapses to the same token.
 */

import { describe, it, expect } from "vitest";

import { createTemplater } from "../../src/core/templater/index.js";
import { makeVariables } from "../../src/core/templater/variables.js";
import type { OS } from "../../src/types.js";

const templater = createTemplater();

/**
 * One concrete machine identity per OS, expressed the way that OS writes paths.
 * `sep` is the separator the OS natively uses INSIDE a path so the round-trip
 * fixtures stay consistent-style (which is how real tools serialize a single
 * path value — never mixing "\" and "/" within one path).
 */
const CASES: Array<{
  os: OS;
  home: string;
  user: string;
  toolHome: string;
  sep: string;
}> = [
  { os: "darwin", home: "/Users/fab", user: "fab", toolHome: "/Users/fab/.claude", sep: "/" },
  { os: "linux", home: "/home/fab", user: "fab", toolHome: "/home/fab/.codex", sep: "/" },
  { os: "win32", home: "C:\\Users\\fab", user: "fab", toolHome: "C:\\Users\\fab\\.claude", sep: "\\" },
];

describe("templater: HOME round-trip across OSes", () => {
  for (const c of CASES) {
    it(`folds and restores a ${c.os} home path`, () => {
      const vars = makeVariables(c.home, c.user, c.os);
      const original =
        `config points at ${c.home}${c.sep}settings.json next to ${c.home}${c.sep}CLAUDE.md`;

      const templated = templater.toTemplate(original, vars);
      // The machine home is gone, replaced by the {{HOME}} token.
      expect(templated).toContain("{{HOME}}");
      expect(templated).not.toContain(c.home);
      // Round-trip restores the exact original text.
      const restored = templater.fromTemplate(templated, vars);
      expect(restored).toBe(original);
    });
  }
});

describe("templater: TOOL_HOME is preferred over HOME (most-specific first)", () => {
  it("collapses the tool home to {{TOOL_HOME}}, not {{HOME}}/.claude", () => {
    const c = CASES[0]!; // darwin
    const vars = makeVariables(c.home, c.user, c.os, c.toolHome);
    const original = `skills live in ${c.toolHome}/skills`;

    const templated = templater.toTemplate(original, vars);
    expect(templated).toContain("{{TOOL_HOME}}");
    // Crucially NOT the naive "{{HOME}}/.claude".
    expect(templated).not.toContain("{{HOME}}/.claude");
    expect(templater.fromTemplate(templated, vars)).toBe(original);
  });
});

describe("templater: cross-OS separator variants collapse to one token", () => {
  const winVars = makeVariables("C:\\Users\\fab", "fab", "win32");

  it("matches a native backslash win32 path", () => {
    const out = templater.toTemplate("path C:\\Users\\fab\\settings.json", winVars);
    expect(out).toContain("{{HOME}}");
    expect(out).not.toMatch(/C:\\Users\\fab/);
  });

  it("matches a forward-slash win32 path (tools that normalize separators)", () => {
    const out = templater.toTemplate("path C:/Users/fab/settings.json", winVars);
    expect(out).toContain("{{HOME}}");
    expect(out).not.toContain("C:/Users/fab");
  });

  it("matches a JSON-escaped (doubled backslash) win32 path", () => {
    // As it would appear embedded inside a JSON string literal.
    const json = 'C:\\\\Users\\\\fab\\\\settings.json';
    const out = templater.toTemplate(json, winVars);
    expect(out).toContain("{{HOME}}");
    expect(out).not.toContain("C:\\\\Users\\\\fab");
  });
});

describe("templater: win32 EXACT round-trip for all 3 separator variants", () => {
  const winVars = makeVariables("C:\\Users\\fab", "fab", "win32", "C:\\Users\\fab\\.claude");

  // The three documented ways a win32 home appears in captured text. Each is
  // CONSISTENT-style (real tools never mix "\" and "/" inside one path value).
  const variants: Array<{ name: string; value: string }> = [
    { name: "native backslash", value: "C:\\Users\\fab\\.claude\\hooks\\run.py" },
    { name: "JSON-doubled backslash", value: "C:\\\\Users\\\\fab\\\\.claude\\\\hooks\\\\run.py" },
    { name: "forward slash", value: "C:/Users/fab/.claude/hooks/run.py" },
  ];

  for (const v of variants) {
    it(`round-trips a ${v.name} path exactly`, () => {
      const templated = templater.toTemplate(v.value, winVars);
      expect(templated).toContain("{{TOOL_HOME}}"); // folded to the tightest token
      const restored = templater.fromTemplate(templated, winVars);
      expect(restored).toBe(v.value); // byte-exact
    });
  }

  it("produces VALID JSON after a real settings.json round-trip (the bug)", () => {
    // A realistic Claude settings.json value with JSON-doubled backslashes.
    const original = JSON.stringify({
      hooks: { PreToolUse: "C:\\Users\\fab\\.claude\\hooks\\run.py" },
    });
    const folded = templater.toTemplate(original, winVars);
    const restored = templater.fromTemplate(folded, winVars);
    expect(restored).toBe(original);
    // The previously-broken output (single-backslash prefix + doubled tail) was
    // INVALID JSON; this must now parse cleanly.
    expect(() => JSON.parse(restored)).not.toThrow();
  });

  it("round-trips a TOML config value with a doubled-backslash tail", () => {
    const toml = 'run = "C:\\\\Users\\\\fab\\\\.codex\\\\mcp\\\\search.js"';
    const winTomlVars = makeVariables("C:\\Users\\fab", "fab", "win32", "C:\\Users\\fab\\.codex");
    const folded = templater.toTemplate(toml, winTomlVars);
    expect(folded).toContain("{{TOOL_HOME}}");
    expect(templater.fromTemplate(folded, winTomlVars)).toBe(toml);
  });
});

describe("templater: win32 drive-letter case-insensitive HOME folding", () => {
  const winVars = makeVariables("C:\\Users\\fab", "fab", "win32");

  it("folds a lowercase-drive path against an uppercase-drive HOME var", () => {
    // os.homedir() may report "C:" while a tool stored "c:" — both must fold.
    const out = templater.toTemplate("c:\\Users\\fab\\settings.json", winVars);
    expect(out).toContain("{{HOME}}");
    // The machine home structure (drive + Users + path) collapsed away.
    expect(out.toLowerCase()).not.toContain("users\\fab");
  });

  it("still folds the matching uppercase-drive path", () => {
    const out = templater.toTemplate("C:\\Users\\fab\\settings.json", winVars);
    expect(out).toContain("{{HOME}}");
  });
});

describe("templater: scalar (USER) safety", () => {
  it("folds a standalone username but not a username embedded in a larger word", () => {
    const vars = makeVariables("/home/al", "al", "linux");
    // "also" contains "al" but must NOT be rewritten; the standalone "al" should be.
    const original = "user al also owns /home/al";
    const out = templater.toTemplate(original, vars);
    // The home path collapsed to {{HOME}} (longer value applied first)...
    expect(out).toContain("{{HOME}}");
    // ...the word "also" is untouched...
    expect(out).toContain("also");
    // ...and round-trip is exact.
    expect(templater.fromTemplate(out, vars)).toBe(original);
  });
});

describe("templater: OS enum is metadata, never folded on capture", () => {
  it("does not rewrite the substring matching the OS value", () => {
    const vars = makeVariables("/home/fab", "fab", "linux");
    const text = "this linux note mentions linux deliberately";
    // toTemplate must NOT replace "linux" (it is descriptive, not a machine path).
    expect(templater.toTemplate(text, vars)).toBe(text);
    // fromTemplate still expands an explicit {{OS}} token for anyone who used it.
    expect(templater.fromTemplate("os={{OS}}", vars)).toBe("os=linux");
  });
});
