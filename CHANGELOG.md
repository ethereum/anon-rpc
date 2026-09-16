# Specification changelog

Changes to [SPEC.md](SPEC.md) by specification version.

## 0.3.1 — 2026-09-16

- §5, §6: `WorkerInit.iframeUrl` — a host can tell a browser harness where to load the null-origin document from, instead of the harness constructing one inline. A `srcdoc` frame inherits the embedder's Content Security Policy and a policy can only be tightened from within a document, so an embedder whose policy omits `'unsafe-inline'` — an MV3 browser extension, or any site with a strict `script-src` — could not run the inline bootstrap at all. §6 requires the `sandbox` attribute regardless, requires same-origin, and states that the field grants the worker nothing. Additive: harnesses that do not use an iframe ignore it, and hosts that do not set it are unaffected.

## 0.3.0 — 2026-07-27

- §5, §7: `signalFailed(reason?)` — a worker can report that it cannot become ready (or has unrecoverably failed); `ready` rejection semantics specified (integrity failure, uncaught worker error, `signalFailed`), and a failed worker fails all pending and future calls. Breaking for harness implementers: `AnonRpcWorkerApi` gains a required method.

## 0.2.1 — 2026-07-27

- §4.2: content codings over kps resolvers — the request advertises what the harness's environment can decode (`Accept-Encoding`), a response may use exactly one advertised coding (`Content-Encoding`), and the body-size cap applies to the decoded bytes. The hash check always runs over the decoded bytes.

## 0.2.0 — 2026-07-24

- §4.1–4.2: `workerResolvers()` entries specified — `https:` URLs and kps resolver strings, with a self-contained GET-over-KPS exchange for the latter; unrecognized entries are ignored.
- §5, §7.1: hosts can pass `WorkerInit.config`, delivered to the worker as `anonRpcWorker.config` — structured-cloneable, opaque to the harness, fixed for the worker's lifetime.
- §10: tracks the KPS specification at version `^0.2.1`, which adds flow control to the WebRTC framing via a breaking wire change (0.1.x and 0.2.x peers do not interoperate). API surface: `KpsConn.remoteAddress` added; bracketed IPv6 address form documented.
- Non-normative design rationale moved from `draft-worker-api.md` (now removed) into Appendix A.

## 0.1.0 — 2026-06-24

- Initial draft.
