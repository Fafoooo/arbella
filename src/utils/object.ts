/**
 * Tiny object predicates shared across capture, restore and the core modules.
 *
 * `isPlainObject` had grown five near-identical copies (mcp.ts, scan.ts,
 * suggest.ts, manifest/index.ts, sanitizer/index.ts, plugins.ts) — two of them
 * LOOSER than the rest, accepting class instances and therefore letting a
 * `new Date()` or a prototype-carrying object walk into a JSON-shaped code path.
 * One definition, one semantics:
 *
 *   a value is a plain object iff it is a non-null, non-array object whose
 *   prototype is `Object.prototype` or `null`.
 *
 * The `null`-prototype case matters: `JSON.parse` output is always
 * `Object.prototype`-based, but `Object.create(null)` records are a normal way
 * to build a lookup map and are just as safe to walk.
 *
 * Pure module: no imports, no state.
 */

/** True for ordinary `{}`-style records (not arrays, not null, not instances). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Keys that must never be copied into a `{}`-based record.
 *
 * `out[key] = value` with `key === "__proto__"` does not create an own property
 * — it invokes the prototype SETTER and changes what `out` inherits. `JSON.parse`
 * happily produces such a key from repo data, so every loop that rebuilds an
 * object from parsed JSON (server maps, deep clones) has to skip these three.
 */
const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** True for a key that must not be assigned onto a plain object. */
export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.has(key);
}
