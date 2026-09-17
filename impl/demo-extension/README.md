# demo-extension

The site's balance-watcher demo, packaged as an MV3 browser extension. It is
the worked example for
[`@anon-rpc/browser-extension-harness`](../browser-extension-harness) — the
install step that package's README describes, actually carried out — and the
archive the [demo page](https://ethereum.github.io/anon-rpc/demo/) offers for
download.

Not published to npm and not in any store. It is a demo of the standard.

```sh
npm run build   # dist/unpacked/ and dist/anon-rpc-demo-extension.zip
npm test        # loads dist/unpacked/ into Chromium and drives the popup
```

To try it: `chrome://extensions` → Developer mode → **Load unpacked** →
`dist/unpacked`. (A `.zip` cannot be loaded directly; the archive exists for
the download link, and whoever downloads it unzips first.)

## Where the code lives, and why

An MV3 extension has three contexts and this demo uses all three, because the
harness's design forces it to:

| | holds | why it has to be there |
|---|---|---|
| `src/background.ts` | the `AnonRpcWorker`, the bootstrap RPC provider, every anonymized call | a service worker is the only context that survives the popup closing |
| `src/popup.ts` | the UI, the poll timer, nothing else | a popup is destroyed the moment it loses focus |
| the offscreen document | the harness, the null-origin sandbox, the worker | a service worker has no DOM to put an iframe in |

That is not an arbitrary split. A watcher living in the popup would die with
it; a worker tied to the service worker's lifetime would be re-verified every
time Chrome woke the extension up. The offscreen document outlives both, so the
booted worker does too.

### Cold and warm boots, honestly reported

The popup's footer says which kind of boot it just did, and it is not guessed
from a timing threshold. §4's specifier read goes through the RPC provider in
`background.ts`, so that provider being called *is* the observation:

```
cold boot in 88 ms — specifier read, bundle fetched, keccak256 verified
warm boot in 1 ms — reattached to the worker already running offscreen
```

The test asserts both, and asserts that reopening the popup performs no
specifier read and no bundle fetch at all.

## The manifest

`manifest.json` here carries `//`-prefixed keys explaining each entry; the build
strips them, because Chrome warns about unrecognised keys and the explanations
are for readers of this repo. See the harness's README for what each one is for
and which of them fail silently when wrong.

Two entries are wider than a real wallet's would be:

- **`host_permissions: ["http://*/*", "https://*/*"]`** — the demo lets you
  point it at any RPC endpoint and any specifier, so the offscreen document may
  need to fetch a bundle from anywhere. A wallet would list its own endpoints.
  Note this is for the *bundle* fetch: the worker's own requests run at a null
  origin and are subject to CORS like any web page's.
- **`connect-src *`** in the sandbox CSP, for the same reason.

## The archive

`zip.mjs` is a ~90-line ZIP writer over `node:zlib` rather than a dependency —
the only non-bookkeeping parts of the format are `crc32` and `deflateRaw`, both
of which Node already has. It writes a fixed timestamp and no extra fields, so
the same inputs produce byte-identical output; the site serves this file, and an
archive whose bytes churned on every build would be a spurious diff in every
deploy. The test asserts that stability, and validates the archive by parsing
its central directory rather than shelling out to `unzip`.
