// §5 — the host-side harness API, for Node.
//
// Same shape as the browser harness's AnonRpcWorker, over a different
// boundary: instead of a Web Worker inside a null-origin iframe, the worker
// runs in a Landlock-confined child process (see confinement.ts and
// ../../README.md). The §7 capability API the worker sees is identical, which
// is the property Appendix A claims and this file is the second data point for.

import { CallQueue } from "./call-queue.js";
import { spawnWorkerProcess, type Confinement } from "./confinement.js";
import { installSocketBridge } from "./socket-bridge-host.js";
import type { AddressPolicy } from "./address-policy.js";
import { fetchAndVerifyBundle, readSpecifier } from "./specifier.js";
import { Rpc, RpcError, abortError, type PortLike } from "../protocol.js";
import type {
  AnonFetchResponse,
  AnonRequestInit,
  HeaderList,
  WorkerInit,
} from "../spec-types.js";

export { RpcError } from "../protocol.js";
export type { Confinement } from "./confinement.js";

export type NodeWorkerInit = WorkerInit & {
  /** Defaults to Landlock confinement; see Confinement for the opt-out. */
  confinement?: Confinement;
  /**
   * The worker's network. By default it gets none of its own — Landlock denies
   * every TCP connect in the child — and reaches the outside through the
   * bridged `anonRpcWorker.socket` capability, which this host mediates.
   *
   * `ambient: true` instead leaves the child's own sockets working and does NOT
   * offer the capability, which is what a worker written against the browser
   * platform needs (the reference passthrough worker answers calls with a plain
   * `fetch`). It is the weaker setting: such a worker can reach the host's
   * loopback and LAN.
   */
  network?: {
    ambient?: boolean;
    /** Address policy for the bridged capability. Ignored when ambient. */
    policy?: AddressPolicy;
    /** Cap on concurrent bridged sockets; each is an fd in both processes. */
    maxConcurrent?: number;
  };
};

/**
 * A queued inbound fetch call, waiting for the worker to accept it.
 *
 * `wire` is what crosses the boundary; `signal` deliberately does not. An
 * AbortSignal is not structured-cloneable, so the host keeps it and forwards
 * aborts as a `call.abort` event, which the child turns back into a real
 * signal for the worker (§9).
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
  #child?: ReturnType<typeof spawnWorkerProcess>;
  #disposeSocketBridge?: () => void;

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
    // whose keccak256 matches. This happens on the HOST, before any sandbox
    // exists — the bytes are verified before anything is asked to run them.
    const spec = await readSpecifier(provider, init.address);
    const bundle = await fetchAndVerifyBundle(spec);

    const confinement = init.confinement ?? { kind: "landlock" };
    if (confinement.kind === "none" && !confinement.acknowledgeUnconfined) {
      throw new Error("confinement { kind: 'none' } requires acknowledgeUnconfined: true");
    }

    const ambient = init.network?.ambient ?? false;
    const spawned = spawnWorkerProcess(confinement, { ambientNetwork: ambient });
    this.#child = spawned;
    if (this.#dead) {
      // close() landed while the specifier was being read.
      spawned.child.kill("SIGKILL");
      throw this.#dead;
    }

    // Do not hand untrusted code to a process whose sandbox is unconfirmed.
    await spawned.confined;

    const rpc = new Rpc(childPort(spawned.child));
    this.#rpc = rpc;
    this.#wire(rpc, spawned);

    // The capability is offered only when the child has no network of its own.
    // Offering both would be pointless: a worker that can dial directly has no
    // use for a mediated dial, and the address policy would guard nothing.
    if (!ambient) {
      this.#disposeSocketBridge = installSocketBridge(rpc, {
        policy: init.network?.policy,
        maxConcurrent: init.network?.maxConcurrent,
      });
    }

    // The worker receives the verified BYTES, not a path: nothing is written to
    // disk, so the sandbox needs no grant for it and there is no window in
    // which a third party could swap the file after verification.
    rpc.emit("init", {
      bundle,
      config: init.config,
      address: init.address,
      capabilities: { socket: !ambient },
    });
  }

  #wire(rpc: Rpc, spawned: ReturnType<typeof spawnWorkerProcess>): void {
    rpc.onEvent("worker.ready", () => {
      if (this.#readySettled || this.#dead) return;
      this.#readySettled = true;
      this.#resolveReady();
    });

    rpc.onEvent("worker.failed", (reason: { code?: string; message?: string } | undefined) => {
      const err = new RpcError({
        name: "AnonRpcWorkerError",
        message: reason?.message ?? "worker signalled failure",
        ...(reason?.code ? { code: reason.code } : {}),
      });
      this.#fail(err);
    });

    // §8: the worker pulls calls one at a time; the queue applies the
    // backpressure. An aborted accept withdraws the taker without consuming.
    rpc.on("call.accept", async (_args, ctx) => {
      const call = await this.#queue.take(ctx.signal);
      this.#inFlight.set(call.id, call);
      return { id: call.id, kind: "fetch", url: call.url, requestInit: call.wire };
    });

    rpc.onEvent("call.respond", (msg: { id: number; response: AnonFetchResponse }) => {
      const call = this.#inFlight.get(msg.id);
      if (!call) return; // response for a call that was already failed
      this.#inFlight.delete(msg.id);
      call.resolve(msg.response);
    });

    rpc.onEvent("call.fail", (msg: { id: number; error: { name: string; message: string; code?: string } }) => {
      const call = this.#inFlight.get(msg.id);
      if (!call) return;
      this.#inFlight.delete(msg.id);
      call.reject(new RpcError(msg.error));
    });

    // §13: worker logs are diagnostic and untrusted. They are prefixed and
    // routed to the host's console rather than thrown away, and never parsed.
    rpc.onEvent("log", (msg: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }) => {
      const fn = console[msg.level] ?? console.log;
      fn("[anon-rpc worker]", ...msg.args);
    });

    spawned.child.once("exit", (code, signal) => {
      this.#fail(
        new Error(
          `worker process exited unexpectedly (code ${code}, signal ${signal}): ${spawned.stderr()}`,
        ),
      );
    });
  }

  /**
   * A standard `fetch`, routed through the sandboxed worker. Calls made before
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
            // Already taken: tell the child so it can abort the signal it
            // handed the worker, then fail the caller regardless — an
            // unresponsive worker must not keep the caller blocked.
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

    // The child buffers response bodies before they cross the IPC channel
    // (see worker-host.ts), so by here the body is always bytes.
    const body = response.body as Uint8Array;
    return new Response(body, { status: response.status, headers: response.headers });
  }

  /** Fail everything in flight and release the worker process. */
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
    this.#queue.rejectAll(err);
    for (const [, call] of this.#inFlight) call.reject(err);
    this.#inFlight.clear();
    this.#disposeSocketBridge?.();
    this.#rpc?.close(err);

    const child = this.#child?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // The worker is untrusted and may ignore a polite request, so SIGKILL is
      // the backstop. Landlock denies it nothing that would let it survive.
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 2000);
      t.unref?.();
      child.once("exit", () => clearTimeout(t));
    }
    // The process is gone; nothing is left to unref the IPC channel.
    child?.unref?.();
  }
}

/** Node's IPC channel as the transport the protocol expects. */
function childPort(child: import("node:child_process").ChildProcess): PortLike {
  return {
    postMessage: (msg, handle) => {
      // A dead channel is not an error worth throwing here: #fail is already
      // on its way from the 'exit' handler with a better message.
      if (!child.connected) return;
      // Passing a descriptor transfers it: node closes this process's copy once
      // it is sent, which is what makes the bridge a handoff rather than a tap.
      child.send(msg as object, (handle ?? null) as never, (err) => void err);
    },
    setOnMessage: (fn) => child.on("message", (m, handle) => fn(m, handle)),
  };
}

/**
 * Host `fetch(input, init)` → the §9 request shape.
 *
 * Bodies are buffered to a Uint8Array: Node's IPC cannot transfer a stream, so
 * a streaming request body has to be read before it crosses. This is the
 * transport limitation called out in protocol.ts, and the one thing a
 * socketpair-per-stream design would remove.
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

  // The signal is returned alongside, never inside `wire`: it is not
  // structured-cloneable, and the child synthesises its own from call.abort.
  return { url: req.url, wire, signal: init?.signal ?? undefined };
}
