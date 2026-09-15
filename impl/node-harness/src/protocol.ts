// Generic request/response + event RPC, with cross-boundary AbortSignal
// propagation. This is the single seam the whole capability API rides on.
//
// Adapted from the browser harness's protocol.ts, which runs the same wire
// shape over a MessagePort. Two deliberate differences:
//
//   * The port is an interface (`PortLike`) rather than a MessagePort, because
//     here each end is a Node IPC channel — `child.send`/`process.send` with
//     `serialization: "advanced"`, so V8 structured clone and therefore
//     Uint8Array payloads work in both directions.
//   * No transferables. Node's IPC cannot transfer objects, so streams are
//     buffered by whichever side holds them (see §9 handling in worker-host).
//     That is the one place this transport is weaker than the browser's, and
//     the reason a per-stream socketpair is the next thing to try.
//
// Keeping the wire shape identical to the browser harness is the point: §7's
// capability API is meant to be transport-neutral (Appendix A), and two
// harnesses agreeing on framing while disagreeing on transport is the evidence.

export type SerializedError = { name: string; message: string; code?: string };

type Wire =
  | { t: "req"; id: number; method: string; args: unknown }
  | { t: "abort"; id: number }
  | { t: "res"; id: number; ok: true; value: unknown }
  | { t: "res"; id: number; ok: false; error: SerializedError }
  | { t: "evt"; topic: string; data: unknown };

/**
 * The minimum a transport must offer: post a clonable value, receive one.
 *
 * `handle` is this transport's answer to the browser's `transfer`: Node's IPC
 * can carry one OS file descriptor alongside a message (SCM_RIGHTS), and
 * delivers the two together on the same event — so a handle needs no
 * correlation scheme of its own, it arrives attached to its own `res` frame.
 * One per message, hence singular.
 */
export type PortLike = {
  postMessage(msg: unknown, handle?: unknown): void;
  setOnMessage(fn: (msg: unknown, handle?: unknown) => void): void;
};

/** Returned by a handler that wants to send a descriptor with its result. */
export class HandleResult {
  constructor(
    readonly value: unknown,
    readonly handle: unknown,
  ) {}
}

/** Attach an OS handle to a handler's result; see Rpc.callWithHandle. */
export function withHandle<T>(value: T, handle: unknown): HandleResult {
  return new HandleResult(value, handle);
}

export type CallOptions = { signal?: AbortSignal };

export type Handler = (args: any, ctx: { signal: AbortSignal }) => Promise<unknown> | unknown;

export type EventHandler = (data: any) => void;

export class RpcError extends Error {
  code?: string;
  constructor(e: SerializedError) {
    super(e.message);
    this.name = e.name;
    this.code = e.code;
  }
}

/** The one error-marshalling implementation; pair with `new RpcError(...)`. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: "Error", message: String(err) };
}

export class Rpc {
  #port: PortLike;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      cleanup?: () => void;
      wantHandle?: boolean;
    }
  >();
  #handlers = new Map<string, Handler>();
  #events = new Map<string, EventHandler>();
  // AbortControllers for in-flight inbound requests, keyed by caller-side id.
  #inbound = new Map<number, AbortController>();
  #closed = false;

  constructor(port: PortLike) {
    this.#port = port;
    port.setOnMessage((msg, handle) => void this.#onMessage(msg as Wire, handle));
  }

  /** Register a handler for an inbound method. */
  on(method: string, handler: Handler): void {
    this.#handlers.set(method, handler);
  }

  /** Register a handler for an inbound fire-and-forget event. */
  onEvent(topic: string, handler: EventHandler): void {
    this.#events.set(topic, handler);
  }

  /** Fire-and-forget event to the peer. */
  emit(topic: string, data: unknown): void {
    if (this.#closed) return;
    this.#port.postMessage({ t: "evt", topic, data } satisfies Wire);
  }

  /** Call a remote method and await its result. */
  call<T = unknown>(method: string, args?: unknown, opts?: CallOptions): Promise<T> {
    return this.#send(method, args, opts, false) as Promise<T>;
  }

  /**
   * Call a remote method that answers with an OS handle as well as a value —
   * a connected socket, or one end of a socketpair. The handle is whatever the
   * transport delivered; on Node's IPC that is a live `net.Socket`, already
   * owned by this process (the sender's copy is closed on send).
   */
  callWithHandle<T = unknown>(
    method: string,
    args?: unknown,
    opts?: CallOptions,
  ): Promise<{ value: T; handle?: unknown }> {
    return this.#send(method, args, opts, true) as Promise<{ value: T; handle?: unknown }>;
  }

  #send(method: string, args: unknown, opts: CallOptions | undefined, wantHandle: boolean): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error("rpc channel is closed"));
        return;
      }
      let cleanup: (() => void) | undefined;
      if (opts?.signal) {
        const signal = opts.signal;
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        // Abort rejects locally as well as notifying the peer — the caller must
        // not stay blocked on a peer that never answers (that unresponsiveness
        // is exactly what abort is for). A late "res" is then ignored.
        const onAbort = () => {
          if (!this.#pending.delete(id)) return;
          this.#port.postMessage({ t: "abort", id } satisfies Wire);
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort);
        cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, cleanup, wantHandle });
      this.#port.postMessage({ t: "req", id, method, args } satisfies Wire);
    });
  }

  /** Fail every in-flight call. Used when the peer dies or the worker fails. */
  close(err: unknown): void {
    this.#closed = true;
    for (const [, p] of this.#pending) {
      p.cleanup?.();
      p.reject(err);
    }
    this.#pending.clear();
    for (const [, ac] of this.#inbound) ac.abort(err);
    this.#inbound.clear();
  }

  async #onMessage(msg: Wire, handle?: unknown): Promise<void> {
    switch (msg.t) {
      case "evt":
        this.#events.get(msg.topic)?.(msg.data);
        return;
      case "abort":
        this.#inbound.get(msg.id)?.abort(abortError());
        return;
      case "res": {
        const p = this.#pending.get(msg.id);
        if (!p) return; // late response for an aborted call
        this.#pending.delete(msg.id);
        p.cleanup?.();
        if (msg.ok) p.resolve(p.wantHandle ? { value: msg.value, handle } : msg.value);
        else p.reject(new RpcError(msg.error));
        return;
      }
      case "req": {
        const handler = this.#handlers.get(msg.method);
        if (!handler) {
          this.#port.postMessage({
            t: "res",
            id: msg.id,
            ok: false,
            error: { name: "Error", message: `no handler: ${msg.method}` },
          } satisfies Wire);
          return;
        }
        const ac = new AbortController();
        this.#inbound.set(msg.id, ac);
        try {
          const result = await handler(msg.args, { signal: ac.signal });
          const [value, outHandle] =
            result instanceof HandleResult ? [result.value, result.handle] : [result, undefined];
          if (!this.#closed) {
            this.#port.postMessage({ t: "res", id: msg.id, ok: true, value } satisfies Wire, outHandle);
          }
        } catch (err) {
          if (!this.#closed) {
            this.#port.postMessage({
              t: "res",
              id: msg.id,
              ok: false,
              error: serializeError(err),
            } satisfies Wire);
          }
        } finally {
          this.#inbound.delete(msg.id);
        }
        return;
      }
    }
  }
}

export function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}
