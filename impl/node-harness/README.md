# node-harness — anon-rpc for Node (prototype)

A second implementation of [SPEC.md](../../SPEC.md) §3.1, for Node instead of
the browser. The worker runs in a **Landlock-confined child process** rather
than a Web Worker inside a null-origin iframe; the §7 capability API it sees is
the same.

It boots the real passthrough worker from a specifier read, verifies the
bundle's `keccak256`, and answers `eth_blockNumber` through it. **Not yet a
conforming harness** — see [Status](#status).

```sh
npm run build:launcher    # Go toolchain; Linux only
npm run build
npm test                  # e2e: real bundle, confined, answering RPC

node probe/run.mjs        # the grant-set ladder that established the sandbox
node probe/run.mjs resolver
```

Measured on Linux 6.8 aarch64, Landlock ABI 4, Node v22.20.0.

## The question this answered first

**Can a Node host confine an untrusted worker the way a browser does?**
Yes — but the kernel has to do it, not Node.

## Why the Node permission model cannot be the boundary

`node --permission` denies `fs`, `child_process`, `worker_threads`, addons, WASI
and FFI, which sounds sufficient. It is not, and upstream says so plainly:

> This feature does not protect against malicious code. […] Malicious code can
> bypass the permission model and execute arbitrary code without the
> restrictions imposed by the permission model.

anon-rpc's whole premise is running untrusted code, so this is disqualifying for
the §6 boundary. Two measurements make it concrete:

| | reads `~/.ssh/id_ed25519`? |
|---|---|
| `--permission --allow-fs-read=/`, no Landlock | **yes — 411 bytes** |
| Landlock, `--permission --allow-fs-read=/` (runtime checks wide open) | no — `EACCES` |

The second row is the important one: with Node's own checks disabled, the kernel
still refuses. That is the boundary. `--permission` is kept as a cheap seat belt
that catches a *buggy* worker, and is never described as the sandbox.

Note also that the permission model gained no network dimension until Node
v25.0.0 (`--allow-net`), so on v22 it cannot restrict sockets at all. That is
fine here — §6 does not deny the worker network, and a worker whose job is to
reach an anonymizing network needs it.

## The vm context is not a boundary, and the e2e proves it

Worker code runs in a `node:vm` context with a curated set of globals — no
`require`, no `process`, no dynamic import. That is hygiene, not security, and
the test says so out loud rather than leaving it as a claim in a comment: the
harness hands the context outer-realm functions (`fetch`, `console`,
`setTimeout`), so `fetch.constructor` **is** the outer realm's `Function`, and
one call gets worker code the real `process` object. It works, today.

What stops it going further is everything below:

| after escaping to `process` | | |
|---|---|---|
| `process.binding("tcp_wrap")` → internals, raw sockets | `ERR_ACCESS_DENIED` | `--permission` |
| `import("node:net")` from outer-realm code | `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` | no host import callback |
| `process.env` | 0 variables | spawned with `env: {}` |
| filesystem, sockets, spawn | `EACCES` | Landlock + seccomp |

Note the first row: `--permission` is doing real work here, closing the main
route from `process` to internals. It is still a seat belt — upstream says it is
bypassable — but it is the layer that makes a vm escape uninteresting rather
than immediately fatal, which is worth knowing when deciding whether to keep it.

## The launcher

Confinement cannot be applied from inside Node: the Landlock syscalls need FFI
or a native addon, and `--permission` denies both. So `launcher/` is a ~190-line
Go binary that applies a deny-by-default ruleset to itself and then `execve`s
node. Landlock rules survive execve and cannot be revoked, so everything past
the exec inherits them irreversibly.

Go rather than Rust so that `CGO_ENABLED=0` produces one **static** binary per
`GOOS`/`GOARCH` from a single build machine. A glibc-linked launcher will not
run on an alpine-based image, which is exactly where this gets deployed; the
static one does, and cross-compiles to amd64 and arm64 with no extra toolchain.

Two properties make this fit anon-rpc's capability model well:

- **Landlock governs opening paths, not existing file descriptors.** The harness
  can open the IPC socket — and a socketpair per KPS stream — *before* spawning,
  and those keep working inside the sandbox while the filesystem is otherwise
  shut. Handed-in fds become the only authority: the same invariant the browser
  harness gets from a null-origin iframe, for the same reason.
- **It needs no privilege.** No root, no setuid, no namespaces, no daemon.

## Minimal grant set

```
--ro <node bin dir>        # execve + the loader reading the binary
--ro /lib --ro /usr/lib    # libc, libstdc++, NSS modules
--ro /proc                 # node reads /proc/self/*, meminfo, cpuinfo
--rw /dev/null --ro /dev/urandom
--ro /etc/ssl              # see below
--ro /etc/resolv.conf --ro /run/systemd/resolve \
--ro /etc/hosts --ro /etc/nsswitch.conf --ro /etc/gai.conf
```

Under it: entropy, DNS, TCP, a real TLS `fetch()` and ICU all work, while the
host's home directory, `/etc/passwd`, `spawn`, `worker_threads` and `dlopen` are
all denied. No blanket `/etc` and no blanket `/dev`.

Two grants were not obvious and are worth keeping deliberate:

- **`/etc/ssl`** — node *aborts on startup* without it, because OpenSSL `fopen`s
  `openssl.cnf` from C, below the permission model. Only Landlock can let that
  through, and the failure gives no hint that a sandbox is involved.
- **`/run/systemd/resolve`** — `/etc/resolv.conf` is a symlink into `/run` on
  systemd hosts and Landlock rules follow the target, so granting all of `/etc`
  still leaves DNS broken with `EAI_AGAIN`.

`process.env` is **not** covered by either layer; the child must be spawned with
`env: {}`. Node boots fine with zero variables. This matters more in Node than
in a browser, since env is where a host keeps its keys — the direct analogue of
the private-key clause in §6.

## How it fits together

```
host process                                confined child process
────────────                                ──────────────────────
AnonRpcWorker (§5)
  readSpecifier ──── bootstrap RPC
  fetchAndVerifyBundle ── resolver
  keccak256 == workerHash  ✓
  spawnWorkerProcess ─────────────────────▶ launcher: landlock, no_new_privs
                                            └─ execve node --permission
  await confined ◀──── "fully enforced" ─── worker-host.js
  emit init { bundle bytes, config } ─────▶   vm context + anonRpcWorker (§7)
                                              └─ runs the bundle
  CallQueue (§8) ◀──── call.accept ─────────  acceptCall()
  fetch() ─────────────▶ queued
                    ◀── call.respond ──────  call.respond(...)
```

Three things about that order are deliberate:

- **The bundle is verified before any sandbox exists**, on the host, and is
  handed over as bytes rather than a path. There is no file for a third party
  to swap between the hash check and execution, and the sandbox needs no
  filesystem grant for it.
- **Nothing is delivered until the kernel confirms enforcement.** The harness
  awaits the launcher's one-line status before sending `init`, so untrusted
  code never reaches a process whose confinement is unproven. Partial
  enforcement is a hard error, not a log line.
- **The environment is empty.** Neither Landlock nor `--permission` covers
  `process.env`, and in Node that is where a host keeps its keys.

## Consequences for the harness design

1. **KPS cannot live inside the sandbox.** `@kpstreams`' transport depends on
   `node-datachannel`, a native addon, and `--permission` denies `dlopen`
   (`ERR_DLOPEN_DISABLED`) — as does any serious sandbox. So KPS stays
   host-side and is bridged across the boundary, exactly as the browser harness
   bridges it. The §7 capability API shape carries over unchanged; only the
   transport under it differs.
2. **The bundle need not touch the filesystem.** The harness already fetches and
   hash-verifies worker bytes, so it can hand them over the IPC channel instead
   of writing a file. That drops the `bundle dir` grant and leaves only node's
   own runtime needs.
3. **Landlock says nothing about resource exhaustion.** A worker that allocates
   until the box dies is unaddressed. That is a separate axis — cgroups, most
   cheaply via `systemd-run --user -p MemoryMax= -p CPUQuota=` — and not a
   substitute for or successor to Landlock. `resourceLimits` is
   `worker_threads`-only and so unavailable to a child process.
4. **Confinement should be a pluggable strategy**, with the harness declining to
   claim §6 unless a kernel-enforcing one is active. Hosts without Landlock
   (kernels below 5.13, non-Linux) then get an explicit unconfined mode rather
   than a silent downgrade. macOS would need `sandbox-exec`; Windows realistically
   a container.

## The socket capability (PROPOSED — not in SPEC.md)

In a browser the worker cannot open raw TCP, which is why tor-js needs KPS
gateways to reach the Tor network: the demo gateway in
[adopters.json5](../../adopters.json5) exists only because of that limitation.
A Node harness *can* offer real sockets — but handing the worker ambient ones
also hands it the host's loopback and LAN, and `169.254.169.254`, which on a
cloud box is the host's IAM identity and so arguably a §6 violation.

So the worker gets no sockets of its own and asks the host instead:

```
worker: anonRpcWorker.socket.connect("1.2.3.4", 9001)
  host:   resolve → address policy → net.connect → pass the descriptor
worker: { readable, writable }  ← bytes flow child ↔ kernel ↔ network
```

`--restrict-net` is on by default, so the child's own `connect()` returns
`EACCES` from the kernel. Two properties make this work:

- **Landlock governs *opening*, not existing descriptors.** A socket passed in
  over IPC keeps working while every dial is denied. The descriptor is the
  capability, in the literal OS sense — the same invariant the browser harness
  gets from a null-origin iframe.
- **The host is on the control path, not the data path.** Node closes the
  sender's copy on send, so the handoff is a transfer of ownership: after it,
  the harness structurally cannot observe the worker's traffic. No bytes cross
  the RPC channel, and the backpressure is the kernel's socket buffer rather
  than flow control of ours.

The address policy runs **host-side**, which is the only reason it is worth
writing: the same check inside the child would be a seat belt, since `node:vm`
is not a security boundary. It denies everything not globally routable by
default — loopback, RFC1918, CGNAT, link-local, ULA, multicast, and the
IPv4-mapped forms of all of them — with an explicit allow-list, because a
wallet pointing its worker at a node on localhost is a real deployment.

`socket` is **absent**, not throwing, when unavailable — the opposite of the
§10/§11 stubs. That difference is deliberate: a spec-mandated capability must
always exist so a worker gets a documented `unsupported` code, while an
optional one must be feature-testable, so `if (anonRpcWorker.socket)` answers
truthfully and tor-js can fall back to gateways. §3.2's warning applies in
full: a worker that requires this will not run in a browser.

**This is why `network.ambient` exists.** The reference passthrough worker
answers calls with a plain `fetch` — the browser platform it was written
against — and cannot run with the child's sockets denied. The host therefore
says which kind of worker it is deploying:

```ts
new AnonRpcWorker({ address, network: { ambient: true } })                  // browser-style worker
new AnonRpcWorker({ address, network: { policy: { allow: ["10.0.0.0/8"] } } }) // bridged (default)
```

### What "no ambient network" covers, and which layer does it

Landlock's network rights are **TCP-only from ABI 4 through 9**; ABI 10 adds UDP
bind and connect/send, and ABI 10 is **Linux 7.2**. Ubuntu 24.04 LTS ships 6.8
and its HWE kernel is 7.0, so ABI 10 is out of reach for most deployments for a
while yet: UDP being open is the *normal* case, not a rare degraded one.

So the two layers split the job:

| | mechanism | why that one |
|---|---|---|
| TCP connect/bind | Landlock | address-independent, kernel-enforced, cheap |
| UDP socket creation | seccomp | Landlock cannot, below ABI 10 |
| *which* address | host-side policy | neither can: seccomp cannot dereference the `sockaddr` pointer `connect()` takes, and Landlock net rules match ports, not addresses |

The seccomp filter denies `socket(AF_INET|AF_INET6, SOCK_DGRAM, …)`. That *is*
expressible in BPF — three scalar arguments — unlike the address check, and it
is stricter than Landlock's ABI 10 rights, which govern bind and connect rather
than creation. It leaves `AF_UNIX` datagrams alone, so nothing in node breaks.

The launcher asks for the **best ABI the kernel supports** rather than pinning a
version (pinning V4 would leave UDP to Landlock on kernels that could close it)
and reports what it actually enforced:

```
anon-rpc-launch: landlock fully enforced (abi 4, fs, net: tcp+udp)
```

ABI 4 is the floor — below it there are no network rights at all, and the
launcher refuses to start rather than pretend. In the bridged posture the child
also gets **no resolver grants** (`resolv.conf`, `nsswitch.conf`, `gai.conf`,
`hosts`): the host resolves names, and a process with no UDP socket could not
ask anyway. A sandbox should not carry grants for a capability its process
does not have.

**Abstract unix sockets** are closed the same way. Landlock cannot reach them
below ABI 6 (scoping) because they have no path for a filesystem rule to match
— measured: a connect to an abstract name returned `ECONNREFUSED`, meaning the
socket was created and the attempt made. Path-bound unix sockets were never
exposed: `/run/systemd/private` returned `EACCES` from Landlock, since reaching
one needs a path and the path is not granted.

So the filter denies `socket(AF_UNIX, …)` outright in the bridged posture. The
child never legitimately creates a socket of any kind — its IPC channel is an
inherited descriptor, and a bridged socket is *received* on that channel rather
than created — which the e2e confirms by still passing fd-handoff tests with
creation denied.

Untested: the **ABI ≥ 5 paths**. This kernel reports 4, so the higher presets
are selected by code that has never run, and each raises the filesystem rights
handled too (truncate at 3, ioctl_dev at 5), which could deny something node
needs at startup. Worth running the grant ladder on a newer kernel first.

## Status

Working, and deliberately incomplete. What a §3.1 conforming harness still owes:

| §  | | |
|----|---|---|
| §4 | specifier read, resolver fetch, keccak verify | **done** (`kps:` entries ignored per §4.1) |
| §5 | `AnonRpcWorker`, `ready`, `fetch`, `close` | **done** |
| §6 | isolation | **done** for Linux + Landlock; no clause in the spec yet |
| §7 | `config`, `signalReady`/`signalFailed`, `log` | **done** |
| §8 | ordered, buffered, one-at-a-time calls | **done** (shares `CallQueue` with the browser harness) |
| §9 | fetch payloads | bodies **buffered**, not streamed — see below |
| §10 | KPS | **stubs** that throw `unsupported` (§12) |
| §11 | storage | **stubs** that throw `unsupported` (§12) |
| — | `socket` (proposed, not in the spec) | **done** — bridged over fd-passing |

The two stubs are why this is not conforming: §3.1 requires a harness to
implement the semantics of every capability it exposes. They are exposed as
throwing stubs rather than omitted so that `anonRpcWorker` has the same shape
on both harnesses and a worker gets a documented code instead of a
`TypeError` on `undefined`.

### Not yet established

- **Streams for §9 bodies.** Node's IPC cannot transfer a `ReadableStream`, so
  fetch bodies are still buffered at whichever end holds them. The socket
  capability shows the way out: a descriptor crosses fine and carries its own
  backpressure, so a body could ride a socketpair the same way. Not done.
- **KPS over the same mechanism.** A KPS stream is a userspace object inside the
  host, so there is no descriptor to pass — but the host can make a
  `socketpair`, pass one end, and pump. The child would then wrap a descriptor
  into `{ readable, writable }` for both capabilities, with one code path and
  kernel backpressure either way. The asymmetry is that for KPS the host stays
  on the data path and cannot not.
- **`RLIMIT_NOFILE`.** Every bridged socket is a descriptor in both processes,
  and Tor is not shy about connections. There is a `maxConcurrent` cap
  (default 256) returning §12 `queue-full`, but the right number should come
  from measuring what tor-js actually opens.
- **`--permission` on Node ≥ 25.** v22 has no network permission, so the seat
  belt is inert here. On 25+, with `--allow-net` absent, whether operations on a
  *passed-in* descriptor are denied is untested — the permission model gates the
  `net` binding, not the fd. If it denies them, the seat belt fights the design.
- **More seccomp.** The filter today denies exactly one thing (IP datagram
  sockets). Landlock does not filter syscalls such as `ptrace`, and a
  general-purpose allow-list would be the next hardening — bearing in mind
  that an over-tight filter breaks node in ways that surface as mysterious
  startup crashes.
- **Packaging.** Per-platform `optionalDependencies` (`@anon-rpc/launch-linux-x64`
  and friends) so no postinstall script or install-time network is needed, plus
  hash-pinning the launcher itself — a project premised on verifying delivered
  bytes should not ask anyone to trust an opaque binary from a registry.
- **What a §6 clause for a native harness should say.** Per this repo's usual
  order, spec text waits until the implementation has taught us the wording.
  The open question is whether it names a mechanism, as the browser clause
  does, or states properties and leaves the mechanism to the harness.
