# anon-rpc

[![ci](https://github.com/privacy-ethereum/anon-rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/privacy-ethereum/anon-rpc/actions/workflows/ci.yml)

A standard that lets a wallet or application make anonymized RPC requests by
running untrusted, hash-pinned client code inside a sandboxed worker and
granting it a small, explicit, transport-neutral capability API.

- [SPEC.md](SPEC.md) — the normative specification (design rationale in its
  Appendix A; version history in [CHANGELOG.md](CHANGELOG.md)).
- Integration guides: [for wallets & apps](docs/integrate-wallet.md) ·
  [for anonymizing networks](docs/integrate-network.md).
- [impl/](impl/) — a working reference prototype (browser harness + conforming
  worker, with a real KPS transport bridged across the sandbox boundary).
