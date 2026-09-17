# @anon-rpc/browser-extension-harness

An MV3 browser-extension harness for
[anon-rpc](https://github.com/ethereum/anon-rpc) — a standard that lets a wallet
or application make **anonymized RPC requests** by running hash-pinned
anon-client code inside a sandboxed worker.

Implements the [anon-rpc specification](https://ethereum.github.io/anon-rpc/spec/)
version **0.3.1**. (The package version is kept `>=` the implemented spec
version; a package release without a spec change bumps past it.)

This is a variant of [`@anon-rpc/browser-harness`](../browser-harness), not a
reimplementation — it depends on it and runs it. The isolation, the §7
capability API, §8's call discipline, §9 payloads, §10's KPS bridge and §11
storage are all that package's. What this one adds is the two things an
extension changes about *where* the harness can run: a DOM to hold the iframe,
and a packaged page to load into it.

- [Install](#install)
- [Manifest](#manifest)
- [Use](#use)
  - [If your extension already has an offscreen document](#if-your-extension-already-has-an-offscreen-document)
- [Why an extension needs its own harness](#why-an-extension-needs-its-own-harness)
- [Remotely hosted code, and why this is allowed](#remotely-hosted-code-and-why-this-is-allowed)
- [What the worker can and cannot reach](#what-the-worker-can-and-cannot-reach)
- [Running the tests](#running-the-tests)
- [Status](#status)

## Install

```sh
npm i @anon-rpc/browser-extension-harness
```

Copy the packaged assets into your extension — **from your build script, not
once by hand**:

```sh
rm -rf extension/anon-rpc
cp -r node_modules/@anon-rpc/browser-extension-harness/dist/static/anon-rpc extension/
```

That gives you `extension/anon-rpc/<version>-<hash>/` holding four files —
`offscreen.html` / `.js` (the offscreen document) and `sandbox.html` / `.js`
(the §6 sandboxed page).

The version stamp in the path is why the copy belongs in your build. Those two
files are the far half of a protocol whose near half is in `background.js`,
which your bundler rebuilds from `node_modules` on every install. Upgrade
without re-copying and the halves disagree — and they disagree *silently*:
nothing on the boot path has a timeout, so `worker.ready` would simply never
settle. Resolving the path from the build makes a stale copy a missing file
instead of a subtly wrong one, and the error names the fix.

Your manifest does not need updating per version; see below.

## Manifest

Every entry below is load-bearing, and three of them fail in ways that do not
name themselves.

```jsonc
{
  "manifest_version": 3,
  "background": { "service_worker": "background.js", "type": "module" },

  // The DOM the extension is allowed to have.
  "permissions": ["offscreen"],

  // For the OFFSCREEN document's fetch of the bundle. The worker gets none of
  // this: it runs at a null origin, so its own requests are ordinary
  // cross-origin ones subject to CORS. That is the isolation working.
  "host_permissions": ["https://your-resolver.example/*"],

  // What puts the worker at an opaque origin with its own CSP — and what the
  // remote-code carve-out is about. This is the only CSP an extension may
  // relax, which is why §5's iframeUrl has to point at a page listed here.
  "sandbox": { "pages": ["anon-rpc/*/sandbox.html"] },

  "content_security_policy": {
    "sandbox": "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; child-src 'self' blob:; worker-src 'self' blob:; connect-src *;"
  }
}
```

- **`blob:` in `script-src`** is the one most easily missed. The worker runtime
  and the worker bundle are both `importScripts`'d from blob URLs, and
  `importScripts` is checked against `script-src`, not `worker-src`. Without it
  the bundle fails with `The script at 'blob:null/…' failed to load` and nothing
  mentions CSP.
- **The `*` in `sandbox.pages` is a real wildcard**, which is what keeps this
  entry stable across upgrades even though the asset directory is
  version-stamped. Measured, not assumed: `probe/sandbox-glob.mjs` shows a
  wildcard-listed page getting the sandbox CSP and an unlisted one being
  refused `eval`.
- **`connect-src`** bounds what the worker may reach. `*` is right for a general
  anon-client; narrow it if you know your worker's destinations.
- **`web_accessible_resources` is not needed.** The sandboxed page is framed by
  an extension page rather than by a web page. (Established by removing it and
  watching the e2e still pass, not by reading.)
- **`iframeUrl` must stay same-origin.** §6 requires the harness to reject a
  cross-origin one, since it would let a third party choose what runs in the
  frame meant to contain the worker. Pass an extension-relative path; the
  harness resolves it against the extension's own origin.

A match pattern's host **may not carry a port** — `http://127.0.0.1:8545/*` is
invalid, and Chrome's response is to warn and drop the permission, after which
every fetch fails with a bare `Failed to fetch`. Use `http://127.0.0.1/*`, which
already matches every port.

## Use

In the service worker:

```ts
import { AnonRpcWorker } from "@anon-rpc/browser-extension-harness";

const worker = new AnonRpcWorker({
  address: "0x…",                            // the §4 specifier contract
  preExisting: { rpcProvider: yourProvider }, // an RPC connection you already have
});

await worker.ready; // optional; you can call fetch immediately

const res = await worker.fetch("https://rpc.example", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
});
```

`worker.fetch` is a standard `fetch`, this-bound, so it drops straight into
viem, ethers or anything else that takes one.

Do **not** construct it once at install time and expect it to live. Construct it
where you need it; the reuse above makes that cheap.

### If your extension already has an offscreen document

An extension may have exactly one. Rather than fighting over it, call
`mountOffscreenHost()` from yours and tell the harness not to create its own:

```ts
// in your existing offscreen document
import { mountOffscreenHost } from "@anon-rpc/browser-extension-harness/offscreen";
mountOffscreenHost();

// in the service worker
new AnonRpcWorker({ address, preExisting, offscreenUrl: false });
```

`mountOffscreenHost()` only claims ports named `anon-rpc.worker`, so it
coexists with whatever else that document does.

## Why an extension needs its own harness

§6 isolation is a Web Worker inside a **null-origin sandboxed iframe**. That
needs a DOM, and Manifest V3 replaced the background page with a service worker,
which does not have one. There is no `document` to append an iframe to.

MV3's answer is the **offscreen document**: a real extension page, with a DOM,
that a service worker can create and talk to. So the harness runs there, and the
service worker remotes to it:

```
service worker              offscreen document            sandboxed page          Web Worker
──────────────              ──────────────────            ──────────────          ──────────
AnonRpcWorker (§5)   ⟷      @anon-rpc/browser-harness  →  opaque origin      →    the bundle
your wallet's code          §4 verify, §7–§11              anon-rpc/<ver>/sandbox   (hash-pinned)
your RPC provider           the whole harness
      ↑                            │
      └──── provider calls ────────┘
```

The second change is the iframe itself. The harness normally builds it with
`srcdoc` and an inline bootstrap script, and inside an extension that script
never runs: a `srcdoc` frame inherits the embedder's Content Security Policy,
MV3's is `script-src 'self'`, and MV3 **refuses to load an extension** whose
policy tries to relax it. Since a policy can only be tightened from within a
document, the only document an extension can give the worker is a page listed
in `sandbox.pages`, which gets its own writable CSP. `WorkerInit.iframeUrl`
(SPEC §5) is how the harness is pointed at it. Both halves are measured in
`probe/csp.mjs` and `probe/relax-csp.mjs`.

Two further arrangements are chosen rather than incidental:

**The bundle is fetched and verified in the offscreen document**, and §4's
provider call is proxied back out to the service worker instead. That is
backwards from the obvious design, and it is because of serialisation.
Extension messaging serialises with **JSON** unless the extension opts in to
structured clone (`"message_serialization": "structured_clone"`, Chrome 148+),
and under JSON a `Uint8Array` does not throw — it silently arrives as
`{"0":72,"1":105}`. Every byte payload here is therefore base64 on the wire, and
the one large binary payload is kept off that wire entirely. A provider call is
a short JSON round trip; a bundle is not.

**Booted workers outlive the service worker that asked for them.** Chrome kills
an idle service worker after ~30 seconds, so an `AnonRpcWorker` held in a module
variable simply stops existing. If the worker's lifetime were tied to it, every
wakeup would re-read the specifier, re-fetch the bundle and re-verify the hash.
Instead the offscreen document keeps them, keyed by address + config, and hands
the same one back — so a reconnect costs a message. The e2e asserts this: a
second call performs no specifier read and no bundle fetch.

## Remotely hosted code, and why this is allowed

Chrome Web Store policy prohibits remotely hosted code in MV3 — all of an
extension's logic must be in the package. anon-rpc fetches an anon-client bundle
at runtime, which is exactly that.

The exception is the thing anon-rpc already does: **"remotely hosted code is
supported in sandboxed iframes"**
([Chrome's migration guide](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)).
§6 isolation is a sandboxed iframe, so a conforming anon-rpc harness lands
inside the carve-out by construction rather than by arrangement. The bundle is
also hash-pinned on-chain and verified before it runs (§4), which is a stronger
integrity claim than "it was in the zip file" — but that is an argument, and the
carve-out is the rule. Confirm current policy before you ship; policy moves
faster than specs do.

## What the worker can and cannot reach

The privilege boundary is the point of the whole arrangement, so the e2e
measures both sides of it in one run — the offscreen document fetching a bundle
from an endpoint that sends **no CORS headers** (it has host permissions), and
then the worker trying the same endpoint:

```
✓ the offscreen document fetched a bundle from a NO-CORS endpoint — it has host permissions
✓ worker code cannot reach the extension API (typeof chrome === "undefined")
✓ worker's own origin is "null" — not chrome-extension://<id>
✓ worker CANNOT reach the same no-CORS endpoint — it has none of the extension's host permissions
```

An extension is a high-privilege place to run someone else's code — host
permissions, cookies, `chrome.*` — and none of it reaches the worker.

## Running the tests

```sh
npm test
```

The codec has unit tests; everything else is a browser-extension mechanic with
no representation outside a browser, so the rest is an e2e that assembles
`example/` into a real unpacked extension and loads it into Chromium.

It needs the **full** Chromium build, not Playwright's default headless: that
default is the separate `chromium-headless-shell` binary, which has no extension
support, and an extension loaded into it is silently absent with no error — the
service worker simply never appears. The test passes `channel: "chromium"` for
this reason. CI installs it with `npx playwright install --with-deps chromium`.

`example/` is a complete, loadable extension. `chrome://extensions` →
Developer mode → Load unpacked, after assembling it the way `test/e2e.mjs` does.

## Status

Everything the browser harness implements, it implements — §4 verification, §5,
§7, §8, §9, §10's KPS bridge, §11 storage — because it *is* the browser harness,
one document over. What this package owns is the remoting, and that part is
deliberately incomplete in two ways:

- **Bodies are buffered, not streamed.** Extension messaging cannot carry a
  `ReadableStream`, so a §9 body is read to bytes before it crosses and base64'd.
  §9 permits this; a large response pays for it twice.
- **Base64 is unconditional.** Chrome 148's opt-in structured clone would let
  `Uint8Array` cross directly. It is not used, because doing so would make the
  wire format depend on a manifest key the integrator sets and on a Chrome
  version, and one code path that is always correct beats two that are usually.
