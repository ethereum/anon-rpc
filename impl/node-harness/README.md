# node-harness — anon-rpc for Node (prototype)

A second implementation of [SPEC.md](../../SPEC.md) §3.1, for Node instead of
the browser. The worker bundle runs inside a **QuickJS interpreter compiled to
WASM**, on a `worker_thread`; the §7 capability API it sees is the same one the
browser harness offers.

It boots the real passthrough worker from a specifier read, verifies the
bundle's `keccak256`, and answers `eth_blockNumber` through it. **Not yet a
conforming harness** — see [Status](#status).

```sh
npm run build
npm test                    # e2e: real bundle, isolated, answering RPC

node probe/qjs-probe.mjs    # what a bare isolate contains, and what it costs
node probe/qjs-escape.mjs   # the escape routes, one per line
node probe/qjs-isolate.mjs  # the guest's whole global, classified
node probe/qjs-stack.mjs 65536   # where the stack budget has to sit
```

Measured on Linux 6.8 aarch64, Node v22.20.0, quickjs-emscripten 0.32.0.
Nothing here is Linux-specific.

## The question this answered first

**Can a Node host confine an untrusted worker the way a browser does?**

This was answered twice, and the second answer replaced the first.

| | isolation strategy 1 | isolation strategy 2 (current) |
|---|---|---|
| boundary | Landlock + seccomp around a child process | the interpreter |
| worker runs in | `node:vm` context | QuickJS-WASM isolate |
| portability | Linux ≥ 5.13, per-platform Go binary | anywhere Node runs |
| guest's platform | ambient, confined after the fact | nothing; every capability granted |
| realm escape | **open** (`fn.constructor` reaches the host realm) | **closed** |
| CPU / memory limits | none | interrupt deadline + heap cap |
| `fetch` | a platform fact | a grant the host mediates |
| guest JS speed | V8 | interpreter, ~50× slower |

Strategy 1 works, and the findings that produced it are kept
[below](#the-superseded-kernel-strategy) — they are the reason strategy 2
exists. But two of its costs turned out to be structural rather than
incidental: it could only ever run on Linux, and the guest had an ambient
platform that could be *confined* but never *withheld*.

## The guest starts with nothing

A bare QuickJS context has the ECMAScript intrinsics and nothing else. Measured,
not assumed — `probe/qjs-probe.mjs` prints the list:

```
console  TextEncoder  URL  fetch  ReadableStream  AbortController
crypto   setTimeout   structuredClone  WebAssembly  require  process
  → all undefined
```

So the platform has to be built. The split is what matters:

- **`src/child/prelude.guest.js`** is evaluated inside the isolate and defines
  `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `AbortController`,
  `ReadableStream`, `WritableStream`, `Headers`, `Response`, `structuredClone`.
  All of it is pure computation — it encodes bytes, parses strings, queues
  chunks — so handing it over grants no authority and needs no policy decision.
- **Authority arrives through two functions**, `__host_send(method, json,
  bytes?)` and `__host_request(method, json, bytes?)`. That is the entire host
  interface. The prelude captures both in a closure and then **deletes them from
  the global object**, so guest code cannot reach the raw bridge — only the §7
  API assembled over it.

The e2e enumerates the guest's global and classifies every name, with nothing
left over:

```
✓ raw host bridge unreachable; 80 globals total, all accounted for
```

63 ECMAScript intrinsics, 12 pure-computation classes, and this many
authority-bearing names:

```
anonRpcWorker  console  crypto  setTimeout  clearTimeout
setInterval    clearInterval    fetch (only if granted)
```

That is the whole list, and it is a list rather than an audit. The previous
strategy could only ever answer "what can the ambient platform reach"; this one
answers "what exists".

## The realm escape is closed

`node:vm` is not a security boundary, and the previous harness's e2e proved it
rather than assuming it: the vm context is handed outer-realm functions, so
`fetch.constructor` **is** the outer realm's `Function`, and the `Function`
constructor compiles its body in the global scope of the realm it came from.
One call and worker code holds the real `process`.

That could not be fixed from inside. `'use strict'` does not help — it closes
stack-walking via `arguments.callee` and `Function.prototype.caller`, a
different family, and the real bundle was already strict because esbuild emits
it. Pruning the ambient globals does not help either, because
`anonRpcWorker.signalReady.constructor` is the same door, and §7's API *has* to
be host functions since it is the bridge.

A QuickJS isolate closes it structurally. A host function installed here is a
QuickJS function object backed by a C callback, not a foreign JS function, so
`fn.constructor` is the **guest's** `Function` and compiles in the guest's
global scope:

| | `node:vm` | QuickJS isolate |
|---|---|---|
| `fetch.constructor("return typeof process")()` | `"object"` | `"undefined"` |
| `anonRpcWorker.signalReady.constructor(…)` | `"object"` | `"undefined"` |
| `Object.getPrototypeOf(hostFn) === Function.prototype` | false (foreign) | **true (guest's own)** |
| `import("node:fs")` | needs no callback → denied | rejects: no module loader exists |

There is no shared object graph at all. Values cross as copies through the C
API — a string, a number, an `ArrayBuffer` — so there is nothing to walk.

## Resource limits, which `node:vm` has no usable form of

§6 is about blast radius, and a worker that simply never returns is part of
that. Landlock says nothing about it; `node:vm`'s `timeout` option does not
apply to async work and cannot stop a running promise chain. QuickJS can:

| hostile guest | result | how |
|---|---|---|
| `for(;;){}` | `interrupted` in ~800ms | interrupt handler against a wall-clock deadline |
| `(function f(){return f()})()` | `stack overflow` | QuickJS stack budget |
| `for(;;) a.push(new Uint8Array(1<<20))` | `out of memory` | runtime memory limit |
| `let s="x"; for(…) s+=s` | `string too long` | QuickJS internal cap |

Each surfaces to the host as a §12 worker failure, and the host keeps running.
The e2e asserts all four *in the host's own process*, so reaching the end of
the file is itself the assertion that none of them took it down.

After an `out of memory` the runtime is still usable — a guest cannot poison
the isolate by exhausting its heap.

### The sharp edge: the stack budget must sit under the WASM stack

QuickJS enforces its stack limit by comparing frame addresses against a budget.
Compiled to WASM that budget is measured against the **WASM** stack, which
emscripten fixes at 64KB when the variant is linked. A budget *larger* than the
WASM stack therefore never fires: the WASM stack goes first, V8 raises
`RangeError: Maximum call stack size exceeded` from inside the instance, and it
unwinds straight through whatever called in.

QuickJS's own default is 256KB. **So the default configuration lets a guest kill
its host with three lines of JavaScript.** Bisected in `probe/qjs-stack.mjs`:

| budget | plain recursion | recursion + alloc | `JSON.stringify` of a deep object |
|---|---|---|---|
| 256KB (default) | **host dies** | — | — |
| 80KB | caught | caught | **host dies** |
| 64KB | caught | caught | caught |

The third column is the one that fails first as the budget rises, because that
recursion happens in C inside QuickJS's serializer. This harness uses **48KB**
for margin, since three probed shapes are not proof of every shape.

The cost is guest recursion depth — about 276 frames at 48KB, 369 at 64KB.
That is shallow, and it is a published-variant limit: lifting it means building
a QuickJS variant with `-sSTACK_SIZE` raised, not tuning the number.

The `worker_thread` is the backstop underneath. Even if some shape escapes the
budget, it takes the thread down and the host sees a worker failure.

## How it fits together

```
host process (main thread)                  worker_thread
──────────────────────────                  ─────────────
AnonRpcWorker (§5)
  readSpecifier ──── bootstrap RPC
  fetchAndVerifyBundle ── resolver
  keccak256 == workerHash  ✓
  spawnIsolate ───────────────────────────▶ isolate-thread.js
  emit init { bundle bytes, config,          └─ QuickJS runtime
              capabilities, limits } ─────▶     ├─ memory cap, stack cap,
                                                │  interrupt deadline
                                                ├─ prelude.guest.js   (no authority)
                                                └─ the bundle         (untrusted)
  installFetchBridge  ◀── "fetch" ──────────  fetch(...)
  installSocketBridge ◀── "socket.connect" ─  anonRpcWorker.socket.connect(...)
  CallQueue (§8)      ◀── "call.accept" ────  acceptCall()
  fetch() ─────────────▶ queued
                      ◀── "call.respond" ───  call.respond(...)
```

Three things about that order are deliberate:

- **The bundle is verified before the isolate exists**, on the host, and is
  handed over as bytes rather than a path. There is no file for a third party to
  swap between the hash check and execution.
- **Only granted capabilities get a host half.** If `socket` is off, no
  `socket.connect` handler is installed *and* the guest has no
  `anonRpcWorker.socket` to call. There is nothing to filter because there is
  nothing to ask.
- **The thread is about liveness, not containment.** The sync QuickJS variant
  runs guest code on the calling thread, so in-process a guest could block the
  host's event loop for as long as its deadline allows. The isolate is the
  boundary either way.

## `fetch` is a capability here, not a platform

This is the substantive difference from both the browser harness and strategy 1.
In a Web Worker `fetch` is ambient; strategy 1 could only confine what it
reached. Here there is no `fetch` unless the host installs one — and when it
does, the host performs the request, so the address policy is a boundary rather
than a filter:

```
✓ granted fetch refused loopback, RFC1918 and file:// by policy (permission-denied)
```

The reference passthrough worker — which answers every call with a plain
`fetch`, the browser platform it was written against — runs **unmodified**
against that granted `fetch`. So the §3.2 conformance target still works, while
the host now sees every request it makes.

```ts
new AnonRpcWorker({ address })                                    // fetch on, socket off
new AnonRpcWorker({ address, capabilities: { socket: true },
                    network: { policy: { allow: ["10.0.0.0/8"] } } })
```

The default policy denies everything not globally routable — loopback, RFC1918,
CGNAT, link-local (which on a cloud box is the host's IAM identity, and so
arguably a §6 violation), ULA, multicast, and the IPv4-mapped forms of all of
them — with an explicit allow-list, because a wallet pointing its worker at a
node on localhost is a real deployment.

Both capabilities resolve the name first and check the **resolved** address:
checking a name and then connecting by name leaves a window in which the answer
can change, and the guest controls the name.

## The socket capability (PROPOSED — not in SPEC.md)

In a browser the worker cannot open raw TCP, which is why tor-js needs KPS
gateways to reach the Tor network: the demo gateway in
[adopters.json5](../../adopters.json5) exists only because of that limitation.
A Node harness can offer real sockets, so a native tor-js needs no gateway.

```
worker: anonRpcWorker.socket.connect("1.2.3.4", 9001)
  host:   resolve → address policy → net.connect
worker: { readable, writable }   ← chunks pulled one request at a time
```

`socket` is **absent**, not throwing, when not granted — the opposite of the
§10/§11 stubs. That difference is deliberate: a spec-mandated capability must
always exist so a worker gets a documented `unsupported` code, while an optional
one must be feature-testable, so `if (anonRpcWorker.socket)` answers truthfully
and tor-js can fall back to gateways. §3.2's warning applies in full: a worker
that requires this will not run in a browser.

**One thing got worse here.** Strategy 1 passed the connected *descriptor* to
the child over `SCM_RIGHTS` and then left the data path entirely — bytes went
child ↔ kernel ↔ network, and the harness structurally could not observe the
worker's traffic. A descriptor cannot move to a `worker_thread`, and a QuickJS
guest could not use one anyway, so bytes are relayed in chunks instead. For a
worker doing its own end-to-end encryption — which is the point of tor-js — the
host sees ciphertext, so what this costs is copies, not confidentiality. But it
is a real loss of a property strategy 1 had.

Backpressure survives: the guest pulls one chunk per request and nothing is read
from the peer until it asks, so the kernel's socket buffer still does the work.

## What this costs

- **Guest JS runs at interpreter speed.** QuickJS is roughly 50× slower than V8
  on compute. For RPC-shaped work — parse JSON, transform, respond — that is
  mostly irrelevant; for a worker doing its own cryptography in JS it is not.
  Host calls cross at ~470k/sec, so the boundary itself is not the bottleneck.
- **Guest recursion is capped near 276 frames** (see above).
- **Startup is ~4ms** for the WASM module (process-wide, reused) plus ~2ms per
  context.
- **`crypto.subtle` is absent**, deliberately, rather than stubbed — a worker
  needs to feature-detect it, not get something that lies.
- **The platform is a subset.** `ReadableStream` has no `tee` or `pipeThrough`;
  `Response` has no `clone` or `formData`. A correct small implementation beats
  a half-correct full one, but a worker relying on the rest will notice.
- **Handles are manually memory-managed**, and a leaked one makes QuickJS
  `abort()` the whole process at teardown. Not a slow leak — a crash. Every
  path in `isolate.ts` disposes.

## The superseded kernel strategy

Kept in the tree — `launcher/`, `src/host/confinement.ts`,
`src/child/worker-host.ts`, `probe/run.mjs` — because its findings are why the
current one exists. It is no longer reachable through the harness API.

**Node's permission model cannot be the boundary.** `node --permission` denies
`fs`, `child_process`, `worker_threads`, addons, WASI and FFI, which sounds
sufficient. Upstream says otherwise: *"This feature does not protect against
malicious code. […] Malicious code can bypass the permission model."* Measured:

| | reads `~/.ssh/id_ed25519`? |
|---|---|
| `--permission --allow-fs-read=/`, no Landlock | **yes — 411 bytes** |
| Landlock, `--permission --allow-fs-read=/` (runtime checks wide open) | no — `EACCES` |

The second row is the point: with Node's own checks disabled, the kernel still
refuses. Confinement cannot be applied from inside Node either — the Landlock
syscalls need FFI or a native addon, and `--permission` denies both — so
`launcher/` is a ~215-line Go binary that applies a deny-by-default ruleset to
itself and then `execve`s node. Go rather than Rust so `CGO_ENABLED=0` produces
one **static** binary per `GOOS`/`GOARCH`; a glibc-linked launcher will not run
on an alpine image.

**The minimal grant set**, derived by the ladder in `probe/run.mjs`:

```
--ro <node bin dir> --ro /lib --ro /usr/lib --ro /proc
--rw /dev/null --ro /dev/urandom --ro /etc/ssl
--ro /etc/resolv.conf --ro /run/systemd/resolve \
--ro /etc/hosts --ro /etc/nsswitch.conf --ro /etc/gai.conf
```

Two grants were not obvious: **`/etc/ssl`**, without which node *aborts on
startup* because OpenSSL `fopen`s `openssl.cnf` from C below the permission
model, giving no hint a sandbox is involved; and **`/run/systemd/resolve`**,
because `/etc/resolv.conf` is a symlink into `/run` and Landlock follows the
target, so granting all of `/etc` still leaves DNS broken with `EAI_AGAIN`.
`process.env` is covered by neither layer, so the child is spawned with
`env: {}` — in Node that is where a host keeps its keys, the direct analogue of
§6's private-key clause.

**Landlock's network rights are TCP-only from ABI 4 through 9**; UDP arrives at
ABI 10, which is Linux 7.2, so UDP being open is the normal case rather than a
rare degraded one. A seccomp filter closes that gap plus abstract unix sockets
(no path for a filesystem rule to match), and denies 23 syscalls the worker has
no business making. That group earns its keep only after a V8 or JIT bug — the
moment every JS-level check including `--permission` is worthless — and it was
added because a probe run *inside* the sandbox reached exactly what the same
probe reached outside it, with everything apparently denied actually being
denied by the distro's `ptrace_scope` and `perf_event_paranoid` sysctls rather
than by us.

**The two can be layered.** Running the QuickJS isolate inside the confined
process was measured to need **no additional grants** — WASM instantiation
touches nothing the seccomp filter denies, and the interpreter is inlined into
the built file as base64, so there is no `.wasm` to locate or grant. That makes
strategy 1 available as defence in depth on Linux rather than something the
current design has to replace. It is not wired into the harness API, because
"instead" was the point.

## Status

Working, and deliberately incomplete. What a §3.1 conforming harness still owes:

| §  | | |
|----|---|---|
| §4 | specifier read, resolver fetch, keccak verify | **done** (`kps:` entries ignored per §4.1) |
| §5 | `AnonRpcWorker`, `ready`, `fetch`, `close` | **done** |
| §6 | isolation | **done**, portable; no clause in the spec yet |
| §7 | `config`, `signalReady`/`signalFailed`, `log` | **done** |
| §8 | ordered, buffered, one-at-a-time calls | **done** (shares `CallQueue` with the browser harness) |
| §9 | fetch payloads | bodies **buffered**, not streamed — see below |
| §10 | KPS | **stubs** that throw `unsupported` (§12) |
| §11 | storage | **stubs** that throw `unsupported` (§12) |
| — | `socket` (proposed, not in the spec) | **done** — bridged, chunked |
| — | `fetch` as a grant | **done** — host-performed, policy-checked |

The two stubs are why this is not conforming: §3.1 requires a harness to
implement the semantics of every capability it exposes. They are exposed as
throwing stubs rather than omitted so that `anonRpcWorker` has the same shape on
both harnesses and a worker gets a documented code instead of a `TypeError` on
`undefined`.

### Not yet established

- **Streams for §9 bodies.** Only JSON and bytes cross into the isolate, so
  fetch bodies are buffered at whichever end holds them. The socket capability
  shows the way out — a chunk protocol with pull-driven backpressure — and a
  body could ride the same one. Not done.
- **KPS.** `@kpstreams`' transport depends on `node-datachannel`, a native
  addon, which a QuickJS guest could not load under any circumstances. So KPS
  stays host-side and is bridged, exactly as the browser harness bridges it —
  the §7 shape carries over unchanged, only the transport differs. The chunk
  protocol the socket capability already uses is the obvious mechanism.
- **`crypto.subtle`.** Absent today. Bridging it means deciding whether key
  material may live host-side on the guest's behalf, which is a §6 question and
  not only an API one.
- **A bigger WASM stack.** 276 guest frames is tight. Building a QuickJS variant
  with `-sSTACK_SIZE` raised would lift it, at the cost of owning the build and
  hash-pinning the `.wasm` — which a project premised on verifying delivered
  bytes should probably do anyway.
- **Guest CPU accounting.** The deadline is wall-clock per entry into the guest,
  which bounds a single runaway turn but not a guest that burns 90% of a core
  forever in short bursts. A budget across turns would.
- **The interpreter's own memory safety.** QuickJS is C. A bug in it gives an
  attacker the WASM linear memory — which is a sandboxed `ArrayBuffer`, so
  escaping *that* additionally needs a V8 WASM bug. That is a much better
  position than a V8 bug alone, but it is two bugs rather than none, and it is
  the honest statement of what this boundary is worth.
- **What a §6 clause for a native harness should say.** Per this repo's usual
  order, spec text waits until the implementation has taught us the wording. The
  open question is whether it names a mechanism, as the browser clause does, or
  states properties — "the worker's platform is exactly what the harness
  installs" is now a property a harness can actually be held to, which it was
  not when the answer was "confine the ambient one".
