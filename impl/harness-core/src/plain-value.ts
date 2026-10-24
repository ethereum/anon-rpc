// §9.4 — plain values: the one value domain every harness boundary carries
// identically (postMessage, an interpreter such as QuickJS, a process).
//
// Two tools, for two kinds of boundary:
//
//   * copyPlainValue — for a boundary that carries plain values as they are
//     (postMessage). The host copies `config` (§7.1) and forwarded fetch-init
//     entries (§9.1) through it, so what crosses is already exactly what §9.4
//     says the worker receives.
//   * encodePlain / decodePlain — for a boundary that carries only JSON
//     (extension messaging, the QuickJS guest). JSON alone would lose
//     `undefined`, NaN, ±Infinity, -0 and bytes.
//
// Both validate: a value that is not plain throws §9.4's TypeError where the
// host called, rather than somewhere past the boundary.

import type { PlainValue } from "./spec-types.js";
import { toHex } from "./hex.js";

/**
 * A §9.4 copy of `value`, or a `TypeError` naming where in it the first value
 * that is not plain sits. `path` prefixes that location (e.g. "config").
 */
export function copyPlainValue(value: unknown, path = "value"): PlainValue {
  return copy(value, path, new Set());
}

function copy(v: unknown, path: string, ancestors: Set<object>): PlainValue {
  switch (typeof v) {
    case "undefined":
    case "boolean":
    case "number": // delivered exactly: NaN, ±Infinity and -0 included
    case "string":
      return v;
    case "object":
      break;
    default:
      throw notPlain(path, typeof v);
  }
  if (v === null) return null;

  if (v instanceof Uint8Array) {
    // Subclasses (Node's Buffer) arrive as a plain Uint8Array of just the view.
    if (isDetached(v.buffer)) throw notPlain(path, "a Uint8Array over a detached buffer");
    return new Uint8Array(v);
  }
  if (v instanceof ArrayBuffer) {
    if (isDetached(v)) throw notPlain(path, "a detached ArrayBuffer");
    return v.slice(0); // a resizable source yields a fixed-length copy
  }

  // Ancestors, not everything seen: a value reachable twice without a cycle is
  // plain (delivered as independent copies); only a value inside itself is not.
  if (ancestors.has(v)) throw notPlain(path, "a value that contains itself");
  ancestors.add(v);
  try {
    if (Array.isArray(v)) {
      // Dense copy: holes are delivered as undefined, non-index keys dropped.
      const out: PlainValue[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = copy(v[i], `${path}[${i}]`, ancestors);
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw notPlain(path, describe(v));
    }
    const out: { [key: string]: PlainValue } = {};
    for (const key of Object.keys(v)) {
      // defineProperty, so a "__proto__" key stays an own property rather than
      // setting the copy's prototype.
      Object.defineProperty(out, key, {
        value: copy((v as Record<string, unknown>)[key], `${path}.${key}`, ancestors),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    ancestors.delete(v);
  }
}

function isDetached(b: ArrayBufferLike): boolean {
  // A "surely you didn't mean this" check: the host already gave these bytes
  // away. `detached` is ES2024; an engine without it copies an empty buffer.
  return (b as { detached?: boolean }).detached === true;
}

function describe(v: object): string {
  const name = (v as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name ? `a ${name}` : "an object with a non-plain prototype";
}

function notPlain(path: string, what: string): TypeError {
  return new TypeError(`${path} is not a plain value (§9.4): got ${what}`);
}

/**
 * A plain value in a form JSON carries without loss. Every array on the wire
 * is tagged and the tag says what it stands for; anything untagged is a JSON
 * primitive that means itself. Object keys travel as array elements, never as
 * JSON keys, so a "__proto__" key cannot reach a prototype on either side.
 *
 * The node harness's QuickJS prelude decodes this same format in guest JS
 * (prelude.guest.js `decodePlain`); a change here is a change there.
 */
export type WirePlain =
  | null
  | boolean
  | number
  | string
  | ["u"] // undefined
  | ["n", "NaN" | "Infinity" | "-Infinity" | "-0"]
  | ["b", string] // Uint8Array, hex
  | ["ab", string] // ArrayBuffer, hex
  | ["a", ...WirePlain[]]
  | ["o", ...(string | WirePlain)[]]; // key, value, key, value, …

/** Encode `value` for a JSON boundary, or throw a TypeError naming where (`path`) it is not plain. */
export function encodePlain(value: unknown, path = "value"): WirePlain {
  return toWire(copyPlainValue(value, path));
}

function toWire(v: PlainValue): WirePlain {
  switch (typeof v) {
    case "undefined":
      return ["u"];
    case "number":
      if (Number.isNaN(v)) return ["n", "NaN"];
      if (v === Infinity) return ["n", "Infinity"];
      if (v === -Infinity) return ["n", "-Infinity"];
      if (Object.is(v, -0)) return ["n", "-0"]; // String(-0) is "0"
      return v;
    case "boolean":
    case "string":
      return v;
  }
  if (v === null) return null;
  if (v instanceof Uint8Array) return ["b", toHex(v)];
  if (v instanceof ArrayBuffer) return ["ab", toHex(new Uint8Array(v))];
  if (Array.isArray(v)) return ["a", ...v.map(toWire)];
  const out: ["o", ...(string | WirePlain)[]] = ["o"];
  for (const key of Object.keys(v)) out.push(key, toWire(v[key]));
  return out;
}

/** The value `encodePlain` encoded — a fresh §9.4 copy. */
export function decodePlain(w: WirePlain): PlainValue {
  if (!Array.isArray(w)) return w;
  switch (w[0]) {
    case "u":
      return undefined;
    case "n":
      return Number(w[1]); // "-0" parses to -0
    case "b":
      return fromHex(w[1]);
    case "ab":
      return fromHex(w[1]).buffer as ArrayBuffer;
    case "a":
      return (w.slice(1) as WirePlain[]).map(decodePlain);
    case "o": {
      const out: { [key: string]: PlainValue } = {};
      for (let i = 1; i < w.length; i += 2) {
        Object.defineProperty(out, w[i] as string, {
          value: decodePlain(w[i + 1] as WirePlain),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return out;
    }
  }
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

