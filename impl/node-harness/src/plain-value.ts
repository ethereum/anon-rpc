// §9.4 — plain values, encoded for the QuickJS boundary.
//
// Nothing but JSON and one byte buffer crosses into the isolate (isolate.ts),
// and JSON alone would lose what §9.4 says must arrive: it drops `undefined`
// properties, turns NaN and ±Infinity into null and -0 into 0, and has no
// bytes. So `config` (§7.1) and forwarded fetch-init entries (§9.1) are encoded
// here, on the host, into a JSON-safe tagged form, and the prelude's
// `decodePlain` rebuilds them inside the guest. Every array on the wire is
// tagged; anything untagged is a JSON primitive that means itself. Object keys
// travel as array elements, never as JSON keys, so a "__proto__" key cannot
// reach a prototype on either side.
//
// Encoding is also the validation: a value that is not plain throws §9.4's
// TypeError here, where the host called, rather than somewhere in the isolate.

export type WirePlain =
  | null
  | boolean
  | number
  | string
  | ["u"] // undefined
  | ["n", "NaN" | "Infinity" | "-Infinity" | "-0"]
  | ["b", string] // Uint8Array, hex (the guest has no base64 decoder)
  | ["ab", string] // ArrayBuffer, hex
  | ["a", ...WirePlain[]]
  | ["o", ...(string | WirePlain)[]]; // key, value, key, value, …

/** Encode `value`, or throw a TypeError naming where (`path`) it is not plain. */
export function encodePlain(value: unknown, path = "value"): WirePlain {
  return enc(value, path, new Set());
}

function enc(v: unknown, path: string, ancestors: Set<object>): WirePlain {
  switch (typeof v) {
    case "undefined":
      return ["u"];
    case "boolean":
    case "string":
      return v;
    case "number":
      if (Number.isNaN(v)) return ["n", "NaN"];
      if (v === Infinity) return ["n", "Infinity"];
      if (v === -Infinity) return ["n", "-Infinity"];
      if (Object.is(v, -0)) return ["n", "-0"];
      return v;
    case "object":
      break;
    default:
      throw notPlain(path, typeof v);
  }
  if (v === null) return null;
  // Subclasses (Buffer) included: only the view's bytes are sent.
  if (v instanceof Uint8Array) {
    if (isDetached(v.buffer)) throw notPlain(path, "a Uint8Array over a detached buffer");
    return ["b", Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex")];
  }
  if (v instanceof ArrayBuffer) {
    if (isDetached(v)) throw notPlain(path, "a detached ArrayBuffer");
    return ["ab", Buffer.from(v).toString("hex")];
  }
  // Ancestors only: a value reachable twice is plain, one inside itself is not.
  if (ancestors.has(v)) throw notPlain(path, "a value that contains itself");
  ancestors.add(v);
  try {
    if (Array.isArray(v)) {
      const out: ["a", ...WirePlain[]] = ["a"];
      for (let i = 0; i < v.length; i++) out.push(enc(v[i], `${path}[${i}]`, ancestors));
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const name = (v as { constructor?: { name?: unknown } }).constructor?.name;
      throw notPlain(path, typeof name === "string" && name ? `a ${name}` : "an object with a non-plain prototype");
    }
    const out: ["o", ...(string | WirePlain)[]] = ["o"];
    for (const key of Object.keys(v)) {
      out.push(key, enc((v as Record<string, unknown>)[key], `${path}.${key}`, ancestors));
    }
    return out;
  } finally {
    ancestors.delete(v);
  }
}

function isDetached(b: ArrayBufferLike): boolean {
  return (b as { detached?: boolean }).detached === true;
}

function notPlain(path: string, what: string): TypeError {
  return new TypeError(`${path} is not a plain value (§9.4): got ${what}`);
}
