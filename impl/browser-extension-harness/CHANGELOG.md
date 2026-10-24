# @anon-rpc/browser-extension-harness changelog

Changes to this package by version. Specification changes are in the
[specification changelog](https://github.com/ethereum/anon-rpc/blob/main/CHANGELOG.md);
this package implements the spec version named in its README.

## 0.4.0 — 2026-10-23

Implements spec 0.4.0. Requires `@anon-rpc/browser-harness` 0.4.0
(pinned exactly).

- **Added: per-call options.** Keys of a `fetch` init that the spec does not
  model — `anonOptions`, and anything else — are forwarded to the worker
  rather than dropped (§9.1). Both modes carry them: in-page through the browser
  harness, and over the service worker → offscreen hop, whose JSON-only
  messaging needed a tagged encoding so `undefined`, NaN, -0 and bytes arrive as
  themselves.
- **Changed (breaking): `config` must be a §9.4 plain value** — JSON, plus
  `undefined`, `Uint8Array` and `ArrayBuffer`. Anything else, or a cyclic
  value, makes the constructor throw a `TypeError`. Configs that previously
  crossed the JSON hop lossily (a `Uint8Array`, an `undefined` property) now
  arrive exactly, and the offscreen worker cache keys on that exact value.
- `fetch` is typed `AnonFetch` (re-exported from the browser harness).

## 0.3.3 — 2026-10-13

Implements spec 0.3.2 (unchanged). Requires `@anon-rpc/browser-harness` 0.3.3
(pinned exactly).

- **Added: Firefox support.** `AnonRpcWorker` now picks where the browser harness
  runs when it is constructed: in an offscreen document where `chrome.offscreen`
  exists (Chromium, as before), or directly in the extension page where there is
  a DOM (Firefox's MV3 background page, which has no offscreen documents and
  needs none). Same import, same init, same §5 surface — existing Chromium
  integrations need no change.
- **Firefox manifest** (see the README's Firefox section): `background.page`,
  `sandbox.pages` plus a `content_security_policy.sandbox` with `data:` in
  `script-src`, and no `offscreen` permission. Measured on Firefox 140 ESR and
  157.
- **Firefox isolation model, documented.** The iframe's `sandbox` attribute is
  the boundary there: Firefox applies no CSP inside an extension frame carrying
  the attribute, even for a page listed in `sandbox.pages`. The page and policy
  are still declared for forward compatibility.
- **Firefox assets:** copy only `sandbox.html` and `sandbox.js`;
  `offscreen.html` and `offscreen.js` are Chromium-only.
- **Bundle size on Chromium:** both modes are now in the bundle, because a
  service worker cannot load code on demand (`import()` is disallowed there).
  The in-page mode is the browser harness itself, which the prebuilt
  `offscreen.js` also contains, so a Chromium service worker carries it twice —
  about 18 KB gzipped. Backgrounds under LavaMoat will see policy entries for
  `@anon-rpc/browser-harness` and `@kpstreams/*`, whose code only runs on
  Firefox.
- **AMO policy:** the README now notes that Firefox's add-on review has no
  exception for remotely hosted code in sandboxed pages, unlike the Chrome Web
  Store.
- **Packaging:** `typesVersions`, so consumers on `moduleResolution: "node"`
  resolve the `./offscreen` entry's types.
- **Tests:** a Firefox e2e (`test/e2e-firefox.mjs`) runs the Chromium e2e's
  privilege-boundary checks against a real Firefox through geckodriver; skipped
  unless `FIREFOX_BIN` and `GECKODRIVER` are set. CI runs it.

Earlier releases are recorded in the specification changelog and the git
history.
