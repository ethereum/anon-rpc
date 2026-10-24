# @anon-rpc/harness-core

The parts of an [anon-rpc](https://github.com/ethereum/anon-rpc) harness that
are about the specification rather than about where the harness runs. Each
harness — browser, browser extension, Node — wraps these in its own transport
and isolation; sharing them is what keeps the harnesses agreeing.

Tracks the [anon-rpc specification](https://ethereum.github.io/anon-rpc/spec/)
version **0.4.0**. (The package version is kept `>=` that spec version.)

- **Spec types** (`@anon-rpc/harness-core/spec-types`) — the §5 and §7–§13
  type surface. Worker templates keep their own copy, so a worker builds with
  no harness dependency.
- **`readSpecifier` / `fetchAndVerifyBundle`** (§4) — the specifier read
  through a bootstrap provider, the resolver fetch, and the keccak256 check.
  Entry kinds that need a transport, such as `kps:`, are passed in as a
  `ResolverKind` by a harness that has one; without it they are ignored, as
  §4.1 requires.
- **`CallQueue`** (§8) — ordered, no-drop, one-at-a-time inbound calls.
- **`LogQueue`** (§13.1) — ordered, bounded log retention.
- **`copyPlainValue`, `encodePlain` / `decodePlain`** (§9.4) — copying plain
  values, and carrying them across a boundary that only takes JSON.
- **`RpcError` / `serializeError`** (§12) — errors that keep `name` and `code`
  across a boundary.

This is an implementation dependency of the harnesses, not something a wallet
or a worker needs to install.

## License

MIT
