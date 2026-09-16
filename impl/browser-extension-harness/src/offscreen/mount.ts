// Runs inside the offscreen document. This is where the browser harness
// actually lives — the service worker only remotes to it.
//
// The offscreen document is a real extension page: it has a DOM, so it can hold
// the sandboxed iframe §6 isolation is built from, and it has `fetch`,
// `IndexedDB` (§11) and WebRTC (§10) for the capabilities the harness
// implements. What it does not have is any extension API except
// `chrome.runtime`, which is all this needs.
//
// Two things here are not just plumbing:
//
//   * The bundle is fetched and hash-verified HERE, not in the service worker.
//     §4's provider call is proxied outward instead. That inverts the obvious
//     arrangement on purpose: the provider call is a short JSON round trip,
//     while the bundle is the one large binary payload, and keeping it off a
//     channel that base64s bytes is worth a little indirection.
//   * Booted workers OUTLIVE the service worker that asked for them. An MV3
//     service worker is killed after ~30s idle and restarted on demand, so a
//     worker tied to its lifetime would re-read the specifier and re-fetch the
//     bundle every time the extension woke up. Keyed by address+config, they
//     are reused instead.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import type { RpcProvider } from "@anon-rpc/browser-harness";
import {
  PORT_NAME,
  fromB64,
  toB64,
  toWireError,
  type FromOffscreen,
  type ToOffscreen,
} from "../wire.js";

import { chromeApi, type RuntimePort } from "../chrome-types.js";

type Entry = {
  worker: AnonRpcWorker;
  /** How many service-worker connections are currently using it. */
  refs: number;
  /** Settled once the worker signalled ready (§7), or rejected on failure. */
  ready: Promise<void>;
  /** Pending release, armed when the last connection drops. */
  reaper?: ReturnType<typeof setTimeout>;
};

export type MountOptions = {
  /**
   * How long a booted worker survives with no service worker attached, before
   * it is closed. The point of a non-zero value is MV3's service-worker
   * lifecycle: the worker should outlive the idle timeout that killed the
   * service worker, or the reuse is pointless. Default 10 minutes; `Infinity`
   * keeps workers until the offscreen document itself goes away.
   */
  idleMs?: number;
};

const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/**
 * Serve `AnonRpcWorker` instances to the extension's service worker.
 *
 * Call once, at the top level of the offscreen document's script. Safe to call
 * from an offscreen document that does other things too — it only claims ports
 * named `anon-rpc.worker`.
 */
export function mountOffscreenHost(opts: MountOptions = {}): void {
  const runtime = chromeApi().runtime;
  if (!runtime.onConnect) {
    throw new Error("mountOffscreenHost must run in an extension page with chrome.runtime.onConnect");
  }
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const cache = new Map<string, Entry>();

  runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return; // not ours; another feature's port
    serve(port, cache, idleMs);
  });
}

function serve(port: RuntimePort, cache: Map<string, Entry>, idleMs: number): void {
  const send = (msg: FromOffscreen) => {
    try {
      port.postMessage(msg);
    } catch {
      // The service worker was killed between our deciding to answer and
      // answering. Nothing to do: its next incarnation reconnects.
    }
  };

  // §4 provider calls travel out to the service worker, which owns the
  // pre-existing RPC connection.
  let nextProviderId = 1;
  const providerCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const provider: RpcProvider = {
    request: ({ method, params }) =>
      new Promise((resolve, reject) => {
        const id = nextProviderId++;
        providerCalls.set(id, { resolve, reject });
        send({ t: "provider.request", id, method, params });
      }),
  };

  let entry: Entry | undefined;
  let key: string | undefined;
  let closed = false;
  const inFlight = new Map<number, AbortController>();

  const detach = () => {
    if (closed) return;
    closed = true;
    for (const ac of inFlight.values()) ac.abort();
    inFlight.clear();
    for (const p of providerCalls.values()) p.reject(new Error("service worker disconnected"));
    providerCalls.clear();
    if (!entry || !key) return;
    if (--entry.refs > 0) return;
    // Last one out arms the reaper rather than closing: the usual reason a
    // connection drops is MV3 killing an idle service worker, and the next
    // incarnation should find the worker still booted.
    const e = entry;
    const k = key;
    if (idleMs === Infinity) return;
    e.reaper = setTimeout(() => {
      if (e.refs === 0 && cache.get(k) === e) {
        cache.delete(k);
        e.worker.close();
      }
    }, idleMs);
    // Node and the DOM disagree about the return type; unref where it exists so
    // a pending reaper cannot hold a test process open.
    (e.reaper as unknown as { unref?: () => void }).unref?.();
  };

  port.onDisconnect.addListener(detach);

  port.onMessage.addListener((raw) => {
    const msg = raw as ToOffscreen;
    switch (msg?.t) {
      case "boot": {
        // A distinct config is a distinct worker: §7.1 fixes config for the
        // worker's lifetime, so two configs cannot share one. iframeUrl is in
        // the key for the same reason — it is part of how the worker was
        // constructed, and leaving it out meant a caller asking for a
        // different isolation document silently got a worker built with the
        // previous one.
        key = `${msg.address.toLowerCase()}::${msg.iframeUrl}::${stableStringify(msg.config)}`;
        const hit = msg.reuse ? cache.get(key) : undefined;
        if (hit) {
          clearTimeout(hit.reaper);
          hit.reaper = undefined;
          hit.refs++;
          entry = hit;
        } else {
          cache.get(key)?.worker.close(); // a re-boot replaces any existing one
          const worker = new AnonRpcWorker({
            address: msg.address,
            config: msg.config,
            preExisting: { rpcProvider: provider },
            iframeUrl: msg.iframeUrl,
          });
          entry = { worker, refs: 1, ready: worker.ready };
          cache.set(key, entry);
        }
        entry.ready.then(
          () => send({ t: "ready" }),
          (e) => send({ t: "failed", error: toWireError(e) }),
        );
        return;
      }

      case "fetch": {
        if (!entry) {
          send({ t: "response", callId: msg.callId, ok: false, error: { name: "Error", message: "not booted" } });
          return;
        }
        const ac = new AbortController();
        inFlight.set(msg.callId, ac);
        const body = fromB64(msg.body);
        void entry.worker
          .fetch(msg.url, {
            method: msg.request.method,
            headers: msg.request.headers,
            ...(body ? { body: body as BodyInit } : {}),
            ...(msg.request.redirect ? { redirect: msg.request.redirect } : {}),
            signal: ac.signal,
          })
          .then(
            async (res) => {
              const bytes = new Uint8Array(await res.arrayBuffer());
              const headers: [string, string][] = [];
              res.headers.forEach((v, k2) => headers.push([k2, v]));
              inFlight.delete(msg.callId);
              send({
                t: "response",
                callId: msg.callId,
                ok: true,
                status: res.status,
                headers,
                url: res.url || undefined,
                body: toB64(bytes),
              });
            },
            (e) => {
              inFlight.delete(msg.callId);
              send({ t: "response", callId: msg.callId, ok: false, error: toWireError(e) });
            },
          );
        return;
      }

      case "abort":
        inFlight.get(msg.callId)?.abort();
        inFlight.delete(msg.callId);
        return;

      case "provider.result": {
        const call = providerCalls.get(msg.id);
        if (!call) return;
        providerCalls.delete(msg.id);
        if (msg.ok) call.resolve(msg.value);
        else {
          const e = new Error(msg.error.message);
          e.name = msg.error.name;
          if (msg.error.code) (e as Error & { code: string }).code = msg.error.code;
          call.reject(e);
        }
        return;
      }

      case "close": {
        // An explicit close is the caller saying they are done with this
        // worker, not MV3 reclaiming an idle service worker — so it really
        // closes, rather than arming the reaper.
        if (entry && key) {
          entry.refs--;
          if (entry.refs <= 0 && cache.get(key) === entry) {
            cache.delete(key);
            entry.worker.close();
          }
          entry = undefined;
        }
        detach();
        return;
      }
    }
  });
}

/**
 * Key-order-independent JSON, so `{a:1,b:2}` and `{b:2,a:1}` are one cache
 * entry. Two structurally identical configs producing two workers would be a
 * silent doubling of everything the harness does.
 */
function stableStringify(v: unknown): string {
  if (v === undefined) return " undefined";
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return val;
  });
}
