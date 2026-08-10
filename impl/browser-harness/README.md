# @anon-rpc/browser-harness

A browser harness for [anon-rpc](https://github.com/privacy-ethereum/anon-rpc)
— a standard that lets a wallet or application make **anonymized RPC requests**
by running untrusted, hash-pinned anon-client code inside a sandboxed worker.

Implements the [anon-rpc specification](https://privacy-ethereum.github.io/anon-rpc/spec/)
version **0.3.0**. (The package version is kept `>=` the implemented spec
version; a package release without a spec change bumps past it.)

The harness:

- resolves the anon-client bundle from an on-chain specifier contract — over
  `https:` or over KPS itself via `kps:` resolver entries (SPEC §4.1–4.2) —
  and verifies `keccak256(bytes) == workerHash()` before executing a single
  byte (trust the hash, not the URL);
- runs it in a **Web Worker inside a null-origin sandboxed iframe**, with no
  ambient access to your DOM, storage, cookies, or keys;
- grants it a small, explicit capability API — inbound fetch calls, a
  [KPS](https://privacy-ethereum.github.io/kps/) key-pinned transport
  (bridged so the worker never touches WebRTC), persistent storage
  (IndexedDB on the host origin, namespaced per specifier), and logging;
- hands you back one thing: an anonymized `fetch`.

## Install

```sh
npm install @anon-rpc/browser-harness
```

## Use

```ts
import { AnonRpcWorker } from "@anon-rpc/browser-harness";

const worker = new AnonRpcWorker({
  // The IWorkerSpecifier contract identifying the anon-client by hash.
  address: "0x…",
  // Optional: structured-cloneable value delivered to the worker as
  // `anonRpcWorker.config`. Opaque to the harness; schema is the worker's.
  config: { network: "mainnet" },
  // Bootstrap provider used only to read the specifier (breaks the circular
  // "need the chain to reach the chain" dependency).
  preExisting: { rpcProvider },
});

// Optional: Wait for the worker to report that it is ready. You can start
// making fetch calls before this - they'll just get buffered.
// await worker.ready;

// A standard fetch, routed through the sandboxed anon-client.
// It is this-bound, so passing it around as a free function is fine.
const res = await worker.fetch("https://rpc.example/", {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }),
});

worker.close(); // tears down the iframe and worker
```

## Notes

- Browser-only: the isolation model is a null-origin iframe and the KPS
  transport runs over WebRTC. A native/Node harness would be a separate
  package.
- The worker-facing capability API (`anonRpcWorker`) and all conformance
  requirements are defined in the
  [specification](https://github.com/privacy-ethereum/anon-rpc/blob/main/SPEC.md).
  A template anon-client to copy lives in
  [`impl/passthrough-worker`](https://github.com/privacy-ethereum/anon-rpc/tree/main/impl/passthrough-worker).
- Status: prototype-grade reference implementation of a draft spec; interfaces
  track the spec and may change.

## License

MIT © Ethereum Foundation
