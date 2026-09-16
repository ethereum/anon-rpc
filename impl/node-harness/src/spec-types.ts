// Type surface from SPEC.md (§5, §7–§13). These are the conformance-relevant
// shapes shared by the host harness, the worker runtime, and worker code.
// Where the draft and SPEC.md disagree, SPEC.md is authoritative.

/* §5 — Host-side harness API */

export type RpcProvider = {
  // Minimal EIP-1193-ish provider: enough to read a specifier contract.
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

export type WorkerInit = {
  // The specifier contract address.
  address: string;
  // Delivered to the worker as `anonRpcWorker.config` (§7.1). Structured-
  // cloneable; opaque to the harness — its schema is defined by the worker.
  config?: unknown;
  // Where a browser harness loads its null-origin document from, for an
  // embedder whose CSP will not let the harness construct one inline (§6).
  // A harness that does not use an iframe MUST ignore it.
  iframeUrl?: string;
  preExisting?: {
    rpcProvider?: RpcProvider;
  };
};

/* §7 — Capability API exposed to worker code as `anonRpcWorker` */

export type AnonRpcWorkerApi = {
  // PROPOSED, not in SPEC.md: a bridged TCP capability, present only on
  // harnesses that can offer one. A browser never can — which is exactly why
  // it is optional and why its ABSENCE must be detectable: a worker feature-
  // tests `if (anonRpcWorker.socket)` and falls back (tor-js: to KPS
  // gateways). Contrast `kps`/`storage`, which every harness must provide and
  // which therefore throw `unsupported` when unimplemented rather than being
  // absent. §3.2's warning applies in full: a worker that requires this one
  // will not run in a browser.
  socket?: SocketApi;
  signalReady(): void;
  // Report an unrecoverable failure (§7): before signalReady(), "cannot
  // become ready"; after it, "cannot continue". The host's `ready` rejects
  // (if pending) and all pending/future calls fail, with reason's
  // code/message on the error. Failure is final.
  signalFailed(reason?: { code?: string; message?: string }): void;
  acceptCall(opts?: { signal?: AbortSignal }): Promise<IncomingCall>;
  // The host's WorkerInit.config (§7.1): a structured clone, fixed for the
  // worker's lifetime; undefined when the host supplied none.
  config: unknown;
  kps: KpsApi;
  storage: StorageApi;
  log: LogApi;
};

/* §8 — Inbound calls */

export type IncomingCall = FetchCall; // discriminated by `kind`; more kinds later

export type FetchCall = {
  kind: "fetch";
  url: string;
  requestInit?: AnonRequestInit;
  respond(response: AnonFetchResponse | Promise<AnonFetchResponse>): void;
};

/* §9 — Fetch payloads */

export type HeaderList = [name: string, value: string][];

export type ByteBody = Uint8Array | ReadableStream<Uint8Array>;

export type AnonRequestInit = {
  method?: string;
  headers?: HeaderList;
  body?: ByteBody;
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal;
};

export type AnonFetchResponse = {
  status: number;
  headers: HeaderList;
  body: ByteBody;
  url?: string;
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

/* §10 — KPS transport */

export type KpsAddr = string; // "<ip>:<port>:<certhash>"

export type KpsDialOptions = { signal?: AbortSignal };
export type KpsOpenStreamOptions = { signal?: AbortSignal };

export type KpsApi = {
  dial(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsConn>;
  openStream(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsStream>;
};

export type KpsConn = {
  // The peer's UDP endpoint as observed at connection establishment (on the
  // dial side, the dialed endpoint); MAY change over the connection's life.
  // Informational only — trust derives solely from the pinned certhash.
  remoteAddress: { ip: string; port: number };
  openStream(opts?: KpsOpenStreamOptions): Promise<KpsStream>;
  acceptStream(opts?: { signal?: AbortSignal }): Promise<KpsStream>;
  sendDatagram(data: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  receiveDatagram(opts?: { signal?: AbortSignal }): Promise<Uint8Array>;
  close(reason?: KpsReason): Promise<void>;
  closed: Promise<KpsConnCloseInfo>;
};

export type KpsStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closeWrite(): Promise<void>;
  cancelRead(reason?: KpsReason): Promise<void>;
  resetWrite(reason?: KpsReason): Promise<void>;
  close(reason?: KpsReason): Promise<void>;
  closed: Promise<KpsStreamCloseInfo>;
};

export type KpsErrorCode =
  | "cancelled"
  | "closed"
  | "reset"
  | "timeout"
  | "network-error"
  | "protocol-error"
  | "unsupported"
  | "too-large"
  | "queue-full"
  | "permission-denied"
  | "internal-error";

export type KpsReason = { code?: KpsErrorCode; message?: string };
export type KpsConnCloseInfo = { ok: boolean; reason?: KpsReason };
export type KpsStreamCloseInfo = { ok: boolean; reason?: KpsReason };

/* §11 — Storage */

export type StorageKey = string;

export type StorageApi = {
  get(key: StorageKey, opts?: { signal?: AbortSignal }): Promise<Uint8Array | undefined>;
  set(key: StorageKey, value: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  delete(key: StorageKey, opts?: { signal?: AbortSignal }): Promise<void>;
  has(key: StorageKey, opts?: { signal?: AbortSignal }): Promise<boolean>;
  list(opts?: { prefix?: string; signal?: AbortSignal }): AsyncIterable<StorageKey>;
  clear(opts?: { prefix?: string; signal?: AbortSignal }): Promise<void>;
};

/* §13 — Logging */

export type LogArg =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | LogArg[]
  | { [key: string]: LogArg };

export type LogApi = {
  debug(...args: LogArg[]): void;
  info(...args: LogArg[]): void;
  warn(...args: LogArg[]): void;
  error(...args: LogArg[]): void;
};
