import { sha256Hex } from "./ids.ts";

/**
 * Canonical request payload serialization per spec §7.3.
 *
 * Versioned (`v1`). Rules:
 * - Object keys are sorted recursively (order-insensitive),
 * - Array order is PRESERVED exactly,
 * - Task strings are preserved byte-exact (no trimming/normalization),
 * - Numbers keep their JSON representation (integers vs floats distinct),
 * - Generated paths, delivery modes, timestamps and transport request IDs
 *   MUST NOT be part of the hashed payload — only caller-supplied content,
 * - `undefined` properties are dropped; `null` is preserved explicitly.
 *
 * Changing any rule bumps the version constant and requires a new ledger
 * namespace view (spec: canonicalization is versioned).
 */
export const CANONICALIZATION_VERSION = 1;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dropUndefined(v: unknown): unknown {
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) out[k] = dropUndefined(val);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map(dropUndefined);
  return v;
}

export function canonicalize(value: unknown): string {
  const normalized = dropUndefined(value);

  function encode(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") return Number.isInteger(v) ? `i${v}` : `f${v}`;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (isPlainObject(v)) {
      const keys = Object.keys(v).sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${encode(v[k])}`)
        .join(",")}}`;
    }
    throw new Error(`canonicalize: unsupported value type: ${typeof v}`);
  }

  return encode(normalized);
}

/** Canonical payload hash for the idempotency ledger (§7.3). */
export function canonicalRequestHash(payload: unknown): string {
  return sha256Hex(`canon:v${CANONICALIZATION_VERSION}:${canonicalize(payload)}`);
}
