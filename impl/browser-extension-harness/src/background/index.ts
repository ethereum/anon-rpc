// The service-worker (background) entry: the §5 API the extension calls.
export { AnonRpcWorker, DEFAULT_OFFSCREEN_URL, DEFAULT_IFRAME_URL } from "./AnonRpcWorker.js";
export type { ExtensionWorkerInit } from "./AnonRpcWorker.js";
export { ensureOffscreenDocument, closeOffscreenDocument } from "./offscreen.js";
export type * from "@anon-rpc/browser-harness";
