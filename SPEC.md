# anon-rpc Specification

- **Status:** Draft
- **Version:** 0.3.2
- **Date:** 2026-09-25

This document is the normative specification for **anon-rpc**, a standard that lets a wallet or application make anonymized RPC requests by running hash-pinned client code inside a sandboxed worker, and granting that code a small, explicit, transport-neutral capability API.

Appendix A gives non-normative design rationale.

## 1. Introduction and scope

A wallet that wants to read from or write to a chain must reach an RPC endpoint. Doing so through a fixed gateway concentrates observation: the gateway learns who asks for what. anon-rpc lets the wallet instead run a pluggable **anon-client** that routes requests through an anonymity network, while keeping that client code from touching wallet secrets, cookies, or the DOM.

This specification covers the full system:

- how anon-client worker code is identified, located, and integrity-checked (§4);
- how a host bootstraps and integrates an anon-client (§5);
- the isolation properties a worker runs under (§6);
- the **worker capability API** the worker is granted: inbound calls, KPS transport, storage, and logging (§7–§13);
- the error model (§12) and security considerations (§14).

The KPS wire protocol itself is **out of scope** and is defined by the KPS project (see §15). This document specifies only the worker-facing KPS API and the harness obligations behind it.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

- **Worker** — the anon-client program, distributed as a bundle of bytes, that performs anonymized requests. It is the conformance target of §3.2.
- **Harness** — the runtime that loads a worker, enforces its isolation, and implements the capability API the worker is granted. It is the conformance target of §3.1. A *browser harness* runs the worker in a Web Worker inside a null-origin iframe.
- **Host** — the wallet or application that integrates a harness and consumes the anonymized `fetch` it produces.
- **Specifier Contract** — an on-chain definition (an `IWorkerSpecifier`, §4) that specifies a worker bundle by hash and where to obtain it.
- **Capability API** — the object exposed to worker code as its entire platform interface (`AnonRpcWorkerApi`, §7).
- **KPS** — Key Pinned Streams: secure multiplexed byte streams to a peer identified by a certificate hash rather than a CA-signed domain (§10).
- **Call** — a request made by the host *into* the worker (e.g. a `fetch` call), as opposed to a capability the worker invokes.

## 3. Conformance classes

### 3.1 Conforming harness

A conforming harness MUST:

- verify worker-bundle integrity before execution as specified in §4;
- implement `AnonRpcWorker` for the host (using the same name) (§5);
- enforce the worker isolation properties of §6;
- implement `AnonRpcWorkerApi` for the worker under the name `anonRpcWorker` (§7);
- implement the semantics of every capability it exposes as specified in §7–§11.

### 3.2 Conforming worker

A conforming worker MUST:

- use `anonRpcWorker.acceptCall` to respond to calls of type `fetch`;
- enable ethereum RPC in at least one of the following ways:
  - providing general web request access OR
  - serve ethereum RPC at a nominated special url such as `/ethereum-rpc`.

The worker SHOULD minimize its usage of ambient APIs other than the capability API (§7). Usage of other APIs will prevent the worker from functioning on platforms which do not provide them.

A conforming worker MUST NOT depend on the messaging protocol used to implement the capability API.

### 3.3 Secondary roles

A **Specifier Contract** MUST conform to §4.

## 4. Worker identity and integrity

> The contents of §4–§5 are derived from the anon-rpc proposal article (§15).

A worker bundle MUST be identified by content hash, not by location. A specifier contract is an on-chain object exposing at least:

```solidity
interface IWorkerSpecifier {
  // keccak256 hash of the canonical worker bundle bytes.
  function workerHash() external view returns (bytes32);
  // Suggested locations from which the bundle MAY be retrieved.
  function workerResolvers() external view returns (string[] memory);
}
```

A harness MAY obtain the bundle bytes by any means. Any bytes matching the hash are equally acceptable regardless of source; `workerResolvers()` is advisory only.

If the bundle hash does not equal `workerHash()`, the harness MUST reject it.

### 4.1 Resolver entries

Each `workerResolvers()` entry is one of:

- an `https:` URL, fetched with a plain HTTP GET;
- a **kps resolver string**, fetched over KPS (§4.2).

A harness MUST ignore entries it does not recognize.

The kps resolver grammar:

```
kps-resolver = "kps:" kps-addr path
kps-addr     = <a KPS Address, verbatim (§10)>
path         = "/" path-absolute        ; per RFC 3986
```

Example:

```
kps:198.51.100.7:12298:uEiAxk...9Qw/keccak/19/4f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d
```

- A kps resolver is deliberately **not a URL** and MUST NOT be fed to generic URL parsers (the address form is not a valid URL authority). The absence of `//` after the scheme is intentional signalling.
- Parse by removing the `kps:` prefix and splitting at the **first `/`**: the left part is passed verbatim to the KPS dial operation; the right part (including the leading `/`) is the request target. This is unambiguous because a certhash is multibase-`u` base64url (alphabet `A–Z a–z 0–9 - _`) and never contains `/`, and bracketed IPv6 hosts never contain `/`.

### 4.2 Fetching a bundle over KPS

To fetch from a kps resolver, a harness dials the address (browser harnesses over WebRTC, native over QUIC, per §10) and performs **one request/response exchange on one KPS stream**, in HTTP/1.1 syntax. The syntax is deliberately plain HTTP so that ordinary HTTP software behind a byte-stream bridge can serve bundles; the profile below is strict, and a recipient observing a violation MUST abandon the exchange rather than recover leniently.

Request — the harness writes, then calls `closeWrite()`:

```
GET <path> HTTP/1.1
Host: <certhash of the dialed address>

```

- Header fields are one per line, CRLF-terminated, followed by an empty line; a `GET` request has no body.
- `Host` is REQUIRED (HTTP/1.1 requires it and strict stacks reject its absence); its value SHOULD be the certhash of the dialed address, verbatim. Servers MUST NOT treat `Host` as a trust input — trust comes from the KPS handshake.
- The request SHOULD include `Accept-Encoding` listing the content codings the harness can decode with facilities ambient in its environment (e.g. `gzip, deflate` where a decompression stream is available); the header is omitted when there are none. A harness MUST NOT advertise a coding it cannot decode.

Response — the harness reads a status line, header fields, an empty line, then body bytes **until EOF**:

- The body is delimited by EOF (the server's `closeWrite()`), not by framing. `Content-Length`, when present, is advisory (e.g. progress reporting).
- Any status other than `200` fails that resolver. Redirects (3xx) MUST NOT be followed — alternative locations are expressed as additional resolver entries.
- `Transfer-Encoding` in either direction is forbidden; a message carrying it MUST abandon the exchange. (With EOF-delimited bodies, no chunked encoding, and one exchange per stream, the HTTP/1.1 request-smuggling/desync bug class structurally cannot occur.)
- The response MAY carry `Content-Encoding` naming exactly one coding the request advertised; the harness MUST then decode the body before the hash check. `identity`, or no `Content-Encoding`, means the body is the bundle bytes as-is. Anything else — a coding the request did not advertise, or a list of codings — fails that resolver.
- A harness SHOULD cap the accepted body size. With a content coding the cap MUST be enforced on the **decoded** bytes (a small compressed body must not expand past the cap), and SHOULD also be enforced on the wire bytes.

The stream carries exactly one exchange: after the response body, both sides close. Connection reuse happens at the KPS layer — one connection, many streams.

Integrity never depends on the transport: whether bytes came from `https:` or `kps:`, and whatever content coding carried them, only `keccak256(bytes) == workerHash()` over the decoded bytes admits them (§4).

## 5. Host-side harness API

The harness code MUST implement `AnonRpcWorker` for the host:

```ts
export class AnonRpcWorker {
  constructor(init: WorkerInit);

  // Resolves when the worker is loaded and has called its signalReady() method.
  // Rejects when the worker cannot be started or has failed (see below).
  ready: Promise<void>;

  // Implements the web's fetch API. This field MUST be this-bound; it MUST work
  // normally when used as a free function. This means a function accepting
  // fetch as a parameter can accept it as `useFetch(worker.fetch)` and not
  // require `useFetch(worker.fetch.bind(worker))`.
  fetch: typeof fetch;

  // Resolves with the next log entry the worker has produced (§13), waiting
  // for one if none is retained. The host pulls; the harness never pushes.
  // An abort withdraws the caller without consuming an entry.
  acceptLog(opts?: { signal?: AbortSignal }): Promise<LogEntry>;

  // Clean up resources. For a web harness this means the iframe and its web worker
  // are removed.
  close(): void;
}

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  args: LogArg[];
};

export type WorkerInit = {
  // The contract specifier address
  address: string;

  // Delivered to the worker as `anonRpcWorker.config` (§7). Opaque to the
  // harness; its meaning is defined by the worker.
  config?: unknown;

  // Where a browser harness loads its null-origin document from, for an
  // embedder whose Content Security Policy will not let the harness construct
  // one inline (§6). A harness that does not use an iframe MUST ignore it.
  iframeUrl?: string;

  preExisting?: {
    // An ethereum rpc provider used to break the circular dependency: we need
    // to read the chain in order to instantiate our anonymous system for reading
    // the chain.
    rpcProvider?: RpcProvider;
  };
};
```

`ready` MUST reject when the worker cannot be started or has failed:

- no bundle with the pinned hash could be obtained (§4–§4.2);
- the worker suffered an uncaught error — untrusted code in an unknown state MUST be treated as an unrecoverable failure;
- the worker reported failure via `signalFailed()` (§7).

After such a failure the harness MUST also fail all pending and future `fetch` calls; nothing may hang awaiting a worker that will never serve.

## 6. Worker isolation

A conforming harness MUST run the worker such that it has no ambient access to:

- the host's DOM, storage, or cookies;
- wallet private keys or signing capability;
- the origin or identity of the host beyond what the host passes in calls.

A browser harness MUST run the worker in a Web Worker whose owning context is a null-origin (sandboxed, `allow-scripts` only) iframe, and MUST mediate all capability traffic across the `postMessage` boundary.

How that iframe is constructed is the harness's choice. Building it inline — `srcdoc` carrying a bootstrap script — asks nothing of the host and is the usual way. It is not always available: a `srcdoc` document is loaded from a local scheme and therefore inherits the embedder's Content Security Policy, and a policy can only be tightened from within a document, never relaxed. An embedder whose policy omits `'unsafe-inline'` — an MV3 browser extension, or any site with a strict `script-src` — cannot run such a bootstrap at all.

`WorkerInit.iframeUrl` (§5) serves those embedders. When it is present, a browser harness MUST load the null-origin document from that URL instead of constructing one, and:

- it MUST still apply the `sandbox="allow-scripts"` attribute, so that a document not otherwise served at an opaque origin is placed at one regardless;
- it MUST reject a URL that is not same-origin with the host document. A cross-origin bootstrap would put the isolation boundary in a third party's hands;
- the document at that URL MUST run the bootstrap the harness expects. What that bootstrap is is harness-defined; a harness SHOULD publish it as a file the host can serve unmodified, so that the two cannot drift.

`iframeUrl` grants the worker nothing. It says where the empty room comes from, not what is in it. A harness MUST NOT treat a document loaded this way as more trusted than one it constructed, and MUST deliver the bundle, the config and the capability port identically in both cases.

## 7. The capability API

The harness MUST implement `AnonRpcWorkerApi` for the worker:

```ts
export type AnonRpcWorkerApi = {
  signalReady(): void;
  signalFailed(reason?: { code?: string; message?: string }): void;
  acceptCall(opts?: { signal?: AbortSignal }): Promise<IncomingCall>;
  config: unknown;
  kps: KpsApi;
  storage: StorageApi;
  log: LogApi;
};

export const anonRpcWorker: AnonRpcWorkerApi;
```

The worker MUST call `signalReady()` when it is ready to fulfil fetch calls.

The worker MAY accept calls to fetch before it calls `signalReady()`. The harness MUST buffer incoming calls so that this is not necessary.

The worker MAY call `signalFailed(reason?)` — before `signalReady()`, to report that it cannot become ready (bad config, unreachable network, unsupported platform, …); or after it, to report an unrecoverable failure. The harness MUST then fail the worker: `ready` (if pending) MUST reject, and pending and future calls MUST fail, with an error carrying `reason`'s `code` and `message` (§12 discipline: host logic may branch on `code`, never on `message`). Failure is final: `signalReady()` after `signalFailed()`, and repeated `signalFailed()` calls, MUST be ignored.

### 7.1 Config

`config` carries the host's `WorkerInit.config` (§5) to the worker:

- The value MUST be structured-cloneable; the harness MUST deliver an equivalent value (as by the structured clone algorithm) to the worker.
- The harness MUST treat config as opaque: it MUST NOT interpret it or alter its behaviour based on it. Its schema is defined by the worker.
- `config` MUST be available from the worker's first instruction (before `signalReady()`), and MUST NOT change for the lifetime of the worker. The worker receives a copy: mutating it MUST NOT affect the host's value.
- When the host supplies no config, `config` MUST be `undefined`.

## 8. Inbound calls

```ts
export type IncomingCall =
  | FetchCall;
// future call kinds are added here, discriminated by `kind`

export type FetchCall = {
  kind: "fetch";
  url: string;
  requestInit?: AnonRequestInit;
  respond(response: AnonFetchResponse | Promise<AnonFetchResponse>): void;
};
```

- `acceptCall()` MUST resolve with the next inbound call and MUST NOT deliver a subsequent call until it is invoked again. Backpressure is therefore implicit: the harness MUST NOT drop or reorder calls while the worker has not asked for the next one; it MUST queue them in arrival order. (This mirrors `KpsConn.acceptStream`, §10.)
- Calls MUST be delivered in the order the host issued them.
- If the `opts.signal` passed to `acceptCall()` aborts, the pending `acceptCall()` MUST reject with an abort error and MUST NOT consume a call.
- `respond()` MUST be called at most once per call. A second invocation MUST throw. Passing a rejected promise (or a promise that rejects) MUST fail the call and propagate failure to the host.
- New call kinds MUST be added as new members of the `IncomingCall` union with a distinct `kind`; a worker MUST ignore (and MUST NOT crash on) a `kind` it does not recognize, leaving such a call unanswered or explicitly failed.

## 9. Fetch call payloads

### 9.1 Requests

```ts
export type HeaderList = [name: string, value: string][];

export type ByteBody = Uint8Array | ReadableStream<Uint8Array>;

export type AnonRequestInit = {
  method?: string;                      // defaults to "GET"
  headers?: HeaderList;
  body?: ByteBody;
  redirect?: "follow" | "manual" | "error";  // defaults to "follow"
  signal?: AbortSignal;
};
```

- `HeaderList` preserves header order and duplicates.
- A `ByteBody` that is a `ReadableStream<Uint8Array>` is single-consumption, applies normal stream backpressure, and MUST error if the underlying transfer fails or `signal` aborts.
- `signal`, when supplied, aborts the in-flight call (as in `fetch(url, { signal })`).

### 9.2 Responses

```ts
export type AnonFetchResponse = {
  status: number;
  headers: HeaderList;
  body: ByteBody;
  url?: string;         // final URL after followed redirects
};
```

- When `body` is a streaming `ByteBody`, the call is **not complete** until the body stream closes or errors; `respond()` returning does not mark completion. A harness MUST keep the transfer alive until the body is fully drained or aborted.

## 10. KPS transport

KPS provides secure, multiplexed byte streams to a peer identified by a certificate hash. The worker-facing API is connection-first, and tracks the **KPS specification, version `^0.2.1`** (§15); a harness MUST implement KPS behaviour compatible with that version.

```ts
export type KpsAddr = string;  // "<ip>:<port>:<certhash>", e.g. "192.0.2.1:4242:uEi..."
                               // IPv6 hosts are bracketed: "[<ipv6>]:<port>:<certhash>"

export type KpsApi = {
  dial(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsConn>;
  openStream(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsStream>;
};

export type KpsDialOptions = { signal?: AbortSignal };
export type KpsOpenStreamOptions = { signal?: AbortSignal };
```

- A `KpsAddr` pins the peer's self-signed certificate by hash; no certificate authority or domain name is involved. A harness MUST authenticate the peer against the pinned hash and MUST fail the dial if it does not match.
- `dial()` MUST establish a secure multiplexed connection. `openStream(addr)` is convenience sugar similar to `dial(addr).then(c => c.openStream())`, but also closes the underlying connection when the stream is closed.
- A harness MAY implement KPS over WebRTC (browser) or QUIC (native). The worker SHOULD NOT be affected by the underlying transport.

### 10.1 Connections

```ts
export type KpsConn = {
  remoteAddress: { ip: string; port: number };
  openStream(opts?: KpsOpenStreamOptions): Promise<KpsStream>;
  acceptStream(opts?: { signal?: AbortSignal }): Promise<KpsStream>;
  sendDatagram(data: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  receiveDatagram(opts?: { signal?: AbortSignal }): Promise<Uint8Array>;
  close(reason?: KpsReason): Promise<void>;
  closed: Promise<KpsConnCloseInfo>;
};
```

- `remoteAddress` is the peer's UDP endpoint as observed at connection establishment (on the dial side, the dialed endpoint) and MAY change over the connection's life (path migration, ICE renomination). It is informational — for example, per-IP policy — and MUST NOT be treated as authentication: trust derives solely from the pinned certificate hash.
- `acceptStream()` accepts a stream opened by the peer, following the same one-at-a-time, ordered, no-drop discipline as `acceptCall` (§8).
- `sendDatagram()`/`receiveDatagram()` MUST always be present: every connection supports datagrams, so a worker need not feature-detect. Their semantics are given in §10.3.
- `close()` MUST invalidate all streams and datagram operations on the connection. `closed` MUST resolve (not reject) on orderly or failed shutdown, carrying `KpsConnCloseInfo`.

### 10.2 Streams

A KPS stream is an unnamed, reliable, ordered, bidirectional byte stream. Write boundaries are **not** preserved: if one side writes `hello` then `world`, the peer observes the bytes `helloworld` in arbitrary chunking. Application protocols, routing, framing, and request/response semantics are the worker's responsibility, layered on top of the stream bytes.

```ts
export type KpsStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closeWrite(): Promise<void>;
  cancelRead(reason?: KpsReason): Promise<void>;
  resetWrite(reason?: KpsReason): Promise<void>;
  close(reason?: KpsReason): Promise<void>;
  closed: Promise<KpsStreamCloseInfo>;
};
```

The lifecycle is QUIC-inspired but is not a QUIC API mapping:

- `closeWrite()` — gracefully finish the local write half; the peer MUST eventually observe EOF after all previously written bytes. It is equivalent to closing `writable`.
- `cancelRead(reason?)` — stop wanting inbound bytes; not graceful EOF. Where the transport supports it, the peer SHOULD be told to stop sending.
- `resetWrite(reason?)` — abort the local write half; the peer observes a stream error rather than EOF, and previously buffered bytes MAY be lost.
- `close(reason?)` — clean up both halves using the best available transport semantics.

A harness MUST NOT expose stream IDs, connection IDs, QUIC transport parameters, 0-RTT, connection migration, version negotiation, or detailed flow-control knobs.

### 10.3 Datagrams

Datagrams are connection-level, unreliable, unordered, message-oriented, and size-limited, and are kept entirely separate from streams. There is no notion of an "unreliable stream". They are sent and received directly on the connection (§10.1):

- `sendDatagram()` resolving means the harness accepted the datagram for best-effort sending, not that the peer received it.
- `receiveDatagram()` resolves with the next inbound datagram. While no receive is pending, a harness MUST buffer inbound datagrams in a bounded buffer with a defined overflow policy (for example, drop-oldest); because datagrams are unreliable, dropping on overflow is permitted.
- If the `opts.signal` passed to `receiveDatagram()` aborts, the pending receive MUST reject with an abort error and MUST NOT consume a datagram.

## 11. Storage

```ts
export type StorageKey = string;

export type StorageApi = {
  get(key: StorageKey, opts?: StorageReadOptions): Promise<Uint8Array | undefined>;
  set(key: StorageKey, value: Uint8Array, opts?: StorageWriteOptions): Promise<void>;
  delete(key: StorageKey, opts?: StorageWriteOptions): Promise<void>;
  has(key: StorageKey, opts?: StorageReadOptions): Promise<boolean>;
  list(opts?: StorageListOptions): AsyncIterable<StorageKey>;
  clear(opts?: StorageClearOptions): Promise<void>;
};
```

Storage is asynchronous and binary-first.

- A harness MUST scope storage to the address of the worker's specifier contract. A worker MUST NOT be able to read or write other storage.
- `get()` MUST resolve to `undefined` for an absent key.
- Keys are plain strings with no harness-imposed structure. A worker MAY adopt a delimiter convention (e.g. `"/"`) and use it with the `prefix` option of `list()` and `clear()`.
- `list()` is async-iterable so a harness MAY page internally. `clear({ prefix })` MUST remove only matching keys; `clear()` with no prefix MUST clear the worker's entire namespace and nothing outside it.

## 12. Error model

- Operation failures surface as rejected promises, and as errors on the relevant `readable`/`writable` streams.
- Where a structured reason is available it MUST carry a `KpsErrorCode` and MAY carry a human-readable `message`. `message` is diagnostic and MUST NOT be parsed for control flow.

```ts
export type KpsErrorCode =
  | "cancelled" | "closed" | "reset" | "timeout" | "network-error"
  | "protocol-error" | "unsupported" | "too-large" | "queue-full"
  | "permission-denied" | "internal-error";

export type KpsReason = { code?: KpsErrorCode; message?: string };
export type KpsConnCloseInfo = { ok: boolean; reason?: KpsReason };
export type KpsStreamCloseInfo = { ok: boolean; reason?: KpsReason };
```

- The `closed` promises on connections and streams MUST resolve (not reject) so that orderly shutdown is observable distinctly from operation failure; `ok` indicates whether shutdown was clean.

## 13. Logging

```ts
export type LogApi = {
  debug(...args: LogArg[]): void;
  info(...args: LogArg[]): void;
  warn(...args: LogArg[]): void;
  error(...args: LogArg[]): void;
};

export type LogArg =
  | string | number | boolean | null | undefined
  | Uint8Array
  | LogArg[]
  | { [key: string]: LogArg };
```

The log API is console-like but does not promise browser `console` semantics.

- Log calls are best-effort diagnostics. A worker's correctness MUST NOT depend on log delivery, ordering, formatting, or side effects.
- Arguments MUST be treated as serialized or snapshotted at call time. A worker MUST NOT assume object identity, prototypes, getters, stack capture, or live inspection.

### 13.1 Delivery to the host

A host reads log entries by calling `acceptLog()` (§5). The host pulls, one
entry per call; the harness MUST NOT require a host to read them at all.

- Each retained entry MUST be delivered to exactly one `acceptLog()` caller.
- Delivery SHOULD preserve the order in which the worker made the log calls.
- A harness SHOULD bound how many undelivered entries it retains. Entries MAY be dropped once that bound is reached — this is the one place where a harness is permitted to lose a log call it has already accepted from the worker.
- An aborted `acceptLog()` MUST NOT consume an entry.
- Entries retained when the worker fails or is closed MUST remain deliverable; `acceptLog()` rejects once they are drained. A worker's last words are usually why it failed.

Where a harness routes entries no host ever collects is not specified.

## 14. Security considerations

- The isolation in §6 is load-bearing: a compromised worker bundle must not be able to exfiltrate wallet secrets or browser state. Harness authors MUST treat worker code as untrusted.
- Hash pinning (§4) is the supply-chain control. A host that executes bytes without verifying `workerHash()` voids the security model.
- Because KPS pins peers by certificate hash (§10), trust derives from the pinned hash, not from CA/DNS; the source distributing an address is untrusted.
- Log arguments may carry sensitive bytes; §13 permits redaction precisely so harnesses can avoid leaking secrets into host logs.

## 15. References

- anon-rpc proposal article: https://privreads.ethereum.foundation/feed/anon-rpc/
- KPS (Key Pinned Streams): https://ethereum.github.io/kps/ — the wire protocol and behavioural contract are defined in the project's `SPEC.md` (https://github.com/ethereum/kps/blob/main/SPEC.md); §10 tracks KPS specification version `^0.2.1`.
- RFC 2119, RFC 8174 — requirement-level keywords.

## Appendix A: Design rationale (non-normative)

### An API, not a message protocol

The sandboxed worker communicates with the host via messaging, but this specification standardizes a wrapped **API** rather than the messages themselves. The API is easier to specify, easier to use, and leaves the wire encoding as an implementation detail of each harness:

```ts
// standardizing the messages would look like this…
addEventListener("message", async (ev) => {
  if (ev.data.type === "fetch") {
    const response = await anonymousFetch(ev.data.url, ev.data.requestInit);
    postMessage({ type: "fetch-result", response });
  }
});

// …instead, the worker writes this (§7–§8)
while (true) {
  const call = await anonRpcWorker.acceptCall();
  switch (call.kind) {
    case "fetch":
      call.respond(anonymousFetch(call.url, call.requestInit));
      break;
  }
}
```

`IncomingCall` is discriminated by `kind` so future call kinds can be added without growing the accept surface.

### Why KPS is a built-in capability

Granting the worker `kps` (§10) removes the temptation to give the worker code a full-page iframe so it can reach WebRTC directly — which would unnecessarily lock implementations to the web. KPS server listeners accept both WebRTC and QUIC clients, so a non-web harness simply uses QUIC, and the worker neither knows nor cares which transport carries its streams.
