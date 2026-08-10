# anon-rpc prototype

A working prototype of the [anon-rpc](../SPEC.md) harness and a conforming
worker, as two npm workspaces:

- [browser-harness/](browser-harness/) — the wallet-side runtime (the §3.1
  conformance target), published as
  [`@anon-rpc/browser-harness`](https://www.npmjs.com/package/@anon-rpc/browser-harness).
- [passthrough-worker/](passthrough-worker/) — the minimal template worker
  (the §3.2 conformance target): a pure fetch passthrough. **Copy that
  directory to write your own anon-client**; it deliberately copies the
  worker-facing spec types instead of importing them, so it stands alone.
  Not published: workers are distributed by content hash via specifier
  resolvers (§4), not npm.
- [test-worker/](test-worker/) — the worker the e2e drives: exercises the
  wider capability surface (KPS routing, persistent storage) on top of the
  passthrough behaviour.
- [specifier/](specifier/) — the on-chain half of §4: the `WorkerSpecifier`
  reference contract (Foundry) and the script that publishes a worker
  on-chain (pins the bundle hash, verifies resolvers serve the bytes, deploys,
  reads back).

The harness runs untrusted, hash-pinned worker code inside a Web Worker in a null-origin
sandboxed iframe (§6), and exposes the `AnonRpcWorkerApi` capability surface
(§7–§13) across the `postMessage` boundary — including a **real KPS transport**
([`@kpstreams/webrtc-client`](https://www.npmjs.com/package/@kpstreams/webrtc-client),
from [KPS](https://privacy-ethereum.github.io/kps/)) bridged
from the host to the worker.

## Architecture

```
 host page ───────────────────────────────┐
  AnonRpcWorker (§5)                      │  null-origin iframe (sandbox=allow-scripts)
   • reads specifier, verifies keccak     │   iframe-boot: blob-spawns the Worker,
     hash of bundle bytes (§4)            │   relays the entangled port
   • runs real KPS client (WebRTC)        │        │
   • bridges kps / storage / log / calls  │        ▼
   • exposes worker.fetch                 │   Web Worker
                                          │    worker-runtime (harness): builds
        MessageChannel port ──────────────┼──▶  anonRpcWorker, importScripts the
        (relayed once through the iframe, │     verified bundle
         then host↔worker direct)         │    worker bundle (untrusted,
                                          │     hash-pinned): acceptCall loop,
                                          │     fetch passthrough (+ kps/storage
                                          │     in the test worker)
```

The capability port carries a small request/response + event RPC
([browser-harness/src/protocol.ts](browser-harness/src/protocol.ts)). KPS stream byte flow rides **transferred**
WHATWG `ReadableStream`/`WritableStream` objects (transferable streams, per the
Streams standard: the browser carries them over the `MessagePort`), so
backpressure is handled by the platform pipe and only
lifecycle calls (`closeWrite`, `cancelRead`, …) round-trip as RPC. This is why
the worker never needs WebRTC itself — the harness owns the transport.

### Source map

| File | Role |
| --- | --- |
| [browser-harness/src/spec-types.ts](browser-harness/src/spec-types.ts) | Spec type surface (§5, §7–§13) |
| [browser-harness/src/protocol.ts](browser-harness/src/protocol.ts) | `PortRpc`: request/response + events + transfer + cross-boundary abort |
| [browser-harness/src/host/AnonRpcWorker.ts](browser-harness/src/host/AnonRpcWorker.ts) | Host class (§5): boot, iframe, fetch/acceptCall queue, storage, log |
| [browser-harness/src/host/specifier.ts](browser-harness/src/host/specifier.ts) | §4: specifier read (eth_call + ABI decode) + keccak verify |
| [browser-harness/src/host/kps-bridge-host.ts](browser-harness/src/host/kps-bridge-host.ts) | Host side of KPS, using real `@kpstreams/webrtc-client` |
| [browser-harness/src/host/idb-storage.ts](browser-harness/src/host/idb-storage.ts) | §11 storage backend: IndexedDB, namespaced per specifier address (memory fallback) |
| [browser-harness/src/iframe/iframe-boot.ts](browser-harness/src/iframe/iframe-boot.ts) | Null-origin iframe: spawns worker, relays port |
| [browser-harness/src/worker/worker-runtime.ts](browser-harness/src/worker/worker-runtime.ts) | Harness code in the Worker: builds `anonRpcWorker`, loads bundle |
| [browser-harness/src/worker/anon-rpc-worker-api.ts](browser-harness/src/worker/anon-rpc-worker-api.ts) | Worker-side capability proxies |
| [passthrough-worker/src/passthrough-worker.ts](passthrough-worker/src/passthrough-worker.ts) | The minimal §3.2 worker template: pure fetch passthrough (own copy of the worker-facing types) |
| [test-worker/src/test-worker.ts](test-worker/src/test-worker.ts) | e2e worker: passthrough + kps+echo:// routing + persisted call counter |
| [specifier/src/WorkerSpecifier.sol](specifier/src/WorkerSpecifier.sol) | §4 reference specifier contract (owner-updatable, renounceable) |
| [specifier/publish-worker.mjs](specifier/publish-worker.mjs) | publish a worker on-chain: hash, verify resolvers, deploy, read back |

## Prerequisites

- Node 20+. Everything KPS comes from npm: the harness uses
  `@kpstreams/webrtc-client`, and the e2e runs its echo peer in-process via
  `@kpstreams/server` — no Go toolchain or
  [kps](https://github.com/privacy-ethereum/kps) checkout required.
- [Foundry](https://getfoundry.sh) only for the [specifier/](specifier/)
  subproject (contract build/tests and on-chain publishing); everything else
  works without it, and the specifier tests skip gracefully when it's absent.

All commands below are run from this `impl/` directory.

## Build & test

```sh
npm install            # installs both workspaces
npm run build          # browser-harness/dist (host.js + types) + passthrough-worker/dist/passthrough-worker.js
npm run typecheck      # tsc --noEmit in each workspace
npm test               # unit tests (node --test): protocol, call queue, request normalization, specifier, worker API
npm run test:e2e       # builds, starts the in-process kps echo peer, drives headless Chromium
```

The e2e test ([test/run-e2e.mjs](test/run-e2e.mjs)) asserts, end to end:

1. the iframe is null-origin (`sandbox="allow-scripts"`) — §6;
2. a plain `worker.fetch()` passes through the boundary and returns the body;
3. a `kps+echo://<addr>` fetch is routed over a **real KPS stream** to the
   in-process echo peer and the bytes round-trip — proving the bridged
   transport.

The §4 integrity path is real: the mock specifier returns an ABI-encoded
`workerHash()`/`workerResolvers()`, the harness fetches the bundle and rejects
it unless `keccak256(bytes)` matches.
