// §5 — the in-page mode of `AnonRpcWorker`, for an extension page that has a DOM.
//
// Firefox has no offscreen documents, and has no need for them: its MV3
// background is an event *page*, with a document that can hold the §6 iframe
// directly. So here the browser harness runs in place — no offscreen document
// and no remoting — pointed at the same packaged sandbox page the offscreen
// path uses.
//
// On Firefox the isolation boundary is the iframe's `sandbox` attribute, which
// §6 requires and the browser harness always applies: it places the frame at
// an opaque origin with no extension APIs. Firefox (measured on 140 and 157)
// applies NO Content Security Policy inside an extension frame that carries the
// attribute — not the extension's, and not the manifest's `sandbox` policy even
// for a page listed in `sandbox.pages` (that policy only applies to the page
// loaded without the attribute, which §6 does not allow). So list the page
// anyway, so it is right if Firefox starts applying that policy, but do not
// read the policy as a constraint on the worker there today.

import { AnonRpcWorker as BrowserHarnessWorker } from "@anon-rpc/browser-harness";
import type { AnonFetch, LogEntry } from "@anon-rpc/browser-harness";
import { assertAssetPresent } from "../background/assets.js";
import { DEFAULT_IFRAME_URL, type ExtensionWorkerInit } from "../background/OffscreenWorker.js";
import { chromeApi } from "../chrome-types.js";
import { resolveIframeUrl } from "../iframe-url.js";
import { copyForwardedEntries, copyPlainValue } from "@anon-rpc/harness-core";

export class PageWorker {
  readonly ready: Promise<void>;
  fetch: AnonFetch;

  #inner: Promise<BrowserHarnessWorker>;

  /**
   * Takes the same init as the offscreen mode; `offscreenUrl` and `reuse` have
   * no meaning here (there is no offscreen document to create or to reuse a
   * booted worker from), and `iframeUrl` should be listed in `sandbox.pages`.
   */
  constructor(init: ExtensionWorkerInit) {
    // §7.1: checked here, synchronously — the browser harness would check it
    // too, but only once the asset check below lets it be constructed, which
    // would turn the constructor's TypeError into a rejected `ready`.
    const config = copyPlainValue(init.config, "config");
    // An absolute URL passes through untouched, so a cross-origin one reaches
    // the browser harness's §6 same-origin check instead of being rewritten
    // into a same-origin-looking extension URL (see resolveIframeUrl).
    const iframeUrl = resolveIframeUrl(init.iframeUrl ?? DEFAULT_IFRAME_URL);
    const isOwnPage = iframeUrl.startsWith(chromeApi().runtime.getURL(""));

    this.#inner = (async () => {
      // Before the iframe exists: a missing page would otherwise surface as a
      // `ready` that never settles (assets.ts). Only our own pages are checked;
      // anything else is §6's to reject, with §6's message.
      if (isOwnPage) await assertAssetPresent(iframeUrl, "sandboxed page");
      const { address, preExisting } = init;
      return new BrowserHarnessWorker({ address, config, preExisting, iframeUrl });
    })();

    this.ready = this.#inner.then((worker) => worker.ready);
    // A caller need not await `ready`; this keeps the rejection from being
    // "unhandled" while awaiting callers still observe it.
    this.ready.catch(() => {});
    // §5: `fetch` MUST be this-bound so it works as a free function. Calls made
    // before the asset check finishes wait for it, as the browser harness
    // buffers calls made before its worker is ready (§8).
    //
    // §9.1 copies forwarded entries when fetch is called — but the browser
    // harness only sees the call after #inner settles, by which time the host
    // may have changed them (an options object reused across accounts would
    // send this call under the next account's isolationKey). So they are
    // copied here, synchronously, and the harness is handed the copies.
    this.fetch = (input, requestInit) => {
      let init = requestInit;
      try {
        const copied = copyForwardedEntries(requestInit);
        if (copied) init = { ...requestInit, ...copied };
      } catch (e) {
        return Promise.reject(e);
      }
      return this.#inner.then((worker) => worker.fetch(input, init));
    };
  }

  /** §5/§13.1: the next log entry from the worker. */
  async acceptLog(opts?: { signal?: AbortSignal }): Promise<LogEntry> {
    return (await this.#inner).acceptLog(opts);
  }

  /** Tears down the iframe and worker, once they exist. */
  close(): void {
    void this.#inner.then(
      (worker) => worker.close(),
      () => {},
    );
  }
}
