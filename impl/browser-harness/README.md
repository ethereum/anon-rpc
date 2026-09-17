# @anon-rpc/browser-harness

A browser harness for [anon-rpc](https://github.com/ethereum/anon-rpc)
— a standard that lets a wallet or application make **anonymized RPC requests**
by running hash-pinned anon-client code inside a sandboxed worker.

Implements the [anon-rpc specification](https://ethereum.github.io/anon-rpc/spec/)
version **0.3.1**. (The package version is kept `>=` the implemented spec
version; a package release without a spec change bumps past it.)

The harness:

- resolves the anon-client bundle from an on-chain specifier contract — over
  `https:` or over KPS itself via `kps:` resolver entries (SPEC §4.1–4.2) —
  and verifies `keccak256(bytes) == workerHash()` before executing a single
  byte (trust the hash, not the URL);
- runs it in a **Web Worker inside a null-origin sandboxed iframe**, with no
  ambient access to your DOM, storage, cookies, or keys;
- grants it a small, explicit capability API — inbound fetch calls, a
  [KPS](https://ethereum.github.io/kps/) key-pinned transport
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

### Strict Content Security Policies

By default the harness builds its null-origin iframe with `srcdoc` and an inline
bootstrap script, which needs nothing from you. If your page's CSP omits
`'unsafe-inline'` for `script-src`, that bootstrap will not run — a `srcdoc`
document inherits the embedder's policy, and a policy can only be tightened
from within a document, never relaxed. The symptom is a `ready` that never
settles, plus a CSP violation in the console.

Serve the harness's bootstrap page yourself and point `iframeUrl` (SPEC §5) at
it:

```ts
new AnonRpcWorker({ address, preExisting, iframeUrl: "/anon-rpc-iframe.html" });
```

The page needs only the harness's own bootstrap script, which ships in this
package as `dist/iframe-boot.js`:

```html
<!doctype html><meta charset="utf-8"><script src="/anon-rpc-iframe.js"></script>
```

The harness still applies `sandbox="allow-scripts"` itself, so the document is
placed at an opaque origin whichever route it came from, and §6 requires the URL
to be same-origin with your page — a cross-origin bootstrap would hand the
isolation boundary to a third party, so the harness rejects one.

For MV3 browser extensions this is not optional and the page must additionally
be declared in the manifest's `sandbox.pages`;
[`@anon-rpc/browser-extension-harness`](../browser-extension-harness) packages
all of that.

## Notes

- Browser-only: the isolation model is a null-origin iframe and the KPS
  transport runs over WebRTC. A native/Node harness would be a separate
  package.
- The worker-facing capability API (`anonRpcWorker`) and all conformance
  requirements are defined in the
  [specification](https://github.com/ethereum/anon-rpc/blob/main/SPEC.md).
  A template anon-client to copy lives in
  [`impl/passthrough-worker`](https://github.com/ethereum/anon-rpc/tree/main/impl/passthrough-worker).
- Status: prototype-grade reference implementation of a draft spec; interfaces
  track the spec and may change.

## License

MIT © Ethereum Foundation
