// Type surface from SPEC.md, shared by every harness (@anon-rpc/harness-core),
// plus what only this harness offers: the PROPOSED bridged TCP capability.
// Everything not redeclared here is re-exported unchanged; the local
// AnonRpcWorkerApi shadows the core one.

import type {
  AnonRpcWorkerApi as CoreAnonRpcWorkerApi,
  KpsReason,
  KpsStreamCloseInfo,
} from "@anon-rpc/harness-core/spec-types";

export type * from "@anon-rpc/harness-core/spec-types";

export type AnonRpcWorkerApi = CoreAnonRpcWorkerApi & {
  // PROPOSED, not in SPEC.md: a bridged TCP capability, present only on
  // harnesses that can offer one. A browser never can — which is exactly why
  // it is optional and why its ABSENCE must be detectable: a worker feature-
  // tests `if (anonRpcWorker.socket)` and falls back (tor-js: to KPS
  // gateways). Contrast `kps`/`storage`, which every harness must provide and
  // which therefore throw `unsupported` when unimplemented rather than being
  // absent. §3.2's warning applies in full: a worker that requires this one
  // will not run in a browser.
  socket?: SocketApi;
};

/* PROPOSED — bridged TCP (not in SPEC.md; see node-harness/README.md) */

export type SocketConnectOptions = { signal?: AbortSignal };

export type SocketApi = {
  /**
   * Open a TCP connection. The harness resolves the host and decides whether
   * the address may be dialled; a refusal arrives as a §12 error with code
   * `permission-denied`.
   */
  connect(host: string, port: number, opts?: SocketConnectOptions): Promise<SocketStream>;
};

/**
 * Deliberately the same shape as KpsStream (§10.2), so worker code that speaks
 * "byte stream to a peer" does not care which capability produced it.
 */
export type SocketStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  remoteAddress: { address: string; port: number };
  closeWrite(): Promise<void>;
  close(reason?: KpsReason): Promise<void>;
  closed: Promise<KpsStreamCloseInfo>;
};
