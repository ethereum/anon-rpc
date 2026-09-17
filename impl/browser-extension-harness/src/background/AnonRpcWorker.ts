// §5 — the host-side harness API, for an MV3 service worker.
//
// Same shape as the browser harness's `AnonRpcWorker`, and it is not a
// reimplementation: the real one runs in the offscreen document and this
// remotes to it. What lives here is the part that has to be in the service
// worker — the §5 surface the extension's own code calls, and the pre-existing
// RPC provider §4 reads the specifier through.
//
// The reason for the split is that MV3 replaced the background PAGE with a
// service worker, which has no DOM. §6 isolation is a null-origin iframe, and
// there is nowhere to put one. The offscreen document is the DOM the extension
// is allowed to have.
//
// The service worker's own lifecycle is the other half of it. Chrome kills an
// idle service worker after ~30s, so an `AnonRpcWorker` held in a module-level
// variable simply stops existing, and the next event constructs a new one. That
// is why boot is cheap here: the offscreen document keeps the booted worker and
// hands the same one back, so a reconnect costs a message rather than a
// specifier read, a bundle fetch and a keccak verification.

import type { RpcProvider, WorkerInit } from "@anon-rpc/browser-harness";
import { ensureOffscreenDocument } from "./offscreen.js";
import { chromeApi, type RuntimePort } from "../chrome-types.js";
import {
  PORT_NAME,
  fromB64,
  toB64,
  toWireError,
  type FromOffscreen,
  type ToOffscreen,
  type WireRequest,
} from "../wire.js";
import { ASSET_PATH, assertAssetPresent } from "./assets.js";

/**
 * Default packaged paths — inside the version-stamped directory the install
 * step copies into the extension, e.g. `anon-rpc/0.3.1-1a2b3c4d/`.
 *
 * The stamp is not decoration. These two files are copies, and the code that
 * speaks to them is rebuilt from node_modules on every install, so an upgrade
 * can pair mismatched halves. Resolving the path from the build makes a stale
 * copy a missing file instead of a subtly wrong one — see assets.ts.
 *
 * Override both if you put the assets somewhere else.
 */
export const DEFAULT_OFFSCREEN_URL = `${ASSET_PATH}/offscreen.html`;
export const DEFAULT_IFRAME_URL = `${ASSET_PATH}/sandbox.html`;

export type ExtensionWorkerInit = WorkerInit & {
  /**
   * The packaged offscreen document to create, or `false` to create none.
   *
   * `false` is for an extension that already has an offscreen document of its
   * own — only one is allowed per extension — which must then call
   * `mountOffscreenHost()` itself.
   */
  offscreenUrl?: string | false;
  /**
   * The packaged page that hosts the worker — §5's `iframeUrl`, as an
   * extension-relative path.
   *
   * It MUST be listed in the manifest's `sandbox.pages`. That is what gives it
   * its own Content Security Policy, which is the only relaxable one an
   * extension has and the only way the worker's `blob:` chain can run at all.
   * The harness also applies the iframe's `sandbox` attribute regardless (§6),
   * so a missing manifest entry degrades to "opaque origin but no eval" rather
   * than to "worker code with your permissions" — but do not rely on that.
   */
  iframeUrl?: string;
  /**
   * Reuse a worker the offscreen document already booted for this
   * address+config. On by default, and the main reason this survives MV3's
   * service-worker lifecycle gracefully. Set false to force a fresh boot —
   * a re-verification of the bundle, which is what you want after an update.
   */
  reuse?: boolean;
};

type Pending = {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  cleanup?: () => void;
};

export class AnonRpcWorker {
  readonly ready: Promise<void>;
  fetch: typeof fetch;

  #port?: RuntimePort;
  #provider?: RpcProvider;
  #calls = new Map<number, Pending>();
  #nextCallId = 1;
  #readyResolve!: () => void;
  #readyReject!: (e: unknown) => void;
  #failure?: unknown;
  /** Buffered until the port exists, so a fetch before boot is not dropped (§8). */
  #outbox: ToOffscreen[] = [];

  constructor(init: ExtensionWorkerInit) {
    this.ready = new Promise<void>((res, rej) => {
      this.#readyResolve = res;
      this.#readyReject = rej;
    });
    // A caller need not await `ready`; this keeps the rejection from being
    // "unhandled" while awaiting callers still observe it.
    this.ready.catch(() => {});
    // §5: `fetch` MUST be this-bound so it works as a free function.
    this.fetch = this.#fetch.bind(this);
    this.#boot(init).catch((e) => this.#fail(e));
  }

  async #boot(init: ExtensionWorkerInit): Promise<void> {
    const provider = init.preExisting?.rpcProvider;
    if (!provider) throw new Error("preExisting.rpcProvider is required to read the specifier (§4)");
    this.#provider = provider;

    const chrome = chromeApi();
    const offscreenUrl = init.offscreenUrl ?? DEFAULT_OFFSCREEN_URL;
    const iframeUrl = resolveIframeUrl(init.iframeUrl ?? DEFAULT_IFRAME_URL);

    // Before anything is created: a missing asset is the one failure on this
    // path that would otherwise be a hang rather than an error (assets.ts).
    // Only OUR origin is checked — a cross-origin iframeUrl is §6's to reject,
    // with §6's message, and fetching it here would answer a different
    // question badly.
    const ownOrigin = chrome.runtime.getURL("");
    await Promise.all([
      offscreenUrl === false
        ? undefined
        : assertAssetPresent(chrome.runtime.getURL(offscreenUrl), "offscreen document"),
      iframeUrl.startsWith(ownOrigin) ? assertAssetPresent(iframeUrl, "sandboxed page") : undefined,
    ]);

    if (offscreenUrl !== false) {
      await ensureOffscreenDocument(chrome.runtime.getURL(offscreenUrl));
    }

    const port = chrome.runtime.connect({ name: PORT_NAME });
    this.#port = port;
    port.onMessage.addListener((m) => this.#onMessage(m as FromOffscreen));
    port.onDisconnect.addListener(() => {
      // Either the offscreen document went away or this service worker is
      // being torn down. Both are fatal to THIS instance; a new one reconnects
      // and, thanks to reuse, usually finds the same worker still booted.
      this.#fail(new Error("offscreen document disconnected"));
    });

    this.#send({
      t: "boot",
      address: init.address,
      config: init.config,
      iframeUrl,
      reuse: init.reuse ?? true,
    });
    for (const queued of this.#outbox.splice(0)) this.#send(queued);
  }

  #send(msg: ToOffscreen): void {
    if (!this.#port) {
      this.#outbox.push(msg);
      return;
    }
    try {
      this.#port.postMessage(msg);
    } catch (e) {
      this.#fail(e);
    }
  }

  #onMessage(msg: FromOffscreen): void {
    switch (msg?.t) {
      case "ready":
        this.#readyResolve();
        return;

      case "failed":
        this.#fail(rehydrate(msg.error));
        return;

      case "response": {
        const call = this.#calls.get(msg.callId);
        if (!call) return; // aborted before the answer arrived
        this.#calls.delete(msg.callId);
        call.cleanup?.();
        if (msg.ok) {
          const bytes = fromB64(msg.body);
          const headers = new Headers();
          for (const [k, v] of msg.headers) headers.append(k, v);
          // 204/205/304 must have a null body.
          const nullBody = msg.status === 204 || msg.status === 205 || msg.status === 304;
          // The cast is the DOM lib's problem, not ours: a Uint8Array is a
          // perfectly good BodyInit at runtime, but `BodyInit` is typed as
          // BufferSource-minus-Uint8Array in this lib version.
          const body = nullBody ? null : ((bytes ?? new Uint8Array(0)) as unknown as BodyInit);
          const res = new Response(body, { status: msg.status, headers });
          // Response.url is read-only and unset by the constructor; surface the
          // worker-reported post-redirect URL (§9.2) by shadowing the getter.
          if (msg.url) Object.defineProperty(res, "url", { value: msg.url });
          call.resolve(res);
        } else {
          call.reject(rehydrate(msg.error));
        }
        return;
      }

      case "provider.request": {
        // §4: the offscreen document reads the specifier through the provider
        // the host already has, which is here.
        void Promise.resolve()
          .then(() => this.#provider!.request({ method: msg.method, params: msg.params }))
          .then(
            (value) => this.#send({ t: "provider.result", id: msg.id, ok: true, value }),
            (e) => this.#send({ t: "provider.result", id: msg.id, ok: false, error: toWireError(e) }),
          );
        return;
      }

      case "log": {
        // §13: worker logs are diagnostic and untrusted; prefixed, never parsed.
        const fn = (console as unknown as Record<string, typeof console.log>)[msg.level] ?? console.log;
        fn.call(console, "[anon-rpc worker]", ...msg.args);
        return;
      }
    }
  }

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.#failure !== undefined) throw this.#failure;

    const req = input instanceof Request && !init ? input : new Request(input as RequestInfo, init);
    const headers: [string, string][] = [];
    req.headers.forEach((v, k) => headers.push([k, v]));
    const request: WireRequest = { method: req.method };
    if (headers.length) request.headers = headers;
    if (init?.redirect) request.redirect = init.redirect;

    // Buffered to bytes: a streaming body cannot cross extension messaging, and
    // §9 permits a buffered one.
    let body: Uint8Array | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const buf = await req.arrayBuffer();
      if (buf.byteLength) body = new Uint8Array(buf);
    }

    const callId = this.#nextCallId++;
    const signal = init?.signal ?? undefined;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        return;
      }
      const pending: Pending = { resolve, reject };
      this.#calls.set(callId, pending);

      if (signal) {
        const onAbort = () => {
          // Tell the far side so it can abort the worker's call (§9), then
          // fail locally regardless — an unresponsive worker must not keep the
          // caller blocked.
          this.#send({ t: "abort", callId });
          if (this.#calls.delete(callId)) {
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.#send({ t: "fetch", callId, url: req.url, request, body: toB64(body) });
    });
  }

  /**
   * Release this instance's claim on the worker.
   *
   * The offscreen document is NOT closed: it is extension-wide, and may be
   * serving other workers or other features. The worker itself is closed once
   * nothing is using it.
   */
  close(): void {
    this.#send({ t: "close" });
    try {
      this.#port?.disconnect();
    } catch {
      /* already gone */
    }
    this.#fail(new Error("worker closed"));
  }

  #fail(err: unknown): void {
    if (this.#failure !== undefined) return; // failure is final (§7)
    this.#failure = err;
    this.#readyReject(err);
    for (const call of this.#calls.values()) {
      call.cleanup?.();
      call.reject(err);
    }
    this.#calls.clear();
  }
}

/**
 * An extension-relative path becomes an extension URL; an absolute URL is
 * passed through untouched.
 *
 * The pass-through matters. `chrome.runtime.getURL` does not reject an absolute
 * URL, it rewrites it into an extension one — so a caller who passed a
 * cross-origin page would have their mistake silently turned into a
 * same-origin-looking URL, and §6's same-origin check downstream would see
 * nothing wrong. Handing the original through keeps that one check meaningful.
 */
function resolveIframeUrl(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  return chromeApi().runtime.getURL(raw);
}

function rehydrate(e: { name: string; message: string; code?: string }): Error {
  const err = new Error(e.message);
  err.name = e.name;
  if (e.code) (err as Error & { code: string }).code = e.code;
  return err;
}
