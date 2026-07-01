/**
 * Classify raw file bytes for capture: is this TEXT (that must be sanitized +
 * templated before it can enter the repo) or genuinely BINARY (stored as opaque
 * base64)?
 *
 * Why this exists: a naive "contains a NUL byte => binary" heuristic silently
 * routes UTF-16-encoded text around the sanitizer. That matters because UTF-16LE
 * is the DEFAULT output encoding of PowerShell's `Out-File` / `Set-Content` on
 * Windows, so a perfectly ordinary `settings.json` / `mcp_config.json` written
 * there packs a 0x00 between every ASCII char — and a secret inside it would be
 * base64'd verbatim into the backup, unredacted. This module decodes UTF-16 (by
 * BOM or by a strong NUL-interleave heuristic) back to a JS string so the normal
 * text path (sanitize + {{TOKEN}} folding) always runs. Other content is stored
 * as text only when it is strictly valid UTF-8 — a lenient decode would silently
 * mangle Latin-1 / NUL-free binary bytes into U+FFFD on round-trip. Genuinely
 * binary content (images, sqlite, real blobs, malformed encodings) is reported
 * as binary AND handed back as a lossy UTF-8 view so callers can run a fail-safe
 * secret scan before storing it raw.
 *
 * Pure module: no fs, no clock, no injected services.
 */

/** How large a prefix to sample when guessing the encoding. */
const SNIFF_LIMIT = 8000;

export type DecodedBytes =
  /** Decoded to text (UTF-8, or UTF-16 normalized to a JS string). Sanitize it. */
  | { kind: "text"; text: string }
  /** Genuinely binary. `utf8` is a lossy decode for a fail-safe secret scan only. */
  | { kind: "binary"; utf8: string };

/** Strip a single leading BOM (U+FEFF) left by a UTF-16 decode. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Decode big-endian UTF-16 by swapping each byte pair, then reading as LE. */
function decodeUtf16be(bytes: Buffer): string {
  const even = bytes.length - (bytes.length % 2);
  const swapped = Buffer.allocUnsafe(even);
  for (let i = 0; i < even; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  return swapped.toString("utf16le");
}

/**
 * Decide whether `bytes` is text (and decode it) or binary. UTF-16 is recognized
 * by a BOM (FF FE / FE FF) or by a strong parity bias in NUL positions (LE ASCII
 * puts NULs on odd offsets, BE on even). Anything with NULs that is NOT UTF-16 is
 * treated as binary.
 */
export function decodeForCapture(bytes: Buffer): DecodedBytes {
  if (bytes.length === 0) return { kind: "text", text: "" };

  // Valid UTF-16 is always an even number of bytes. An odd-length buffer (even
  // one starting with a BOM, or a lone 0x00) must NEVER take a UTF-16 decode —
  // Node's utf16le decoding silently drops the trailing byte, losing data. Odd
  // lengths fall through to the NUL scan and are stored losslessly as binary.
  const evenLength = bytes.length % 2 === 0;

  // Explicit UTF-16 BOMs.
  if (evenLength && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { kind: "text", text: stripBom(bytes.subarray(2).toString("utf16le")) };
  }
  if (evenLength && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { kind: "text", text: stripBom(decodeUtf16be(bytes.subarray(2))) };
  }

  const n = Math.min(bytes.length, SNIFF_LIMIT);
  let nulOdd = 0;
  let nulEven = 0;
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) nulEven++;
      else nulOdd++;
    }
  }
  const nulTotal = nulOdd + nulEven;

  if (nulTotal > 0) {
    // No-BOM UTF-16: NULs strongly biased to one parity => interleaved ASCII
    // text. Require both a meaningful density and a lopsided ratio so genuine
    // binaries (NULs at both parities) are never misread as text.
    if (evenLength) {
      const pairs = Math.max(1, Math.floor(n / 2));
      const DENSITY = 0.3;
      const RATIO = 4;
      // A couple of stray NULs in a tiny buffer is no signal — without a minimum
      // count, a 2-byte blob like [0x00, 0x01] would "decode" as UTF-16 and be
      // corrupted on round-trip. Demand at least two dominant-parity NULs.
      const MIN_DOMINANT_NULS = 2;
      if (nulOdd >= MIN_DOMINANT_NULS && nulOdd >= pairs * DENSITY && nulOdd > nulEven * RATIO) {
        return { kind: "text", text: bytes.toString("utf16le") };
      }
      if (nulEven >= MIN_DOMINANT_NULS && nulEven >= pairs * DENSITY && nulEven > nulOdd * RATIO) {
        return { kind: "text", text: decodeUtf16be(bytes) };
      }
    }
    return { kind: "binary", utf8: bytes.toString("utf8") };
  }

  // NUL-free: store as text ONLY if it is strictly valid UTF-8. A lenient
  // toString("utf8") would replace invalid sequences with U+FFFD — silently
  // corrupting Latin-1 files and NUL-free binary formats on round-trip — so
  // anything else stays byte-exact on the binary path instead.
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "binary", utf8: bytes.toString("utf8") };
  }
}
