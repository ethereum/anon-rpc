// Making sure an offscreen document exists.
//
// An extension may have exactly ONE offscreen document at a time, which makes
// this shared state rather than something each worker can own. Two consequences
// shape the API:
//
//   * Creation races. Two `AnonRpcWorker`s constructed in the same tick would
//     both see "no document" and both call createDocument; the second throws.
//     A single in-flight promise is shared instead.
//   * An extension that already uses its offscreen document for something else
//     must NOT have it replaced. That case is served by `offscreenUrl: false`
//     — the extension creates its own document, calls `mountOffscreenHost()`
//     in it, and this file stays out of the way.

import { chromeApi, type OffscreenApi } from "../chrome-types.js";

/**
 * Why the document is needed, in the API's own vocabulary.
 *
 * All four are load-bearing and none is padding: the sandboxed iframe is
 * IFRAME_SCRIPTING, the Web Worker inside it is WORKERS, the blob URLs both are
 * spawned from are BLOBS, and §10's KPS transport is WEB_RTC. Chrome shows the
 * justification to users and reviewers, so it says what actually happens.
 */
const REASONS = ["IFRAME_SCRIPTING", "WORKERS", "BLOBS", "WEB_RTC"];
const JUSTIFICATION =
  "Runs a hash-pinned anon-rpc worker inside a null-origin sandboxed iframe, " +
  "so RPC requests are anonymized without the extension's origin or credentials.";

let pending: Promise<void> | undefined;

/** Create the offscreen document if it is not already there. Idempotent. */
export async function ensureOffscreenDocument(url: string): Promise<void> {
  const chrome = chromeApi();
  if (!chrome.offscreen) {
    throw new Error(
      "chrome.offscreen is unavailable — add \"offscreen\" to the manifest's permissions " +
        "(Chrome 109+), or create the document yourself and pass offscreenUrl: false",
    );
  }
  // Shared, so concurrent constructions await one creation rather than racing.
  pending ??= create(chrome.offscreen, url).finally(() => {
    pending = undefined;
  });
  return pending;
}

async function create(offscreen: OffscreenApi, url: string): Promise<void> {
  if (await offscreen.hasDocument?.()) return;
  try {
    await offscreen.createDocument({ url, reasons: REASONS, justification: JUSTIFICATION });
  } catch (e) {
    // Another context won the race between hasDocument and createDocument, or
    // the extension already had a document open for its own purposes. The
    // first is fine; the second is a real conflict the caller must resolve, so
    // the message names the way out rather than only the symptom.
    if (/single offscreen|already.*exist/i.test((e as Error)?.message ?? "")) {
      if (await offscreen.hasDocument?.()) return;
    }
    throw new Error(
      `could not create the offscreen document (${(e as Error)?.message ?? String(e)}). ` +
        "An extension may only have one; if yours already uses it, call mountOffscreenHost() " +
        "from that document and construct AnonRpcWorker with offscreenUrl: false.",
    );
  }
}

/**
 * Close the extension's offscreen document.
 *
 * Not called by `close()`: the document is extension-wide, and tearing it down
 * because one worker finished would break any other worker — or any other
 * feature — still using it.
 */
export async function closeOffscreenDocument(): Promise<void> {
  await chromeApi().offscreen?.closeDocument?.();
}
