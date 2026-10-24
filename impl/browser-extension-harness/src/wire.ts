// The service-worker ↔ offscreen-document message contract.
//
// This is a THIRD boundary, on top of the two the browser harness already has
// (host ↔ null-origin iframe ↔ Web Worker). It exists because an MV3 service
// worker has no DOM, so it cannot hold the iframe that §6 isolation is built
// from, and `chrome.runtime` messaging is the only channel between the two
// contexts an extension gets.
//
// It is NOT a security boundary. Both ends are the extension's own code, at the
// extension's own origin, and either could do anything the other could. The §6
// boundary is still the opaque-origin frame further in. What this boundary
// costs is serialisation, which is the one thing worth being careful about:
//
//   Extension messaging serialises with JSON unless the extension opts in to
//   structured clone (`"message_serialization": "structured_clone"`, Chrome
//   148+). Under JSON a `Uint8Array` silently becomes `{"0":72,"1":105}` —
//   it does not throw, it arrives as a plausible-looking object — so every
//   byte payload here is base64 on the wire, unconditionally. Doing it
//   unconditionally rather than feature-detecting means one code path that
//   behaves the same on every Chrome and on Firefox.
//
// The large payload deliberately does NOT cross this boundary at all: the
// bundle bytes are fetched and hash-verified inside the offscreen document,
// and the bootstrap provider call is proxied back to the service worker
// instead. So what gets base64'd is request and response bodies, which for
// JSON-RPC are small.

import type { PlainValue } from "@anon-rpc/browser-harness";

/** Bodies that cross as base64; `undefined` when there is no body. */
export type B64 = string | undefined;

export function toB64(bytes: Uint8Array | undefined): B64 {
  if (!bytes || bytes.byteLength === 0) return undefined;
  // Chunked: String.fromCharCode(...bytes) on a large body overflows the
  // argument stack, which shows up as a RangeError on exactly the payloads
  // least likely to appear in a test.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

export function fromB64(b64: B64): Uint8Array | undefined {
  if (b64 === undefined) return undefined;
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * A §9.4 plain value in a form JSON carries without loss.
 *
 * JSON alone would not do: it drops `undefined` properties, turns NaN and
 * ±Infinity into null and -0 into 0, and does to bytes what it does to bodies.
 * So every array on the wire is tagged, and the tag says what it stands for;
 * anything untagged is a JSON primitive that means itself. Object keys travel
 * as array elements, never as JSON keys, so a "__proto__" key cannot reach a
 * prototype on either side.
 */
export type WirePlain =
  | null
  | boolean
  | number
  | string
  | ["u"] // undefined
  | ["n", "NaN" | "Infinity" | "-Infinity" | "-0"]
  | ["b", string] // Uint8Array, base64
  | ["ab", string] // ArrayBuffer, base64
  | ["a", ...WirePlain[]]
  | ["o", ...(string | WirePlain)[]]; // key, value, key, value, …

/**
 * Encode a plain value for the wire, or throw §9.4's TypeError for one that is
 * not plain. Validation happens here, at the edge the host called, so the
 * failure is the host's `fetch` or constructor failing — not a call that dies
 * somewhere past this boundary.
 */
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
  if (v instanceof Uint8Array) {
    if (isDetached(v.buffer)) throw notPlain(path, "a Uint8Array over a detached buffer");
    return ["b", toB64(v) ?? ""];
  }
  if (v instanceof ArrayBuffer) {
    if (isDetached(v)) throw notPlain(path, "a detached ArrayBuffer");
    return ["ab", toB64(new Uint8Array(v)) ?? ""];
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

/** The value `encodePlain` encoded — a fresh §9.4 copy. */
export function decodePlain(w: WirePlain): PlainValue {
  if (!Array.isArray(w)) return w;
  switch (w[0]) {
    case "u":
      return undefined;
    case "n":
      return Number(w[1]); // "-0" parses to -0
    case "b":
      return fromB64(w[1] || undefined) ?? new Uint8Array(0);
    case "ab":
      return (fromB64(w[1] || undefined) ?? new Uint8Array(0)).buffer as ArrayBuffer;
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

/** §9.4 copy without crossing anything: what the far side would receive. */
export function copyPlain(value: unknown, path?: string): PlainValue {
  return decodePlain(encodePlain(value, path));
}

/**
 * A string equal for equal plain values, whatever their key order — so two
 * structurally identical configs share one cached worker. Unlike JSON of the
 * decoded value, it keeps NaN, undefined and bytes distinct.
 */
export function plainKey(w: WirePlain): string {
  return JSON.stringify(sortKeys(w));
}

function sortKeys(w: WirePlain): WirePlain {
  if (!Array.isArray(w)) return w;
  if (w[0] === "a") return ["a", ...(w.slice(1) as WirePlain[]).map(sortKeys)];
  if (w[0] !== "o") return w;
  const pairs: [string, WirePlain][] = [];
  for (let i = 1; i < w.length; i += 2) pairs.push([w[i] as string, sortKeys(w[i + 1] as WirePlain)]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return ["o", ...pairs.flat()];
}

function isDetached(b: ArrayBufferLike): boolean {
  return (b as { detached?: boolean }).detached === true;
}

function notPlain(path: string, what: string): TypeError {
  return new TypeError(`${path} is not a plain value (§9.4): got ${what}`);
}

/** The long-lived port's name. One port per AnonRpcWorker instance. */
export const PORT_NAME = "anon-rpc.worker";

export type WireError = { name: string; message: string; code?: string };

export function toWireError(err: unknown): WireError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, message: err.message, ...(typeof code === "string" ? { code } : {}) };
  }
  return { name: "Error", message: String(err) };
}

/** A §9 request, minus the body (which rides alongside as base64). */
export type WireRequest = {
  method?: string;
  headers?: [string, string][];
  redirect?: RequestRedirect;
};

/** service worker → offscreen document */
export type ToOffscreen =
  | {
      t: "boot";
      address: string;
      config: WirePlain;
      iframeUrl: string;
      /**
       * Reuse an already-booted worker for the same address+config if the
       * offscreen document still has one. False re-boots from scratch, which
       * costs a specifier read and a bundle fetch.
       */
      reuse: boolean;
    }
  | {
      t: "fetch";
      callId: number;
      url: string;
      request: WireRequest;
      body: B64;
      /** §9.1 forwarded init entries, as one encoded object. */
      forwarded?: WirePlain;
    }
  | { t: "abort"; callId: number }
  | { t: "close" }
  // The offscreen document has no RPC provider of its own — §4 says the
  // specifier is read through one the host already has, and the host is the
  // service worker. So provider calls travel outward and their results back.
  | { t: "provider.result"; id: number; ok: true; value: unknown }
  | { t: "provider.result"; id: number; ok: false; error: WireError };

/** offscreen document → service worker */
export type FromOffscreen =
  | { t: "ready" }
  | { t: "failed"; error: WireError }
  | {
      t: "response";
      callId: number;
      ok: true;
      status: number;
      headers: [string, string][];
      url?: string;
      body: B64;
    }
  | { t: "response"; callId: number; ok: false; error: WireError }
  | { t: "provider.request"; id: number; method: string; params?: unknown[] }
  /**
   * One §13 log entry, on its way from the offscreen document to whoever
   * called acceptLog() in the service worker.
   *
   * `args` are RENDERED TO STRINGS before they cross. This boundary is JSON
   * (see the header), and a §13 LogArg may be a Uint8Array, which JSON turns
   * into `{"0":72,"1":105}` without complaining. A string is itself a valid
   * LogArg, so what arrives still conforms — it is a lossier snapshot than a
   * same-context harness makes, which §13 permits ("serialized or snapshotted
   * at call time").
   */
  | { t: "log"; level: string; args: string[] };
