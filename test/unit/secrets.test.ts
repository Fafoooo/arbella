/**
 * Unit tests for the secrets crypto core (src/core/secrets).
 *
 * The export/import contract: a secret bundle encrypted under a passphrase
 * decrypts back to the IDENTICAL bundle with the right passphrase, and FAILS
 * loudly (throws, never returns garbage) with a wrong passphrase or a tampered
 * blob. These functions are pure (no fs / no clock) so they are tested directly;
 * the on-disk collect/apply path is exercised by the integration suite.
 */

import { describe, it, expect } from "vitest";

import {
  encryptBundle,
  decryptBundle,
  SCRYPT_PARAMS,
  type SecretBundle,
} from "../../src/core/secrets/index.js";

/** A representative bundle: two tools, base64 payloads, captured mode. */
function sampleBundle(): SecretBundle {
  return {
    version: 1,
    createdAt: "2026-05-30T12:00:00.000Z",
    entries: [
      {
        tool: "claude",
        relPath: ".credentials.json",
        contentB64: Buffer.from(
          JSON.stringify({ token: "sk-ant-secret-value-keep-me-private" }),
          "utf8",
        ).toString("base64"),
        mode: 0o600,
      },
      {
        tool: "codex",
        relPath: "auth.json",
        contentB64: Buffer.from("OPENAI_AUTH=topsecret", "utf8").toString("base64"),
        mode: 0o600,
      },
    ],
  };
}

describe("secrets: encrypt -> decrypt round-trip", () => {
  it("decrypts back to the identical bundle with the correct passphrase", () => {
    const bundle = sampleBundle();
    const pass = "correct horse battery staple";

    const blob = encryptBundle(bundle, pass);
    // The blob is a single-line base64 string; no plaintext secret leaks into it.
    expect(typeof blob).toBe("string");
    expect(blob).not.toContain("topsecret");
    expect(blob).not.toContain("sk-ant-secret-value-keep-me-private");

    const out = decryptBundle(blob, pass);
    expect(out).toEqual(bundle);
    // And the inner payloads decode back to the original bytes.
    expect(Buffer.from(out.entries[1]!.contentB64, "base64").toString("utf8")).toBe(
      "OPENAI_AUTH=topsecret",
    );
  });

  it("produces different ciphertext each time (random salt + iv)", () => {
    const bundle = sampleBundle();
    const a = encryptBundle(bundle, "pw");
    const b = encryptBundle(bundle, "pw");
    expect(a).not.toBe(b);
    // Both still decrypt to the same plaintext.
    expect(decryptBundle(a, "pw")).toEqual(decryptBundle(b, "pw"));
  });
});

describe("secrets: failure modes", () => {
  it("fails with a wrong passphrase (GCM auth tag rejects it)", () => {
    const blob = encryptBundle(sampleBundle(), "right-passphrase");
    expect(() => decryptBundle(blob, "wrong-passphrase")).toThrow(
      /wrong passphrase or corrupted blob/i,
    );
  });

  it("fails on a tampered blob", () => {
    const blob = encryptBundle(sampleBundle(), "pw");
    // Decode to bytes, flip the LAST ciphertext byte, re-encode. Mutating the raw
    // byte (rather than a base64 char) guarantees the plaintext/tag changed.
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = raw.toString("base64");
    expect(tampered).not.toBe(blob);
    expect(() => decryptBundle(tampered, "pw")).toThrow();
  });

  it("rejects an empty passphrase on encrypt and decrypt", () => {
    expect(() => encryptBundle(sampleBundle(), "")).toThrow(/passphrase/i);
    const blob = encryptBundle(sampleBundle(), "pw");
    expect(() => decryptBundle(blob, "")).toThrow(/passphrase/i);
  });

  it("rejects a truncated / non-arbella blob", () => {
    expect(() => decryptBundle("not-a-real-blob", "pw")).toThrow();
    // A valid-base64 but too-short buffer.
    expect(() => decryptBundle(Buffer.from("short").toString("base64"), "pw")).toThrow(
      /truncated|corrupt|magic/i,
    );
  });
});

describe("secrets: crypto parameters are stable", () => {
  it("exposes the documented scrypt work factors", () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 1 << 15, r: 8, p: 1, keyLen: 32 });
  });
});
