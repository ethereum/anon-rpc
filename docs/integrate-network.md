# Integration Guide: Anonymizing Networks

anon-rpc lets an anonymizing network — a mixnet, onion router, RPC privacy
relay — offer its transport to every anon-rpc wallet at once, with no
per-wallet SDK integrations. The mechanism: the network ships its client as a
**worker bundle**, a single file identified by the `keccak256` hash of its
bytes; that hash is published on-chain in a specifier contract the network
owns; and wallets run the bundle in a sandbox, granting it a small capability
API. The trust a wallet extends is narrow — bounded to the RPC path by the
sandbox — and pinned to bytes anyone can audit.

This guide walks through providing that: authoring a conforming worker,
publishing its specifier, and hosting the bytes. Three deliverables:

1. a conforming **worker bundle** (your network client, one file);
2. a **specifier contract** pinning its hash and suggesting where to fetch it;
3. hosting for the bundle bytes (any static host; or over KPS itself).

## 1. Author the worker

Start by copying [`impl/passthrough-worker`](https://github.com/ethereum/anon-rpc/tree/main/impl/passthrough-worker)
— a complete, minimal, conforming worker. It deliberately **copies** the
worker-facing types (`spec-types.ts`) rather than importing them: your worker
is a standalone artifact, buildable with no dependency on any harness.

The shape of every worker is an accept loop:

```ts
declare const anonRpcWorker: AnonRpcWorkerApi; // your entire platform

(async () => {
  // Set up your network client here (dial entry nodes via anonRpcWorker.kps,
  // read anonRpcWorker.config, load state from anonRpcWorker.storage…).

  anonRpcWorker.signalReady(); // or signalFailed({ code, message }) — see below

  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    if (call.kind !== "fetch") continue; // future call kinds: ignore unknown
    call.respond(handle(call.url, call.requestInit));
  }
})();
```

The harness queues inbound calls in order, with backpressure, buffering them
until the worker accepts — a slow startup loses nothing. A call leaves the
queue only by being delivered, aborted by the host, or failed back to the
host if the worker dies; none are silently discarded.

### Your platform: the capability API

Everything your code gets is on the global `anonRpcWorker` (SPEC §7):

- **`kps`** — [KPS](https://ethereum.github.io/kps/) key-pinned
  streams: `dial("<ip>:<port>:<certhash>")` opens secure, multiplexed byte
  streams to a peer identified by a certificate hash. The worker-side API is
  ready-made — the harness bridges the transport, no WebRTC or socket access
  required — but *using* it is a real adoption decision on the network side:
  your nodes must run KPS listeners to be dialled this way. It's optional; a
  worker can instead reach its network over WebSocket or any other ambient
  API — at a portability cost, because a worker that relies on APIs outside
  the capability set only works on platforms that supply them, while the
  capability API (KPS included) is guaranteed on every harness platform.
  What KPS buys is direct connections to nodes without the blessing of
  certificate authorities or domain registrars — a substantial gain in
  censorship resistance.
- **`config`** — whatever the wallet passed at construction, structured-clone
  intact, schema entirely yours. Typical use: entry node addresses, chain
  selection, tuning. **Document your schema for wallets.**
- **`storage`** — async binary KV, namespaced to your specifier address,
  persistent across restarts and page reloads. Directory descriptors, cached
  circuits, counters.
- **`log`** — console-like; surfaced to the host's console (hosts may filter
  or redact).
- **`signalReady()` / `signalFailed(reason?)`** — call `signalReady()` once
  you can serve. If you *can't* — bad config, entry nodes unreachable —
  call `signalFailed({ code: "your-code", message: "…" })` instead of hanging:
  the wallet's `ready` rejects with your `code` to branch on. Failure is
  final; after it, nothing will be delivered.

### Conformance (SPEC §3.2)

- Respond to `fetch` calls via `acceptCall`; enable Ethereum RPC either as
  general web request access or at a nominated URL like `/ethereum-rpc`.
- **Minimize ambient APIs.** Anything you use beyond `anonRpcWorker` (even
  `fetch`) must exist on every platform a harness runs you on. The capability
  API is guaranteed; the rest is not.
- Don't depend on how the messaging under the capability API works — it's
  harness-internal and varies.

### Build: your bytes are your identity

Bundle to a **single standalone file** (the template uses esbuild, IIFE,
no external imports). The exact bytes are what `workerHash()` pins — build
deterministically, commit the toolchain, and publish the source so anyone can
rebuild and verify the hash. That reproducibility is your users' audit trail.

Test against the reference harness before publishing: point the
[live demo](https://ethereum.github.io/anon-rpc/demo/) at your
specifier (next step) on a local chain, or adapt the repo's e2e
(`impl/test/run-e2e.mjs`), which boots workers against mock specifiers.

## 2. Publish the specifier

The on-chain surface anon-rpc requires is deliberately tiny (SPEC §4):

```solidity
interface IWorkerSpecifier {
  // keccak256 hash of the canonical worker bundle bytes.
  function workerHash() external view returns (bytes32);
  // Suggested locations from which the bundle MAY be retrieved.
  function workerResolvers() external view returns (string[] memory);
}
```

Any contract exposing those two views is a specifier — and implementing your
own is squarely in your wheelhouse. The hash is what wallets pin; **how it
changes is your governance design space**: a multisig or timelock behind the
setter, DAO-voted upgrades, integration with on-chain machinery your network
already has. Whatever update policy your users already trust in you can
govern which code they run.

For a ready-made starting point,
[`impl/specifier`](https://github.com/ethereum/anon-rpc/tree/main/impl/specifier)
has `WorkerSpecifier.sol`, a deliberately simple single-owner model:

- `setWorker(newHash, newResolvers)` — the owner ships a new version; wallets
  pick it up on their next boot, keccak-verified as ever;
- `renounceOwnership()` — freeze the current hash **forever**, converting
  "trust the owner" into "trust these exact bytes". Say which model you run.

It comes with a publish script:

```sh
cd impl/specifier
# .env: RPC_URL, PRIVATE_KEY, RESOLVER_URLS, … (see its README for all knobs)
node publish-worker.mjs
```

The script rebuilds the bundle, prints its hash, verifies each resolver
actually serves the pinned bytes *before* spending gas, deploys, reads the
contract back, and (with `ETHERSCAN_API_KEY`) verifies the source. Deployment
is ~1.1M gas. `RESOLVER_URLS` accepts `https:` URLs and `kps:` resolver
strings; `--github` also publishes the bundle to a content-addressed branch of
your repo and adds its raw URL as a resolver.

## 3. Host the bundle

Resolvers are advisory — any bytes matching the hash are accepted, from
anywhere — so hosting is low-stakes and you should list several:

- **Any static host.** Serve the exact bytes; mark them immutable
  (`Cache-Control: public, max-age=31536000, immutable` — the content is
  hash-addressed, so changed bytes would only fail verification). The
  `--github` resolver above is a zero-infrastructure version of this.
- **Over KPS itself** (SPEC §4.1–4.2) — the no-CA ideal: a `kps:` resolver
  entry serves the bundle from your own KPS endpoint, pinned by certificate
  hash, with no domain, certificate authority, or hosting provider anywhere
  in the chain. It's one `GET` per stream in plain HTTP/1.1 syntax (§4.2 is
  self-contained, ~a page; harnesses advertise `Accept-Encoding` and accept
  gzip and friends). Optional — but if your network already runs KPS
  endpoints, it makes wallet bootstrap exactly as decentralized as the
  network itself. A reference responder over `@kpstreams/server` is ~40
  lines; see the bundle server in `impl/test/run-e2e.mjs`.

## Checklist

- [ ] Worker copies the template, serves Ethereum RPC via `acceptCall` (§3.2)
- [ ] `signalReady()` on success, `signalFailed({ code })` with documented codes on refusal
- [ ] `config` schema documented for wallets (if you need it)
- [ ] Deterministic single-file bundle; source published for hash verification
- [ ] Specifier deployed; its update governance (who can change the hash, or frozen forever) stated publicly
- [ ] Two or more resolvers listed, serving byte-identical content
- [ ] Booted end-to-end via the demo page against your specifier
- [ ] Listed in [`known-workers.json`](https://github.com/ethereum/anon-rpc/blob/main/known-workers.json)
      (open a PR) — that file drives the demo's worker picker and the sample in
      the wallet guide, so a listing is how wallet authors find you. Include a
      `configNote` for anything shared or provisional, like a demo endpoint.

## Reference

- [Specification](https://ethereum.github.io/anon-rpc/spec/) — §3.2
  worker conformance, §4 identity, §7–§13 the capability API in full.
- [Wallet integration guide](integrate-wallet.md) — what the other side sees.
