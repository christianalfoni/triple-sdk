/**
 * SPEC §1.1 (triple equality) and §2.2 (object keys).
 *
 * Triples are compared by VALUE, not reference. But a Set<Value> compares object
 * identity, so two separate `{ id: "user_1" }` objects would be two distinct members.
 *
 * Fix: every Value gets a unique, reversible string encoding, and the store's Sets
 * hold those strings instead of the raw values.
 */

import type { Ref, Triple, Value } from "./types.ts";

/**
 * Narrow a Value to the Ref SHAPE. Shape only: with object values in the model
 * (§4.7), true ref-ness comes from the schema — callers on ref-typed predicates
 * may use this safely; generic callers must consult the field's declared type.
 */
export function isRef(value: Value): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as Ref).id === "string" &&
    Object.keys(value).length === 1
  );
}

/**
 * Value → unique string.
 *
 *   "hello"        → 's:hello'
 *   42             → 'n:42'
 *   true           → 'b:true'
 *   { id: "u_1" }  → 'r:u_1'
 *
 * The one-character tag keeps the string "42" and the number 42 distinct, which
 * matters because they are genuinely different triples.
 */
export function encodeValue(value: Value): string {
  if (typeof value === "object") {
    if (isRef(value)) return `r:${value.id}`;
    // §4.7 — CANONICAL: keys sorted recursively, so two spellings of the same
    // object are the same value (set identity, POS bucket, wire dedupe).
    return `o:${canonicalJson(value)}`;
  }
  switch (typeof value) {
    case "string":
      return `s:${value}`;
    case "number":
      return `n:${encodeNumber(value)}`;
    case "boolean":
      return `b:${value}`;
  }
}

function canonicalJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",");
  return `{${body}}`;
}

const NUMBER_BITS = new DataView(new ArrayBuffer(8));

/**
 * Order-preserving float encoding (§6.6): 16 hex chars whose LEXICOGRAPHIC order
 * equals numeric order, negatives included. The IEEE-754 trick: flip every bit of
 * a negative, flip only the sign bit of a positive. This is what lets a SQL
 * `ORDER BY object` rank numbers correctly with no JS in the loop.
 */
function encodeNumber(value: number): string {
  NUMBER_BITS.setFloat64(0, value);
  let bits = NUMBER_BITS.getBigUint64(0);
  bits = bits & 0x8000000000000000n ? ~bits & 0xffffffffffffffffn : bits | 0x8000000000000000n;
  return bits.toString(16).padStart(16, "0");
}

function decodeNumber(body: string): number {
  // Legacy plain form ("n:42") from files written before the sortable encoding.
  if (body.length !== 16 || !/^[0-9a-f]{16}$/.test(body)) return Number(body);
  let bits = BigInt("0x" + body);
  bits = bits & 0x8000000000000000n ? bits & 0x7fffffffffffffffn : ~bits & 0xffffffffffffffffn;
  NUMBER_BITS.setBigUint64(0, bits);
  return NUMBER_BITS.getFloat64(0);
}

/** The inverse of `encodeValue`. */
export function decodeValue(encoded: string): Value {
  const tag = encoded[0];
  const body = encoded.slice(2);
  switch (tag) {
    case "s":
      return body;
    case "n":
      return decodeNumber(body);
    case "b":
      return body === "true";
    case "r":
      return { id: body };
    case "o":
      return JSON.parse(body) as Value;
    default:
      throw new Error(`Cannot decode value: ${encoded}`);
  }
}

/** A stable string key for a whole triple. Used for deduping. */
export function tripleKey(triple: Triple): string {
  return `${triple[0]}|${triple[1]}|${encodeValue(triple[2])}`;
}
