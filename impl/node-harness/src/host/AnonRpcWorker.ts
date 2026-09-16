// §5 — the host-side harness API, for Node.
//
// Same shape as the browser harness's AnonRpcWorker, over a different
// boundary: instead of a Web Worker inside a null-origin iframe, the worker
// bundle runs in a QuickJS interpreter compiled to WASM, on a worker_thread.
// The §7 capability API the worker sees is identical, which is the property
// Appendix A claims and this file is the second data point for.
//
// The substantive difference from both the browser harness and this harness's
// earlier Landlock-process strategy: the guest has NO ambient platform. A
// browser Web Worker comes with `fetch`, and the process-based path could only
// confine what `fetch` reached. Here there is nothing to confine — the isolate
// has no network, no filesystem and no syscalls — so every capability is
// something this file decides to install. `fetch` included.

import { CallQueue } from "./call-queue.js";
import { spawnIsolate, type IsolateLimits, type SpawnedIsolate } from "./isolation.js";
import { installSocketBridge } from "./socket-bridge-host.js";
import { installFetchBridge } from "./fetch-bridge-host.js";
import type { AddressPolicy } from "./address-policy.js";
import { fetchAndVerifyBundle, readSpecifier } from "./specifier.js";
import { Rpc, RpcError, abortError, type PortLike } from "../protocol.js";
import type { GuestPayload, GuestReply } from "../child/isolate-thread.js";
import type { AnonFetchResponse, AnonRequestInit, HeaderList, WorkerInit } from "../spec-types.js";

export { RpcError } from "../protocol.js";
export type { IsolateLimits } from "./isolation.js";

export type NodeWorkerInit = WorkerInit & {
  /**
   * What the guest is given. Both default to the reference worker's needs:
   * `fetch` on, `socket` off.
   *
   * There is no "ambient" setting and no way to ask for one — that is the
   * point of the isolation strategy. A capability that is off is not filtered,
   * it is absent, and `if (anonRpcWorker.socket)` in worker code answers
   * truthfully.
   */
  capabilities?: {
    /**
     * A bridged `fetch`, performed by the host under its address policy. On by
     * default because a worker that cannot reach the network cannot forward
     * RPC, which is the entire job; the policy, not the grant, is what keeps
     * it from reaching the host's own network.
     */
    fetch?: boolean;
    /**
     * Bridged TCP (`anonRpcWorker.socket`), also under the address policy.
     * Off by default. This is what lets a native tor-js reach the Tor network
     * without KPS gateways.
     */
    socket?: boolean;
  };

  /** Shared by both network capabilities. */
  network?: {
    /**
     * Which addresses either capability may reach. Deny-by-default against the
     * host's own network: loopback, RFC1918, CGNAT, link-local (where cloud
     * instance metadata, and therefore the host's IAM identity, lives).
     */
    policy?: AddressPolicy;
    /** Cap on concurrent bridged sockets. */
    maxConcurrent?: number;
    /** The `fetch` the host performs with. Injectable so tests need no network. */
    fetchImpl?: typeof fetch;
  };

  /** Guest heap cap and execution deadline. See isolate.ts. */
  limits?: IsolateLimits;
};

/**
 * A queued inbound fetch call, waiting for the worker to accept it.
 *
 * `signal` deliberately does not cross: nothing but JSON and bytes reaches the
 * guest, so the host keeps the signal and forwards aborts as a `call.abort`
 * event, which the prelude turns back into a real AbortSignal for the worker
 * (§9).
 */
type PendingCall = {
  id: number;
  url: string;
  wire?: AnonRequestInit;
  signal?: AbortSignal;
  resolve: (r: AnonFetchResponse) => void;
  reject: (e: unknown) => void;
};

export class AnonRpcWorker {
  readonly ready: Promise<void>;

  #rpc?: Rpc;
  #queue = new CallQueue<PendingCall>();
  #inFlight = new Map<number, PendingCall>();
  #nextCallId = 1;
  #resolveReady!: () => void;
  #rejectReady!: (e: unknown) => void;
  #readySettled = false;
  // Set once the worker has failed or been closed. Failure is final (§7), so
  // this is the single gate every later call checks.
  #dead?: Error;
  #isolate?: SpawnedIsolate;
  #disposers: (() => void)[] = [];

  constructor(init: NodeWorkerInit) {
    this.ready = new Promise<void>((res, rej) => {
      this.#resolveReady = res;
      this.#rejectReady = rej;
    });
    // Calls made before `ready` resolves are buffered rather than dropped
    // (§8), so boot failures surface through `ready` and through those calls.
    this.#boot(init).catch((e) => this.#fail(e instanceof Error ? e : new Error(String(e))));

    // `fetch` is handed to viem/ethers/whatever as a free function, so it must
    // not depend on how it is called.
    this.fetch = this.fetch.bind(this);
  }

  async #boot(init: NodeWorkerInit): Promise<void> {
    const provider = init.preExisting?.rpcProvider;
    if (!provider) {
      throw new Error("preExisting.rpcProvider is required to read the specifier (§4)");
    }

    // §4: read the pinned hash, fetch bytes from a resolver, accept only bytes
    // whose keccak256 matches. This happens on the HOST, before the isolate
    // exists — the bytes are verified before anything is asked to run them.
    const spec = await readSpecifier(provider, init.address);
    const bundle = await fetchAndVerifyBundle(spec);

    const capabilities = {
      fetch: init.capabilities?.fetch ?? true,
      socket: init.capabilities?.socket ?? false,
    };

    const isolate = spawnIsolate();
    this.#isolate = isolate;
    if (this.#dead) {
      // close() landed while the specifier was being read.
      void isolate.stop();
      throw this.#dead;
    }

    const rpc = new Rpc(threadPort(isolate));
    this.#rpc = rpc;
    this.#wire(rpc, isolate);

    // Only what was granted gets a host half. An installed handler for a
    // capability the guest does not have would be dead code the guest cannot
    // reach — but it would also be a handler waiting for a method name, and
    // the point of this design is that there is nothing to wait for.
    if (capabilities.fetch) {
      this.#disposers.push(
        installFetchBridge(rpc, {
          policy: init.network?.policy,
          fetchImpl: init.network?.fetchImpl,
        }),
      );
    }
    if (capabilities.socket) {
      this.#disposers.push(
        installSocketBridge(rpc, {
          policy: init.network?.policy,
          maxConcurrent: init.network?.maxConcurrent,
        }),
      );
    }

    rpc.emit("init", {
      bundle,
      config: init.config,
      address: init.address,
      capabilities,
      limits: init.limits,
    });
  }

  #wire(rpc: Rpc, isolate: SpawnedIsolate): void {
    rpc.onEvent("worker.ready", () => {
      if (this.#readySettled || this.#dead) return;
      this.#readySettled = true;
      this.#resolveReady();
    });

    rpc.onEvent("worker.failed", (payload: GuestPayload) => {
      const reason = (payload?.args ?? {}) as { code?: string; message?: string };
      this.#fail(
        new RpcError({
          name: "AnonRpcWorkerError",
          message: reason.message ?? "worker signalled failure",
          ...(reason.code ? { code: reason.code } : {}),
        }),
      );
    });

    // §8: the worker pulls calls one at a time; the queue applies the
    // backpressure. An aborted accept withdraws the taker without consuming.
    rpc.on("call.accept", async (_payload: GuestPayload, ctx): Promise<GuestReply> => {
      const call = await this.#queue.take(ctx.signal);
      this.#inFlight.set(call.id, call);
      // The request BODY travels in the bytes slot, not inside the JSON.
      const { body, ...rest } = call.wire ?? {};
      return {
        value: { id: call.id, kind: "fetch", url: call.url, requestInit: rest },
        ...(body instanceof Uint8Array && body.byteLength ? { bytes: body } : {}),
      };
    });

    rpc.onEvent("call.respond", (payload: GuestPayload) => {
      const r = (payload?.args ?? {}) as {
        id?: number;
        status?: number;
        headers?: HeaderList;
        url?: string;
      };
      const call = typeof r.id === "number" ? this.#inFlight.get(r.id) : undefined;
      if (!call) return; // response for a call that was already failed
      this.#inFlight.delete(r.id!);
      call.resolve({
        status: r.status ?? 200,
        headers: r.headers ?? [],
        body: payload?.bytes ?? new Uint8Array(0),
        url: r.url,
      });
    });

    rpc.onEvent("call.fail", (payload: GuestPayload) => {
      const f = (payload?.args ?? {}) as {
        id?: number;
        error?: { name: string; message: string; code?: string };
      };
      const call = typeof f.id === "number" ? this.#inFlight.get(f.id) : undefined;
      if (!call) return;
      this.#inFlight.delete(f.id!);
      call.reject(new RpcError(f.error ?? { name: "Error", message: "worker failed the call" }));
    });

    // §13: worker logs are diagnostic and untrusted. The prelude already
    // flattened every argument to a string inside the isolate, so nothing
    // structured — and nothing with a getter that would run guest code on this
    // thread — arrives here.
    rpc.onEvent("log", (payload: GuestPayload) => {
      const msg = (payload?.args ?? {}) as { level?: string; args?: unknown[] };
      const level = msg.level as "debug" | "info" | "warn" | "error";
      const fn = console[level] ?? console.log;
      fn("[anon-rpc worker]", ...(msg.args ?? []));
    });

    isolate.worker.on("error", (e) =>
      this.#fail(new Error(`isolate thread errored: ${e?.message ?? String(e)}`)),
    );
    isolate.worker.on("exit", (code) => {
      // Exit code 0 after close() is the normal path; anything else means the
      // thread died under the guest, which is a worker failure.
      this.#fail(new Error(`isolate thread exited unexpectedly (code ${code})`));
    });
  }

  /**
   * A standard `fetch`, routed through the isolated worker. Calls made before
   * the worker is ready are buffered in order (§8), not dropped.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.#dead) throw this.#dead;

    const { url, wire, signal } = await normalizeRequest(input, init);
    const id = this.#nextCallId++;

    const response = await new Promise<AnonFetchResponse>((resolve, reject) => {
      const call: PendingCall = { id, url, wire, signal, resolve, reject };
      if (signal) {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener(
          "abort",
          () => {
            // Not yet taken: withdraw it, and the worker never sees it (§8).
            if (this.#queue.remove(call)) return reject(abortError());
            // Already taken: tell the guest so it can abort the signal the
            // worker holds, then fail the caller regardless — an unresponsive
            // worker must not keep the caller blocked.
            if (this.#inFlight.delete(id)) {
              this.#rpc?.emit("call.abort", { id });
              reject(abortError());
            }
          },
          { once: true },
        );
      }
      this.#queue.push(call);
    });

    return new Response(response.body as Uint8Array, {
      status: response.status,
      headers: response.headers,
    });
  }

  /** Fail everything in flight and release the isolate. */
  close(): void {
    this.#fail(new Error("worker closed"));
  }

  #fail(err: Error): void {
    if (this.#dead) return; // failure is final (§7)
    this.#dead = err;

    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady(err);
    }
    // Queued but never accepted, plus accepted but never answered. Both hold a
    // promise the caller is awaiting, and a worker that died owes both an
    // answer (§12) rather than silence.
    for (const call of this.#queue.rejectAll(err)) call.reject(err);
    for (const [, call] of this.#inFlight) call.reject(err);
    this.#inFlight.clear();
    for (const d of this.#disposers.splice(0)) d();
    this.#rpc?.close(err);

    // Asked politely first so the thread can free the WASM runtime — QuickJS
    // aborts from JS_FreeRuntime if a handle is still live — then terminated
    // regardless, because the guest is untrusted and may be mid-loop.
    const isolate = this.#isolate;
    if (isolate) {
      this.#isolate = undefined;
      try {
        this.#rpc?.emit("shutdown", undefined);
      } catch {
        /* channel already gone */
      }
      void isolate.stop();
    }
  }
}

/** The thread's MessagePort as the transport the protocol expects. */
function threadPort(isolate: SpawnedIsolate): PortLike {
  return {
    // A terminated thread is not an error worth throwing here: #fail is
    // already on its way from the 'exit' handler with a better message.
    postMessage: (msg) => {
      try {
        isolate.worker.postMessage(msg);
      } catch {
        /* thread is gone */
      }
    },
    setOnMessage: (fn) => isolate.worker.on("message", (m) => fn(m)),
  };
}

/**
 * Host `fetch(input, init)` → the §9 request shape.
 *
 * Bodies are buffered to a Uint8Array. Nothing but JSON and bytes crosses into
 * the isolate, so a streaming request body has to be read before it does; §9
 * permits a stream but does not require one.
 */
async function normalizeRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ url: string; wire: AnonRequestInit; signal?: AbortSignal }> {
  const req = input instanceof Request && !init ? input : new Request(input, init);
  const headers: HeaderList = [];
  req.headers.forEach((v, k) => headers.push([k, v]));

  const wire: AnonRequestInit = { method: req.method };
  if (headers.length) wire.headers = headers;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength) wire.body = new Uint8Array(buf);
  }
  if (init?.redirect) wire.redirect = init.redirect;

  // The signal is returned alongside, never inside `wire`: the guest gets one
  // it synthesises from call.abort.
  return { url: req.url, wire, signal: init?.signal ?? undefined };
}
