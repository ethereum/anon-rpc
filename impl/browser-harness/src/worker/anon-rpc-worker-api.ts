// Worker side of the capability API. Builds the `anonRpcWorker` object that
// untrusted worker code sees as its entire platform (§7). Every method is a thin
// proxy across the capability port; KPS stream byte flow rides transferred
// WHATWG streams, so only lifecycle calls round-trip.

import type {
  AnonRpcWorkerApi,
  FetchCall,
  IncomingCall,
  AnonFetchResponse,
  AnonRequestInit,
  KpsApi,
  KpsConn,
  KpsStream,
  KpsConnCloseInfo,
  KpsStreamCloseInfo,
  KpsReason,
  StorageApi,
  StorageKey,
  LogApi,
  LogArg,
  PlainValue,
} from "../spec-types.js";
import { PortRpc, serializeError } from "../protocol.js";

type StreamParts = {
  streamId: number;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

// The host's WireRequestInit (normalize-request.ts), as it crosses the port.
type WireRequestInit = Pick<AnonRequestInit, "method" | "headers" | "body" | "redirect"> & {
  hasSignal?: boolean;
  forwarded?: { [key: string]: PlainValue };
};

type AcceptedCall = {
  callId: number;
  url: string;
  requestInit?: WireRequestInit;
};

export function makeWorkerApi(rpc: PortRpc, config?: PlainValue): AnonRpcWorkerApi {
  // AbortControllers for delivered calls; host emits "call-abort" when its
  // fetch caller aborts (the call's signal originates host-side). An abort can
  // race the acceptCall response across the port, so aborts for calls not yet
  // registered are remembered and applied on delivery.
  const callAborts = new Map<number, AbortController>();
  const preAborted = new Set<number>();
  rpc.onEvent("call-abort", ({ callId }: { callId: number }) => {
    const ac = callAborts.get(callId);
    if (ac) ac.abort(new DOMException("aborted", "AbortError"));
    else preAborted.add(callId);
  });

  // Close info is pushed by the host when the underlying stream/conn settles
  // (which is also when the host prunes its registries); each proxy holds a
  // deferred that the single event handler resolves.
  const streamClosed = new Map<number, (info: KpsStreamCloseInfo) => void>();
  const connClosed = new Map<number, (info: KpsConnCloseInfo) => void>();
  rpc.onEvent("stream.closed", ({ streamId, info }: { streamId: number; info: KpsStreamCloseInfo }) => {
    streamClosed.get(streamId)?.(info);
    streamClosed.delete(streamId);
  });
  rpc.onEvent("conn.closed", ({ connId, info }: { connId: number; info: KpsConnCloseInfo }) => {
    connClosed.get(connId)?.(info);
    connClosed.delete(connId);
  });

  function makeStream(p: StreamParts): KpsStream {
    const closed = new Promise<KpsStreamCloseInfo>((resolve) => streamClosed.set(p.streamId, resolve));
    return {
      readable: p.readable,
      writable: p.writable,
      closeWrite: () => rpc.call("stream.closeWrite", { streamId: p.streamId }),
      cancelRead: (reason?: KpsReason) => rpc.call("stream.cancelRead", { streamId: p.streamId, reason }),
      resetWrite: (reason?: KpsReason) => rpc.call("stream.resetWrite", { streamId: p.streamId, reason }),
      close: (reason?: KpsReason) => rpc.call("stream.close", { streamId: p.streamId, reason }),
      closed,
    };
  }

  function makeConn(connId: number, remoteAddress: { ip: string; port: number }): KpsConn {
    const closed = new Promise<KpsConnCloseInfo>((resolve) => connClosed.set(connId, resolve));
    return {
      remoteAddress,
      openStream: async (opts) =>
        makeStream(await rpc.call<StreamParts>("conn.openStream", { connId }, sigOpt(opts))),
      acceptStream: async (opts) =>
        makeStream(await rpc.call<StreamParts>("conn.acceptStream", { connId }, sigOpt(opts))),
      close: (reason?: KpsReason) => rpc.call("conn.close", { connId, reason }),
      sendDatagram: (data, opts) => rpc.call("conn.sendDatagram", { connId, data }, sigOpt(opts)),
      receiveDatagram: (opts) => rpc.call<Uint8Array>("conn.receiveDatagram", { connId }, sigOpt(opts)),
      closed,
    };
  }

  const kps: KpsApi = {
    dial: async (addr, opts) => {
      const { connId, remoteAddress } = await rpc.call<{
        connId: number;
        remoteAddress: { ip: string; port: number };
      }>("kps.dial", { addr }, sigOpt(opts));
      return makeConn(connId, remoteAddress);
    },
    openStream: async (addr, opts) =>
      makeStream(await rpc.call<StreamParts>("kps.openStream", { addr }, sigOpt(opts))),
  };

  const storage: StorageApi = {
    get: (key, opts) => rpc.call("storage.get", { key }, sigOpt(opts)),
    set: (key, value, opts) => rpc.call("storage.set", { key, value }, sigOpt(opts)),
    delete: (key, opts) => rpc.call("storage.delete", { key }, sigOpt(opts)),
    has: (key, opts) => rpc.call("storage.has", { key }, sigOpt(opts)),
    clear: (opts) => rpc.call("storage.clear", { prefix: opts?.prefix }, sigOpt(opts)),
    list: (opts) => listKeys(rpc, opts?.prefix, opts?.signal),
  };

  const log: LogApi = {
    debug: (...args: LogArg[]) => rpc.emit("log", { level: "debug", args }),
    info: (...args: LogArg[]) => rpc.emit("log", { level: "info", args }),
    warn: (...args: LogArg[]) => rpc.emit("log", { level: "warn", args }),
    error: (...args: LogArg[]) => rpc.emit("log", { level: "error", args }),
  };

  // acceptCall abort handling lives HERE, not at the RPC layer: a transport-
  // level abort can lose the race with delivery, in which case the host has
  // already consumed a call from its queue and the res is silently dropped —
  // the call would be lost (§8 forbids that). Instead the RPC runs to
  // completion, and if it delivers after the abort, the call is handed back
  // to the host for redelivery.
  function acceptCall(opts?: { signal?: AbortSignal }): Promise<IncomingCall> {
    const abortErr = () => new DOMException("aborted", "AbortError");
    const signal = opts?.signal;
    const toCall = (r: AcceptedCall) =>
      makeFetchCall(rpc, callAborts, preAborted, r.callId, r.url, r.requestInit);
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortErr());
    const pending = rpc.call<AcceptedCall>("acceptCall", {});
    if (!signal) return pending.then(toCall);
    return new Promise<IncomingCall>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        // If the host still delivers, return the call for redelivery.
        pending.then((r) => rpc.emit("requeue-call", { callId: r.callId }), () => {});
        reject(signal.reason ?? abortErr());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (r) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(toCall(r));
        },
        (e) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  return {
    signalReady: () => rpc.emit("ready", {}),
    // Failure finality (§7: later signals ignored) is enforced host-side —
    // #fail is one-shot and resolving an already-rejected ready is a no-op.
    signalFailed: (reason?: { code?: string; message?: string }) =>
      rpc.emit("failed", { reason }),
    acceptCall,
    config,
    kps,
    storage,
    log,
  };
}

function makeFetchCall(
  rpc: PortRpc,
  callAborts: Map<number, AbortController>,
  preAborted: Set<number>,
  callId: number,
  url: string,
  wireInit?: WireRequestInit,
): FetchCall {
  let requestInit: AnonRequestInit | undefined;
  if (wireInit) {
    const { hasSignal, forwarded, ...rest } = wireInit;
    // §9.1: forwarded entries sit beside the modeled fields, under their own
    // keys (never a modeled one — the host excluded those). Spread defines
    // properties, so a forwarded "__proto__" stays an own key.
    requestInit = { ...forwarded, ...rest };
    if (hasSignal) {
      const ac = new AbortController();
      callAborts.set(callId, ac);
      requestInit = { ...requestInit, signal: ac.signal };
      // The host's abort may have crossed the port before this call arrived.
      if (preAborted.delete(callId)) ac.abort(new DOMException("aborted", "AbortError"));
    }
  }

  let responded = false;
  return {
    kind: "fetch",
    url,
    ...(requestInit ? { requestInit } : {}),
    respond(response: AnonFetchResponse | Promise<AnonFetchResponse>) {
      if (responded) throw new Error("respond() called more than once");
      responded = true;
      Promise.resolve(response)
        .then((r) => {
          // respond() hands the body off: streams are transferred, and a
          // Uint8Array's buffer is too (a multi-MB response must not be
          // structured-cloned). Worker code must not reuse the buffer after
          // responding with it.
          const transfer =
            r.body instanceof ReadableStream
              ? [r.body as unknown as Transferable]
              : r.body instanceof Uint8Array
                ? [r.body.buffer as unknown as Transferable]
                : [];
          return rpc.call("respond", { callId, ok: true, response: r }, { transfer });
        })
        .catch((e: unknown) =>
          // Carry name/code across the boundary (§12): host logic may branch
          // on code, never on message text.
          rpc.call("respond", { callId, ok: false, error: serializeError(e) }),
        )
        .catch(() => {}) // the failure respond itself may be refused (e.g. call already aborted)
        .finally(() => callAborts.delete(callId));
    },
  };
}

async function* listKeys(rpc: PortRpc, prefix?: string, signal?: AbortSignal): AsyncIterable<StorageKey> {
  const keys = await rpc.call<StorageKey[]>("storage.list", { prefix }, signal ? { signal } : undefined);
  for (const k of keys) yield k;
}

function sigOpt(opts?: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return opts?.signal ? { signal: opts.signal } : undefined;
}
