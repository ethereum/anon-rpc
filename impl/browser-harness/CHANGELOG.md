# @anon-rpc/browser-harness changelog

Changes to this package by version. Specification changes are in the
[specification changelog](https://github.com/ethereum/anon-rpc/blob/main/CHANGELOG.md);
this package implements the spec version named in its README.

## 0.4.0 — 2026-10-23

Implements spec 0.4.0.

- **Added: per-call options.** Keys of a `fetch` init that the spec does not
  model — `anonOptions`, standard fields such as `cache`, and anything else —
  are forwarded to the worker in `requestInit` rather than dropped (§9.1). They
  are copied when `fetch` is called; a value that is not a §9.4 plain value
  rejects the `fetch` with a `TypeError` instead of being dropped.
- **Added: `anonOptions.isolationKey`** (§9.3), typed on `AnonOptions`.
- **Changed (breaking): `config` must be a §9.4 plain value** — JSON, plus
  `undefined`, `Uint8Array` and `ArrayBuffer`. Anything else (`Date`, `Map`,
  class instances, …), or a cyclic value, makes the constructor throw a
  `TypeError`; previously it was structured-cloned.
- `fetch` is typed `AnonFetch`, which accepts `anonOptions` and is still
  assignable to `typeof fetch`. New exported types: `AnonFetch`, `AnonOptions`,
  `PlainValue`.

## 0.3.3 — 2026-10-13

Implements spec 0.3.2 (unchanged).

- **Fixed: worker bundles load on Firefox.** Firefox refuses `importScripts(blob:)`
  in a worker whose origin is opaque — which §6 makes the harness's worker — even
  for a blob the worker created itself and even when a CSP allows `blob:`
  (measured on Firefox 140 and 157). The worker runtime now probes with an empty
  blob script and, where that is refused, imports the verified bundle as a
  `data:` URL instead, with the same classic-script semantics. Other browsers
  keep using `blob:`. Probing first, rather than retrying after a failure, means
  a bundle whose top level throws is never run twice.
- **Integrators with a bootstrap page under a strict CSP** (`iframeUrl`): on
  Firefox, allow `data:` in that page's `script-src` wherever a policy applies
  there. Chromium needs no change.

Earlier releases are recorded in the specification changelog and the git
history.
