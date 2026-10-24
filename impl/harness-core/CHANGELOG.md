# @anon-rpc/harness-core changelog

Changes to this package by version. Specification changes are in the
[specification changelog](https://github.com/ethereum/anon-rpc/blob/main/CHANGELOG.md).

## 0.4.0 — 2026-10-24

Tracks spec 0.4.0. First release: the platform-neutral code previously copied
between `@anon-rpc/browser-harness`, `@anon-rpc/browser-extension-harness` and
the Node harness, now in one place.

- Spec types, `CallQueue`, `LogQueue`, `readSpecifier` /
  `fetchAndVerifyBundle`, `copyPlainValue`, `RpcError` / `serializeError`.
- `fetchAndVerifyBundle` takes extra `ResolverKind`s, so a harness without
  KPS shares the §4 code and simply leaves `kps:` entries unrecognized.
- `CallQueue.rejectAll` returns the items it dropped, so the caller settles
  them. (The Node copy already did; the browser copy had drifted.)
- `copyForwardedEntries` (§9.1): one implementation of which init entries
  are forwarded and how they are copied, for the four places that did it
  separately — including the extension's Firefox mode, whose copy ran only
  after awaiting its worker and so missed changes made after `fetch` returned.
- `encodePlain` / `decodePlain`: one JSON encoding of §9.4 plain values, with
  bytes as hex, for the extension's messaging hop and the QuickJS guest.
