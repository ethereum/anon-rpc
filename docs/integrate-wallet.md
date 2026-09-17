# Integration Guide: Web Wallets and Web Applications

`anon-rpc` makes your RPC anonymous by constructing an anonymous `fetch`
function.

The specific machinery needed for any particular anonymous network runs
inside a sandbox to reduce the risk for your users and make it easier to
switch networks.

This means there is a need to set up that sandbox itself and communicate
with the worker inside. If you prefer, you can implement that yourself,
but we also provide `@anon-rpc/browser-harness` to make it easier - this
part of the code still lives inside your application.

If you want to go the DIY route, you should [read the spec](../SPEC.md).
Otherwise, read on to learn how to use the provided harness.

## Install

```sh
npm install @anon-rpc/browser-harness
```

Browser-only: the sandbox is a null-origin iframe and the built-in
[KPS](https://ethereum.github.io/kps/) transport runs over WebRTC. A
native harness would be a separate package.

## Quick start

<!--WORKER_PICKER:START-->

```ts
import { AnonRpcWorker } from "@anon-rpc/browser-harness";

const worker = new AnonRpcWorker({
  // The anonymizing network's specifier contract, on mainnet.
  address: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27",

  // Optional, network-defined (see the network's docs for its schema).
  // Delivered to the worker as-is; the harness never interprets it.
  config: undefined,

  preExisting: {
    // Used ONCE, to read the specifier contract — this breaks the circular
    // "need the chain to reach the chain" dependency. Any EIP-1193-style
    // provider works:
    rpcProvider: {
      request: ({ method, params }) => myExistingProvider.request({ method, params }),
    },
  },
});

// Optional: fetch calls made before readiness are buffered, not dropped.
// await worker.ready;

// A standard fetch, routed through the sandboxed anon-client.
const res = await worker.fetch("https://rpc.example/", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
});
const { result } = await res.json();

worker.close(); // tears down the sandbox
```

The address above is the passthrough worker, which fulfils calls with an
ordinary `fetch` — it exercises the sandbox and hash pinning without
anonymizing anything. Every deployment we know of, and the config each one
expects, is listed in
[adopters.json5](https://github.com/ethereum/anon-rpc/blob/main/adopters.json5);
the [live demo](https://ethereum.github.io/anon-rpc/demo/) runs any of
them.

<!--WORKER_PICKER:END-->

`worker.fetch` is this-bound — pass it as a free function to anything that
accepts a custom `fetch` or transport (a viem custom transport, an ethers
`FetchRequest` getUrl hook, your own JSON-RPC wrapper).

## What happens when you construct the worker

1. The harness calls `workerHash()` and `workerResolvers()` on the specifier
   contract via your bootstrap provider.
2. It fetches the worker bundle from the resolvers (`https:` URLs, or `kps:`
   entries served over KPS itself) and **only executes bytes whose
   `keccak256` equals the pinned hash**. Resolvers, CDNs, and mirrors are
   untrusted; the hash is the identity.
3. The bundle runs in a Web Worker inside a sandboxed null-origin iframe. Its
   entire platform is a small capability API — inbound fetch calls, the KPS
   transport, storage scoped to this specifier address, logging. No ambient
   access to your page.

## The trust model, honestly

- **You are trusting the on-chain hash** — that is, whoever controls the
  specifier contract. The code itself is auditable: anyone can rebuild the
  network's published bundle and check the hash.
- **Your bootstrap provider is trusted for one read.** The `workerHash()`
  value arrives through it — a lying bootstrap RPC could point you at
  different code. Use the provider you already rely on. Note that this one
  read is *not* anonymized (it happens before the anon-client exists); it
  reveals only that you're reading a specifier contract.
- **The sandbox reduces the worker's reach — it doesn't eliminate trust.**
  The worker can't touch keys, cookies, or the DOM, and the pinned hash
  rules out silent substitution. But it holds the same position as any RPC
  endpoint: it sees every request routed through it (including signed
  transactions before broadcast), and it produces the responses your
  application acts on — a malicious worker can observe, censor, or lie.
  Choosing a network is still a trust decision; the sandbox narrows the
  blast radius, and the hash makes what you're trusting auditable.

## Errors and lifecycle

`worker.ready` rejects — and all pending and future `fetch` calls fail — when
the worker can't be started or has failed:

- no resolver yielded bytes matching the pinned hash;
- the worker crashed (uncaught errors are unrecoverable by design);
- the worker **declined**: a worker can call `signalFailed({ code, message })`
  — bad config, unreachable network, unsupported platform. The error reaching
  you carries the network-defined `code`:

```ts
import { RpcError } from "@anon-rpc/browser-harness";

try {
  await worker.ready;
} catch (e) {
  if (e instanceof RpcError && e.code === "unsupported-chain") {
    // branch on code — message text is diagnostic only
  }
}
```

Individual `fetch` calls reject with `RpcError` (carrying the worker's error
`name`/`code`) or with standard `AbortError` when you abort via
`init.signal` — the same contract as native `fetch`.

Practical notes:

- One `AnonRpcWorker` per network, long-lived; don't construct per request.
- Calls made before `ready` resolves are buffered in order — you can fire
  immediately after construction.
- `close()` fails anything in flight and releases the iframe/worker. Create a
  fresh instance to reconnect.
- The worker gets IndexedDB-backed storage namespaced to the specifier
  address (it persists across reloads); it can't read any other namespace.

## Try it

The [live demo](https://ethereum.github.io/anon-rpc/demo/) is this
exact integration: paste a bootstrap RPC URL and a specifier address, and
watch an ETH balance stream through the sandboxed worker.

Shipped it? Add yourself to
[`adopters.json5`](https://github.com/ethereum/anon-rpc/blob/main/adopters.json5)
(open a PR) and you'll appear on the
[adopters page](https://ethereum.github.io/anon-rpc/adopters/), alongside the
networks you can reach.

## Reference

- [Specification](https://ethereum.github.io/anon-rpc/spec/) —
  normative behavior for everything above (§5 host API, §6 isolation, §12
  errors).
- [Adopters](https://ethereum.github.io/anon-rpc/adopters/) — the anonymizing
  networks live on mainnet today, with the specifier address for each.
- [`@anon-rpc/browser-harness`](https://www.npmjs.com/package/@anon-rpc/browser-harness)
  — the harness package (README documents the full `WorkerInit`).
- Networks: see [the network integration guide](integrate-network.md) for the
  other side of this contract.
