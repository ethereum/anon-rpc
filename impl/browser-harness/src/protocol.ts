// Generic request/response + event RPC over a MessagePort, with transferable
// support and cross-boundary AbortSignal propagation.
//
// This is the single seam the whole capability API rides on. The host harness
// and the worker runtime each hold one end of an entangled MessageChannel port
// (§6: all capability traffic crosses the postMessage boundary).

import { RpcError, serializeError, type SerializedError } from "@anon-rpc/harness-core";

export { RpcError, serializeError, type SerializedError };

type Wire =
  | { t: "req"; id: number; method: string; args: unknown }
  | { t: "abort"; id: number }
  | { t: "res"; id: number; ok: true; value: unknown }
  | { t: "res"; id: number; ok: false; error: SerializedError }
  | { t: "evt"; topic: string; data: unknown };

export type RpcResult = { value: unknown; transfer?: Transferable[] };

export type CallOptions = { transfer?: Transferable[]; signal?: AbortSignal };

export type Handler = (
  args: any,
  ctx: { signal: AbortSignal },
) => Promise<RpcResult> | RpcResult;

export type EventHandler = (data: any) => void;

export class PortRpc {
  #port: MessagePort;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; cleanup?: () => void }
  >();
  #handlers = new Map<string, Handler>();
  #events = new Map<string, EventHandler>();
  // AbortControllers for in-flight inbound requests, keyed by caller-side id.
  #inbound = new Map<number, AbortController>();

  constructor(port: MessagePort) {
    this.#port = port;
    port.onmessage = (ev: MessageEvent) => this.#onMessage(ev.data as Wire);
    port.start?.();
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
  emit(topic: string, data: unknown, transfer?: Transferable[]): void {
    this.#post({ t: "evt", topic, data }, transfer);
  }

  /** Call a remote method and await its result. */
  call<T = unknown>(method: string, args?: unknown, opts?: CallOptions): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
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
          this.#post({ t: "abort", id });
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort);
        cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        cleanup,
      });
      this.#post({ t: "req", id, method, args }, opts?.transfer);
    });
  }

  #post(msg: Wire, transfer?: Transferable[]): void {
    this.#port.postMessage(msg, transfer ?? []);
  }

  async #onMessage(msg: Wire): Promise<void> {
    switch (msg.t) {
      case "evt": {
        this.#events.get(msg.topic)?.(msg.data);
        return;
      }
      case "abort": {
        this.#inbound.get(msg.id)?.abort(abortError());
        return;
      }
      case "res": {
        const p = this.#pending.get(msg.id);
        if (!p) return; // late response for an aborted call
        this.#pending.delete(msg.id);
        p.cleanup?.();
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new RpcError(msg.error));
        return;
      }
      case "req": {
        const handler = this.#handlers.get(msg.method);
        if (!handler) {
          this.#post({
            t: "res",
            id: msg.id,
            ok: false,
            error: { name: "Error", message: `no handler: ${msg.method}` },
          });
          return;
        }
        const ac = new AbortController();
        this.#inbound.set(msg.id, ac);
        try {
          const result = await handler(msg.args, { signal: ac.signal });
          this.#post(
            { t: "res", id: msg.id, ok: true, value: result.value },
            result.transfer,
          );
        } catch (err) {
          this.#post({
            t: "res",
            id: msg.id,
            ok: false,
            error: serializeError(err),
          });
        } finally {
          this.#inbound.delete(msg.id);
        }
        return;
      }
    }
  }
}

export function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
