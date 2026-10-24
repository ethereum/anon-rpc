// §5 — the host-side harness API an extension calls.
//
// One class for every browser the harness supports, because the §5 surface is
// the same everywhere and only where the browser harness can run differs:
//
// - Chromium: MV3's background is a service worker, which has no DOM for the
//   §6 iframe, so the harness runs in an offscreen document and this remotes to
//   it (OffscreenWorker).
// - Firefox: there are no offscreen documents, and no need for them — the MV3
//   background is an event page with a DOM, so the harness runs right here
//   (PageWorker).
//
// The choice is made once, at construction, from what the browser provides.
// Both modes are bundled: a service worker cannot load code on demand (`import()`
// is disallowed there by the HTML spec), so picking one at runtime means
// shipping both. The in-page mode is the browser harness itself, which the
// offscreen document's own prebuilt script also contains — so a Chromium build
// carries it twice, roughly 18 KB gzipped, in exchange for one API.

import type { AnonFetch, LogEntry } from "@anon-rpc/browser-harness";
import { chromeApi } from "../chrome-types.js";
import { PageWorker } from "../page/PageWorker.js";
import { OffscreenWorker, type ExtensionWorkerInit } from "./OffscreenWorker.js";

export class AnonRpcWorker {
  readonly ready: Promise<void>;
  fetch: AnonFetch;

  #impl: OffscreenWorker | PageWorker;

  constructor(init: ExtensionWorkerInit) {
    this.#impl = createImpl(init);
    this.ready = this.#impl.ready;
    // §5: this-bound already, in both modes.
    this.fetch = this.#impl.fetch;
  }

  /** §5/§13.1: the next log entry from the worker. */
  acceptLog(opts?: { signal?: AbortSignal }): Promise<LogEntry> {
    return this.#impl.acceptLog(opts);
  }

  /** Release this instance's worker (see each mode for what that tears down). */
  close(): void {
    this.#impl.close();
  }
}

function createImpl(init: ExtensionWorkerInit): OffscreenWorker | PageWorker {
  if (chromeApi().offscreen) return new OffscreenWorker(init);
  if (typeof document !== "undefined") return new PageWorker(init);
  throw new Error(
    "@anon-rpc/browser-extension-harness needs offscreen documents (Chromium) or an extension page with a DOM (Firefox's background page)",
  );
}
