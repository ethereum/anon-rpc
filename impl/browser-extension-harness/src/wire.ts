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
// instead. So what gets base64'd is request and response bodies, which cross
// as chunks the receiver asks for (body-stream.ts) rather than whole.

import { serializeError, type SerializedError, type WirePlain } from "@anon-rpc/harness-core";

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

// §9.4 plain values cross this hop in harness-core's JSON encoding: JSON
// alone would lose undefined, NaN, -0 and bytes, and do to bytes what it does
// to bodies (see the header).
export { encodePlain, decodePlain, type WirePlain } from "@anon-rpc/harness-core";

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

/** The long-lived port's name. One port per AnonRpcWorker instance. */
export const PORT_NAME = "anon-rpc.worker";

/** §12 errors cross with name and code intact (harness-core). */
export type WireError = SerializedError;
export const toWireError = serializeError;

/**
 * A §9 body crossing as chunks (body-stream.ts). The receiver sends pull and
 * cancel; the sender answers with chunk, end or error. `ch` says whose body it
 * is, since one call can have both a request and a response body in flight.
 */
export type BodyChannel = "request" | "response";
export type BodyMessage =
  | { t: "body.pull"; ch: BodyChannel; callId: number }
  | { t: "body.cancel"; ch: BodyChannel; callId: number; reason?: string }
  | { t: "body.chunk"; ch: BodyChannel; callId: number; data: string }
  | { t: "body.end"; ch: BodyChannel; callId: number }
  | { t: "body.error"; ch: BodyChannel; callId: number; error: WireError };

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
      /** A body already in memory, whole. */
      body: B64;
      /** The body is a stream, and follows as "request" chunks instead. */
      bodyStream?: true;
      /** §9.1 forwarded init entries, as one encoded object. */
      forwarded?: WirePlain;
    }
  | { t: "abort"; callId: number }
  | { t: "close" }
  // The offscreen document has no RPC provider of its own — §4 says the
  // specifier is read through one the host already has, and the host is the
  // service worker. So provider calls travel outward and their results back.
  | { t: "provider.result"; id: number; ok: true; value: unknown }
  | { t: "provider.result"; id: number; ok: false; error: WireError }
  | BodyMessage;

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
      /** The body follows as "response" chunks; false for a null body. */
      hasBody: boolean;
    }
  | { t: "response"; callId: number; ok: false; error: WireError }
  | { t: "provider.request"; id: number; method: string; params?: unknown[] }
  | BodyMessage
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
