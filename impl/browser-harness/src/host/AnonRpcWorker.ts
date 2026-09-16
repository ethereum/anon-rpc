// §5 — Host-side harness API: `AnonRpcWorker`.
//
// Responsibilities (§3.1): verify bundle integrity (§4), run the worker under
// §6 isolation (Web Worker inside a null-origin sandboxed iframe), implement the
// capability API for the worker, and expose `fetch` to the host.

import type { WorkerInit, AnonFetchResponse } from "../spec-types.js";
import { PortRpc, RpcError, type SerializedError } from "../protocol.js";
import { readSpecifier, fetchAndVerifyBundle } from "./specifier.js";
import { registerKpsBridge } from "./kps-bridge-host.js";
import { CallQueue } from "./call-queue.js";
import { normalizeRequest, type WireRequestInit } from "./normalize-request.js";
import { openStorageBackend, type StorageBackend } from "./idb-storage.js";

// Injected at build time (see build.mjs): source text the null-origin iframe
// blob-spawns, since an opaque-origin iframe cannot load host-origin scripts.
declare const __WORKER_RUNTIME_SRC__: string;
declare const __IFRAME_BOOT_SRC__: string;

type CallRecord = {
  callId: number;
  url: string;
  requestInit?: WireRequestInit;
  bodyTransfer?: Transferable[];
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  // Detaches the host-signal abort listener; called when the call settles.
  cleanup?: () => void;
};

export class AnonRpcWorker {
  ready: Promise<void>;
  fetch: typeof fetch;

  #init: WorkerInit;
  #rpc?: PortRpc;
  #iframe?: HTMLIFrameElement;
  #disposeKps?: () => void;
  #onWindowMessage?: (ev: MessageEvent) => void;

  // Calls awaiting acceptCall (§8: ordered, no drop, backpressured).
  #queue = new CallQueue<CallRecord>();
  #calls = new Map<number, CallRecord>();
  #nextCallId = 1;
  #readyResolve!: () => void;
  #readyReject!: (e: unknown) => void;
  // Set on fatal failure (boot failure, worker crash, close): everything
  // pending is rejected with it and future fetches fail fast.
  #failure?: unknown;
  // §11 storage backend (IndexedDB; memory fallback), opened on first use.
  #storage?: Promise<StorageBackend>;

  constructor(init: WorkerInit) {
    this.#init = init;
    this.ready = new Promise<void>((res, rej) => {
      this.#readyResolve = res;
      this.#readyReject = rej;
    });
    // A caller need not await `ready` (e.g. close() before boot finishes);
    // this branch absorbs the rejection so it is never "unhandled", while
    // awaiting callers still observe it.
    this.ready.catch(() => {});
    // §5: `fetch` MUST be this-bound so it works as a free function.
    this.fetch = this.#fetch.bind(this);
    this.#boot().catch((e) => this.#fail(e));
  }

  // A dead worker fails everything, not just `ready`: in-flight and queued
  // fetches would otherwise hang with no error surfaced.
  #fail(err: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = err;
    this.#readyReject(err);
    for (const rec of this.#calls.values()) {
      rec.cleanup?.();
      rec.reject(err);
    }
    this.#calls.clear();
    this.#queue.rejectAll(err);
  }

  async #boot(): Promise<void> {
    const provider = this.#init.preExisting?.rpcProvider;
    if (!provider) throw new Error("preExisting.rpcProvider is required to read the specifier");

    const spec = await readSpecifier(provider, this.#init.address);
    const bundleBytes = await fetchAndVerifyBundle(spec);

    const channel = new MessageChannel();
    const rpc = new PortRpc(channel.port1);
    this.#rpc = rpc;
    this.#registerHandlers(rpc);

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts"); // §6: null origin, scripts only
    iframe.style.display = "none";
    // §5/§6 `iframeUrl`: a host whose CSP forbids inline script supplies the
    // document, because a `srcdoc` frame inherits that CSP and the bootstrap
    // below would simply not execute. Either path ends at an opaque origin
    // running the same iframe-boot code — the sandbox attribute above is
    // applied regardless, as §6 requires.
    if (this.#init.iframeUrl) iframe.src = sameOriginIframeUrl(this.#init.iframeUrl);
    else iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script>${__IFRAME_BOOT_SRC__}</script>`;
    this.#iframe = iframe;

    const ready = new Promise<void>((resolve) => {
      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== iframe.contentWindow) return;
        if (ev.data?.kind === "iframe-ready") resolve();
        // An uncaught worker error is fatal harness policy: the worker is
        // untrusted code in an unknown state, so everything pending fails —
        // whether it happens during boot or after signalReady.
        if (ev.data?.kind === "worker-error") {
          this.#fail(new Error(`worker error: ${ev.data.message}`));
        }
      };
      this.#onWindowMessage = onMessage;
      window.addEventListener("message", onMessage);
    });
    document.body.appendChild(iframe);
    await ready;

    // §7.1: config rides the init message — postMessage structured-clones it,
    // which is exactly the delivery semantic the spec requires.
    iframe.contentWindow!.postMessage(
      { kind: "init", runtimeSource: __WORKER_RUNTIME_SRC__, bundleBytes, config: this.#init.config },
      "*",
      [channel.port2],
    );

    // `this.ready` resolves when the worker emits "ready" (signalReady, §7).
  }

  #registerHandlers(rpc: PortRpc): void {
    this.#disposeKps = registerKpsBridge(rpc);

    rpc.onEvent("ready", () => this.#readyResolve());

    // The worker runtime reports a bundle that failed to load (§4-valid bytes
    // can still throw at top level); without this, `ready` would hang.
    rpc.onEvent("boot-error", ({ message }: { message: string }) => {
      this.#fail(new Error(`worker bundle failed to load: ${message}`));
    });

    // §7 signalFailed: the worker deliberately reports an unrecoverable
    // failure. code crosses intact for the host to branch on (§12); #fail's
    // one-shot guard gives the MUST-ignore-later-signals semantics.
    rpc.onEvent("failed", ({ reason }: { reason?: { code?: string; message?: string } }) => {
      this.#fail(
        new RpcError({
          name: "WorkerFailedError",
          message: reason?.message ?? "worker signalled failure",
          code: reason?.code,
        }),
      );
    });

    // The worker aborted an acceptCall that lost the race with delivery: the
    // call comes back to the FRONT of the queue for the next acceptCall
    // (§8: an aborted acceptCall must not consume a call).
    rpc.onEvent("requeue-call", ({ callId }: { callId: number }) => {
      const rec = this.#calls.get(callId);
      if (rec) this.#queue.pushFront(rec);
    });

    rpc.onEvent("log", ({ level, args }: { level: string; args: unknown[] }) => {
      const fn = (console as any)[level] ?? console.log;
      fn.call(console, "[worker]", ...args.map(renderLogArg));
    });

    rpc.on("acceptCall", async (_args, { signal }) => {
      const rec = await this.#queue.take(signal);
      const value = {
        callId: rec.callId,
        url: rec.url,
        requestInit: rec.requestInit,
      };
      return { value, transfer: rec.bodyTransfer ?? [] };
    });

    rpc.on("respond", async (msg: {
      callId: number;
      ok: boolean;
      response?: AnonFetchResponse;
      error?: SerializedError;
    }) => {
      const rec = this.#calls.get(msg.callId);
      // Unknown callId is expected when the host aborted the call after the
      // worker had already accepted it — the late respond is dropped quietly.
      if (!rec) return { value: undefined };
      this.#calls.delete(msg.callId);
      rec.cleanup?.();
      if (msg.ok && msg.response) {
        // toResponse validates worker-supplied status/headers; a throw must
        // settle the fetch (the record is already removed) rather than escape.
        try {
          rec.resolve(toResponse(msg.response));
        } catch (e) {
          rec.reject(e);
        }
      } else {
        // §12: name/code cross the boundary intact; host logic may branch on
        // code, never on message text.
        rec.reject(new RpcError(msg.error ?? { name: "Error", message: "worker failed the call" }));
      }
      return { value: undefined };
    });

    // §11: scoped to the specifier address (normalized, so checksum-cased and
    // lowercased forms of one address share a namespace).
    const addr = this.#init.address.toLowerCase();
    const store = () => (this.#storage ??= openStorageBackend());
    rpc.on("storage.get", async ({ key }) => ({ value: await (await store()).get(addr, key) }));
    rpc.on("storage.set", async ({ key, value }) => {
      await (await store()).set(addr, key, value);
      return { value: undefined };
    });
    rpc.on("storage.delete", async ({ key }) => {
      await (await store()).delete(addr, key);
      return { value: undefined };
    });
    rpc.on("storage.has", async ({ key }) => ({ value: await (await store()).has(addr, key) }));
    rpc.on("storage.list", async ({ prefix }: { prefix?: string }) => ({
      value: await (await store()).listKeys(addr, prefix),
    }));
    rpc.on("storage.clear", async ({ prefix }: { prefix?: string }) => {
      await (await store()).clear(addr, prefix);
      return { value: undefined };
    });
  }

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.#failure !== undefined) throw this.#failure;
    const { url, requestInit, transfer, signal: hostSignal } = await normalizeRequest(input, init);
    const callId = this.#nextCallId++;

    return new Promise<Response>((resolve, reject) => {
      const rec: CallRecord = {
        callId,
        url,
        requestInit,
        bodyTransfer: transfer,
        resolve,
        reject,
      };
      this.#calls.set(callId, rec);

      if (hostSignal) {
        const onAbort = () => {
          // Not yet delivered: withdraw it from the queue so the worker never
          // sees a dead call. Already delivered: tell the worker to abort it.
          if (!this.#queue.remove(rec)) this.#rpc?.emit("call-abort", { callId });
          if (this.#calls.delete(callId)) {
            reject(hostSignal.reason ?? new DOMException("aborted", "AbortError"));
          }
        };
        if (hostSignal.aborted) {
          this.#calls.delete(callId);
          reject(hostSignal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        hostSignal.addEventListener("abort", onAbort, { once: true });
        rec.cleanup = () => hostSignal.removeEventListener("abort", onAbort);
      }
      this.#queue.push(rec);
    });
  }

  close(): void {
    this.#disposeKps?.();
    if (this.#onWindowMessage) window.removeEventListener("message", this.#onWindowMessage);
    this.#iframe?.remove();
    this.#fail(new Error("worker closed"));
  }
}

/**
 * §6: `iframeUrl` MUST be same-origin with the host document.
 *
 * A cross-origin bootstrap would put the isolation boundary in a third party's
 * hands — they would choose what runs in the frame that is supposed to contain
 * the worker, and receive the capability port. Resolved against the host's own
 * URL first, so a relative path is the normal way to write it.
 */
function sameOriginIframeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw, location.href);
  } catch {
    throw new Error(`iframeUrl is not a valid URL: ${raw}`);
  }
  if (url.origin !== location.origin) {
    throw new Error(
      `iframeUrl must be same-origin with the host (${location.origin}), got ${url.origin} — ` +
        "a cross-origin bootstrap would control the isolation boundary (§6)",
    );
  }
  return url.href;
}

function renderLogArg(a: unknown): unknown {
  if (a instanceof Uint8Array) return `<${a.byteLength} bytes>`;
  return a;
}

function toResponse(r: AnonFetchResponse): Response {
  const headers = new Headers();
  for (const [k, v] of r.headers) headers.append(k, v);
  const status = r.status;
  // 204/205/304 must have a null body.
  const body = status === 204 || status === 205 || status === 304 ? null : (r.body as BodyInit);
  const resp = new Response(body, { status, headers });
  // Response.url is read-only and unset by the constructor; surface the
  // worker-reported post-redirect URL (§9.2) by shadowing the getter.
  if (r.url) Object.defineProperty(resp, "url", { value: r.url });
  return resp;
}

export { RpcError };
