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
      config?: unknown;
      iframeUrl: string;
      /**
       * Reuse an already-booted worker for the same address+config if the
       * offscreen document still has one. False re-boots from scratch, which
       * costs a specifier read and a bundle fetch.
       */
      reuse: boolean;
    }
  | { t: "fetch"; callId: number; url: string; request: WireRequest; body: B64 }
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
