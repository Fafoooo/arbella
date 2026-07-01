/**
 * Unit tests for decodeForCapture — the text-vs-binary classifier that keeps
 * UTF-16 configs on the sanitized TEXT path (the security fix) without ever
 * decoding lossily (the odd-length data-loss regression from PR review).
 */

import { describe, expect, it } from "vitest";

import { decodeForCapture } from "../../src/utils/capture-bytes.js";

describe("decodeForCapture: text detection", () => {
  it("decodes an empty buffer to empty text", () => {
    expect(decodeForCapture(Buffer.alloc(0))).toEqual({ kind: "text", text: "" });
  });

  it("passes plain UTF-8 through unchanged", () => {
    const d = decodeForCapture(Buffer.from('{ "a": 1 }', "utf8"));
    expect(d).toEqual({ kind: "text", text: '{ "a": 1 }' });
  });

  it("decodes UTF-16LE with a BOM to text (BOM stripped)", () => {
    const d = decodeForCapture(Buffer.from("﻿" + '{ "secretKey": "x" }', "utf16le"));
    expect(d.kind).toBe("text");
    expect((d as { text: string }).text).toBe('{ "secretKey": "x" }');
  });

  it("decodes UTF-16BE with a BOM to text", () => {
    const le = Buffer.from("﻿hello", "utf16le");
    const be = Buffer.allocUnsafe(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    const d = decodeForCapture(be);
    expect(d.kind).toBe("text");
    expect((d as { text: string }).text).toBe("hello");
  });

  it("detects no-BOM UTF-16LE via the NUL-interleave heuristic", () => {
    const d = decodeForCapture(Buffer.from('{ "model": "gpt" }', "utf16le"));
    expect(d.kind).toBe("text");
    expect((d as { text: string }).text).toBe('{ "model": "gpt" }');
  });
});

describe("decodeForCapture: binary detection (lossless, never lossy-decoded)", () => {
  it("classifies a single 0x00 byte as binary — not empty text (data-loss regression)", () => {
    const d = decodeForCapture(Buffer.from([0x00]));
    expect(d.kind).toBe("binary");
  });

  it("never applies a UTF-16 decode to an odd-length buffer, even with a BOM", () => {
    // FF FE BOM + odd payload = malformed UTF-16; a decode would silently drop
    // the final byte. Must be stored losslessly as binary instead.
    const odd = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("abc", "utf8")]);
    expect(odd.length % 2).toBe(1);
    expect(decodeForCapture(odd).kind).toBe("binary");
  });

  it("does not decode a tiny even-length blob with a single NUL as UTF-16", () => {
    // [0x00, 0x01] would satisfy the density/ratio checks alone; the minimum
    // dominant-NUL count keeps it byte-exact as binary instead.
    expect(decodeForCapture(Buffer.from([0x00, 0x01])).kind).toBe("binary");
  });

  it("keeps invalid-UTF-8 text encodings (e.g. Latin-1) byte-exact as binary", () => {
    // "café" in Latin-1: 0xE9 is not valid UTF-8, so a lenient decode would
    // mangle it to U+FFFD. It must be stored losslessly as binary instead.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeForCapture(latin1).kind).toBe("binary");
  });

  it("classifies genuine binary (NULs at both parities) as binary", () => {
    const blob = Buffer.from([0x89, 0x00, 0x00, 0x47, 0x0d, 0x00, 0x00, 0x0a, 0x1a, 0x00]);
    expect(decodeForCapture(blob).kind).toBe("binary");
  });

  it("returns a lossy utf8 view of binary content for the fail-safe secret scan", () => {
    const blob = Buffer.concat([Buffer.from([0x00, 0x00, 0x01]), Buffer.from("sk-marker", "utf8")]);
    const d = decodeForCapture(blob);
    expect(d.kind).toBe("binary");
    expect((d as { utf8: string }).utf8).toContain("sk-marker");
  });
});
