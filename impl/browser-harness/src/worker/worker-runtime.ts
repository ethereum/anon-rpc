// Trusted harness code that runs as the Web Worker's top-level script. It wires
// up `anonRpcWorker` from the capability port, exposes it as a global, then
// loads the hash-verified (untrusted) worker bundle, which uses that global as
// its entire platform. The worker bundle is the §4 conformance artifact; this
// runtime is part of the harness.
//
// Bundled to a classic-worker IIFE so `importScripts` is available.

import { PortRpc } from "../protocol.js";
import { makeWorkerApi } from "./anon-rpc-worker-api.js";
import type { PlainValue } from "../spec-types.js";

const importScripts = (url: string) =>
  // eslint-disable-next-line no-restricted-globals
  (self as unknown as { importScripts: (u: string) => void }).importScripts(url);

/**
 * The URL to `importScripts` the bundle from: a `blob:` URL where the browser
 * allows it, otherwise the same bytes as a `data:` URL.
 *
 * Firefox refuses `importScripts(blob:)` in a worker whose origin is opaque —
 * which §6 makes ours — even for a blob the worker created itself and even when
 * the CSP allows `blob:` (measured on Firefox 140 and 157; a worker at a normal
 * origin is unaffected). `data:` loads there, with the same classic-script
 * semantics, so the bundle cannot tell the difference.
 *
 * Capability is probed with an empty script rather than by retrying after a
 * failure: `importScripts` also throws when the bundle itself throws, and
 * retrying then would run the bundle's top level twice.
 */
function bundleScriptUrl(bundle: Blob): string {
  const probeUrl = URL.createObjectURL(new Blob([";"], { type: "text/javascript" }));
  try {
    importScripts(probeUrl);
    return URL.createObjectURL(bundle);
  } catch {
    return new FileReaderSync().readAsDataURL(bundle);
  } finally {
    URL.revokeObjectURL(probeUrl);
  }
}

addEventListener("message", function onInit(ev: MessageEvent) {
  if (ev.data?.kind !== "init") return;
  removeEventListener("message", onInit as EventListener);

  const port: MessagePort = ev.data.port;
  const bundleBytes: Uint8Array = ev.data.bundleBytes;
  // Already a §9.4 copy: the host copied it before posting (AnonRpcWorker).
  const config: PlainValue = ev.data.config;

  const rpc = new PortRpc(port);
  // config is set before the bundle executes: §7.1 requires it available from
  // the worker's first instruction.
  const api = makeWorkerApi(rpc, config);
  (globalThis as unknown as { anonRpcWorker: unknown }).anonRpcWorker = api;

  try {
    const blob = new Blob([bundleBytes as unknown as BlobPart], { type: "text/javascript" });
    importScripts(bundleScriptUrl(blob));
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    api.log.error("worker bundle failed to load:", message);
    // The host rejects `ready` on this; logging alone would leave it hanging.
    rpc.emit("boot-error", { message });
  }
});
