// §9.4 — plain values: the one value domain every harness boundary carries
// identically (postMessage, an interpreter such as QuickJS, a process).
// `config` (§7.1) and forwarded fetch-init entries (§9.1) are copied through
// here on the host, so what crosses the port is already exactly what §9.4
// says the worker receives.

import type { PlainValue } from "./spec-types.js";

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
