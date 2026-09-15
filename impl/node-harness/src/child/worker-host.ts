// Runs INSIDE the Landlock-confined child process, with an empty environment
// and `--permission` on. Its whole job: receive the hash-verified bundle over
// IPC, build the §7 capability API, and run the bundle with that as its
// platform.
//
// Everything in this file is on the untrusted side of nothing — it is harness
// code — but it shares a realm with the worker, so it must not hold anything
// the worker should not reach. It closes over the IPC channel and the abort
// controllers; the worker gets only the `anonRpcWorker` object.
//
// Note what is NOT here: the sandbox. Confinement was applied by the launcher
// before this process existed, and cannot be revoked from in here. This script
// could not weaken it even if it tried to.

import { createContext, runInContext } from "node:vm";
import { Duplex } from "node:stream";
import type { Socket as NetSocket } from "node:net";
import { Rpc, serializeError, type PortLike } from "../protocol.js";
import type {
  AnonFetchResponse,
  AnonRequestInit,
  AnonRpcWorkerApi,
  ByteBody,
  FetchCall,
  KpsApi,
  KpsStreamCloseInfo,
  LogArg,
  SocketApi,
  StorageApi,
} from "../spec-types.js";

if (!process.send) {
  throw new Error("worker-host must be spawned with an IPC channel");
}

const port: PortLike = {
  postMessage: (msg, handle) => void process.send!(msg as object, handle as NetSocket | undefined),
  // Node delivers a passed descriptor on the same 'message' event as its
  // payload, so the handle needs no correlation scheme — it arrives attached
  // to the `res` frame whose id already identifies the call.
  setOnMessage: (fn) => process.on("message", (m, handle) => fn(m, handle)),
};
const rpc = new Rpc(port);

// Signals for calls the worker is currently working on, so a host-side abort
// becomes a real AbortSignal in here (§9). The host cannot send its own —
// AbortSignal is not structured-cloneable.
const inFlight = new Map<number, AbortController>();
rpc.onEvent("call.abort", ({ id }: { id: number }) => {
  inFlight.get(id)?.abort();
  inFlight.delete(id);
});

/** §12 error shape for a capability this harness does not implement yet. */
function unsupported(what: string): never {
  const e = new Error(`${what} is not implemented by the Node harness yet`);
  (e as Error & { code: string }).code = "unsupported";
  throw e;
}

// §10/§11 are REQUIRED capabilities that this harness has not implemented yet,
// so they are present and throw `unsupported` (§12) rather than being absent:
// a worker must be able to assume every spec-mandated capability exists, and
// get a documented error rather than a TypeError when one is a stub.
//
// The opposite convention applies to genuinely optional capabilities — see
// `socket` below, whose absence is the signal a worker feature-tests on.
const kps: KpsApi = {
  dial: () => unsupported("anonRpcWorker.kps.dial"),
  openStream: () => unsupported("anonRpcWorker.kps.openStream"),
};

const storage: StorageApi = {
  get: () => unsupported("anonRpcWorker.storage.get"),
  set: () => unsupported("anonRpcWorker.storage.set"),
  delete: () => unsupported("anonRpcWorker.storage.delete"),
  has: () => unsupported("anonRpcWorker.storage.has"),
  list: () => unsupported("anonRpcWorker.storage.list"),
  clear: () => unsupported("anonRpcWorker.storage.clear"),
};

/**
 * The bridged TCP capability. The worker asks; the host resolves, applies its
 * address policy, dials, and passes the connected descriptor back over IPC.
 * This process cannot dial for itself — Landlock denies every TCP connect —
 * so there is no path around the host's decision.
 *
 * The descriptor arrives as a live `net.Socket`, already owned here (the
 * host's copy is closed on send). Wrapping it in web streams gives the worker
 * the §10.2 shape with the kernel's socket buffer as the backpressure: the
 * host is on the control path, never the data path.
 */
const socket: SocketApi = {
  async connect(host, port, opts) {
    const { value, handle } = await rpc.callWithHandle<{
      remoteAddress: { address: string; port: number };
    }>("socket.connect", { host, port }, { signal: opts?.signal });

    const sock = handle as NetSocket | undefined;
    if (!sock) {
      const e = new Error("socket.connect: host sent no descriptor");
      (e as Error & { code: string }).code = "internal-error";
      throw e;
    }
    // The host paused it before sending so that no byte is read on that side;
    // reading starts here, when the worker pulls from `readable`.
    const { readable, writable } = Duplex.toWeb(sock) as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    };

    const closed = new Promise<KpsStreamCloseInfo>((res) => {
      sock.once("close", (hadError: boolean) =>
        res(hadError ? { ok: false, reason: { code: "network-error" } } : { ok: true }),
      );
    });

    return {
      readable,
      writable,
      remoteAddress: value.remoteAddress,
      closeWrite: async () => void sock.end(),
      close: async () => void sock.destroy(),
      closed,
    };
  },
};

let failed = false;
let readied = false;

function buildApi(config: unknown, capabilities: { socket: boolean }): AnonRpcWorkerApi {
  return {
    // Absent, not throwing, when the host did not grant it: the whole point of
    // an optional capability is that `if (anonRpcWorker.socket)` answers
    // truthfully. A browser harness will never define this.
    ...(capabilities.socket ? { socket } : {}),
    signalReady() {
      // Failure is final (§7): a signalReady after signalFailed is ignored.
      if (failed || readied) return;
      readied = true;
      rpc.emit("worker.ready", undefined);
    },

    signalFailed(reason) {
      if (failed) return;
      failed = true;
      rpc.emit("worker.failed", reason ? { code: reason.code, message: reason.message } : undefined);
    },

    async acceptCall(opts) {
      const accepted = await rpc.call<{
        id: number;
        kind: "fetch";
        url: string;
        requestInit?: AnonRequestInit;
      }>("call.accept", undefined, { signal: opts?.signal });

      const ac = new AbortController();
      inFlight.set(accepted.id, ac);

      const requestInit: AnonRequestInit | undefined = accepted.requestInit
        ? { ...accepted.requestInit, signal: ac.signal }
        : { signal: ac.signal };

      const call: FetchCall = {
        kind: "fetch",
        url: accepted.url,
        requestInit,
        respond(response) {
          // §8: respond takes a value or a promise, and the worker is not
          // required to await it — so the settling is handled here.
          void Promise.resolve(response).then(
            async (r) => {
              inFlight.delete(accepted.id);
              try {
                rpc.emit("call.respond", { id: accepted.id, response: await toWire(r) });
              } catch (e) {
                rpc.emit("call.fail", { id: accepted.id, error: serializeError(e) });
              }
            },
            (e) => {
              inFlight.delete(accepted.id);
              rpc.emit("call.fail", { id: accepted.id, error: serializeError(e) });
            },
          );
        },
      };
      return call;
    },

    config,
    kps,
    storage,
    log: {
      debug: (...args: LogArg[]) => rpc.emit("log", { level: "debug", args }),
      info: (...args: LogArg[]) => rpc.emit("log", { level: "info", args }),
      warn: (...args: LogArg[]) => rpc.emit("log", { level: "warn", args }),
      error: (...args: LogArg[]) => rpc.emit("log", { level: "error", args }),
    },
  };
}

/**
 * A §9 response as it can cross Node's IPC: the body buffered to bytes.
 *
 * The browser harness transfers a ReadableStream here and gets platform
 * backpressure for free. Node's IPC cannot transfer one, so a streaming
 * response is drained before it crosses — which means a large response is held
 * in memory twice and delivers in one lump. This is the transport limitation
 * a socketpair-per-stream design is meant to remove; it is not a §9 change,
 * since the worker still sees the streams the spec describes.
 */
async function toWire(r: AnonFetchResponse): Promise<AnonFetchResponse> {
  return { ...r, body: await readAll(r.body) };
}

async function readAll(body: ByteBody): Promise<Uint8Array> {
  // Duck-typed, not `instanceof`: worker code runs in its own vm context, so a
  // value it constructed may come from that context's intrinsics rather than
  // ours even though the two are structurally identical. The context is given
  // our Uint8Array (see the sandbox below) precisely to keep this rare, but a
  // realm-agnostic check is the correct way to ask the question either way.
  if (!isStream(body)) return asBytes(body);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(asBytes(c), off);
    off += c.byteLength;
  }
  return out;
}

const isStream = (b: unknown): b is ReadableStream<Uint8Array> =>
  typeof (b as { getReader?: unknown })?.getReader === "function";

/** A worker-supplied byte view as bytes we can send, whatever realm it is from. */
function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // Cross-realm views fail both checks above; their shape still tells us how
  // to read them, and a body that is none of these is a worker bug worth a
  // clear error rather than a silent empty response.
  const view = v as { buffer?: ArrayBuffer; byteOffset?: number; byteLength?: number };
  if (view?.buffer && typeof view.byteLength === "number") {
    return new Uint8Array(view.buffer, view.byteOffset ?? 0, view.byteLength);
  }
  throw new TypeError(`response body is neither bytes nor a stream (got ${typeof v})`);
}

rpc.onEvent("init", (init: {
  bundle: Uint8Array;
  config: unknown;
  address: string;
  capabilities: { socket: boolean };
}) => {
  const { bundle, config, address } = init;
  const api = buildApi(config, init.capabilities ?? { socket: false });

  // The bundle arrives as the BYTES the host hash-verified (§4) — never a
  // path — so there is no file to swap between verification and execution.
  const source = new TextDecoder().decode(bundle);

  // A fresh context, so the bundle's top-level scope is its own and cannot see
  // this module's locals (the IPC port, the abort map). This is hygiene, not a
  // security boundary: `node:vm` is not one, and does not need to be — the
  // process boundary already is.
  //
  // Concretely, and measured: any host function reachable from in there leaks
  // the host realm. `fetch.constructor` is the OUTER realm's `Function`, and
  // the Function constructor compiles its body in the global scope of the
  // realm it came from — so `fetch.constructor("return process")()` hands
  // worker code the real `process`. Two things follow, both of which have been
  // tried and neither of which works:
  //
  //   * `'use strict'` does not help. It closes stack-walking via
  //     arguments.callee and Function.prototype.caller, which is a different
  //     family. The worker bundle is already strict (esbuild emits it) and the
  //     escape works regardless.
  //   * Pruning the ambient globals below does not help either, because
  //     `anonRpcWorker.signalReady.constructor` is the same door — and the
  //     capability API cannot not be host functions, since it IS the bridge.
  //
  // Closing it for real would mean no shared object graph at all: a separate
  // V8 isolate (isolated-vm), which needs a native addon `--permission`
  // denies. So the escape stays open by design, and test/run.mjs asserts that
  // a worker which performs it is still contained by the layers underneath.
  const sandbox: Record<string, unknown> = {
    anonRpcWorker: api,
    // §3.2 notes a worker SHOULD minimise use of ambient APIs, but `fetch` is
    // what the reference passthrough worker replaces with anonymized routing,
    // so the environment that exists in a browser Web Worker is provided here
    // too. Whatever it reaches is already confined by Landlock.
    fetch,
    Request,
    Response,
    Headers,
    AbortController,
    AbortSignal,
    ReadableStream,
    WritableStream,
    // Shared deliberately: these are the types that cross the boundary in §9
    // payloads, and giving the worker a *different* Uint8Array than the one
    // the harness checks against turns every body into a cross-realm puzzle.
    Uint8Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);

  try {
    runInContext(source, context, { filename: `anon-rpc-worker:${address}` });
  } catch (e) {
    // A bundle that throws while evaluating never got the chance to
    // signalFailed for itself.
    api.signalFailed({ code: "internal-error", message: (e as Error)?.message ?? String(e) });
  }
});

// An uncaught error in worker code is unrecoverable by design (§12): report it
// as a worker failure rather than dying silently and leaving the host waiting.
process.on("uncaughtException", (e) => {
  rpc.emit("worker.failed", { code: "internal-error", message: e?.message ?? String(e) });
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  rpc.emit("worker.failed", {
    code: "internal-error",
    message: (e as Error)?.message ?? String(e),
  });
  process.exit(1);
});
