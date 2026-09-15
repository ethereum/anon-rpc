// End-to-end: the REAL passthrough worker bundle, hash-verified from a
// specifier read, running inside a Landlock-confined child process, answering
// a JSON-RPC request through the harness's anonymized fetch.
//
// Hermetic and chain-free. §5 takes the bootstrap provider as an injectable
// dependency, so the specifier read is stubbed with the ABI encoding a real
// contract would return — which exercises the same decode path as mainnet
// without needing anvil. The bundle bytes, the keccak256 check, the sandbox and
// the capability API are all the real thing.
//
// Skips (rather than fails) where the platform cannot run it, except in CI.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, "..");
const IMPL = resolve(HARNESS, "..");
const BUNDLE = resolve(HARNESS, "../passthrough-worker/dist/passthrough-worker.js");
const LAUNCHER = resolve(HARNESS, "launcher/anon-rpc-launch");

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch {} });
process.on("exit", cleanup);
const fail = (m) => { console.error("❌ " + m); cleanup(); process.exit(1); };
const ok = (m) => console.log("  ✓ " + m);
const skip = (m) => {
  // In CI a skip would hide a broken build as green.
  if (process.env.CI) fail(`${m} (required in CI)`);
  console.log(`⚠ ${m} — skipping node-harness e2e`);
  process.exit(0);
};

if (process.platform !== "linux") skip(`confinement is Linux-only for now (this is ${process.platform})`);
// The launcher needs a Go toolchain, so it is not built by `npm run build`;
// without it there is no sandbox and nothing here is worth asserting.
if (!existsSync(LAUNCHER)) skip("launcher not built (`npm run build:launcher`, needs Go)");

// Fresh build of the harness and of the worker bundle this pins by hash — the
// test must run against the artifacts, not against whatever dist/ held before.
await new Promise((res, rej) => {
  const p = spawn("npm", ["run", "build", "--workspaces", "--if-present"], { cwd: IMPL, stdio: "ignore" });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error("build failed"))));
});
if (!existsSync(BUNDLE)) fail(`passthrough worker bundle missing after build: ${BUNDLE}`);

const { AnonRpcWorker } = await import(resolve(HARNESS, "dist/host.js"));

/* --- the specifier, as the chain would answer it ------------------------- */

const bundle = await readFile(BUNDLE);
const workerHash = "0x" + Buffer.from(keccak_256(bundle)).toString("hex");
const SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";

const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
const word = (n) => pad(n.toString(16));
/** ABI-encode `string[]` exactly as a conforming workerResolvers() returns it. */
function encodeStringArray(strings) {
  const head = word(32) + word(strings.length);
  let offsets = "";
  let bodies = "";
  let cursor = strings.length * 32;
  for (const s of strings) {
    offsets += word(cursor);
    const bytes = Buffer.from(s, "utf8");
    const padded = Math.ceil(bytes.length / 32) * 32;
    bodies += word(bytes.length) + bytes.toString("hex").padEnd(padded * 2, "0");
    cursor += 32 + padded;
  }
  return "0x" + head + offsets + bodies;
}

const selector = (sig) => "0x" + Buffer.from(keccak_256(Buffer.from(sig))).toString("hex").slice(0, 8);
const SEL_HASH = selector("workerHash()");
const SEL_RESOLVERS = selector("workerResolvers()");

/* --- a resolver serving the pinned bytes -------------------------------- */

let served = 0;
const resolver = createServer((_q, res) => {
  served++;
  res.writeHead(200, { "content-type": "text/javascript" });
  res.end(bundle);
});
await new Promise((r) => resolver.listen(0, "127.0.0.1", r));
cleanups.push(() => resolver.close());
const resolverUrl = `http://127.0.0.1:${resolver.address().port}/worker.js`;

/* --- an "ethereum node" for the worker to reach through the sandbox ----- */

let workerRpcCalls = 0;
const chain = createServer((req, res) => {
  workerRpcCalls++;
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { id, method } = JSON.parse(body);
    const result = method === "eth_blockNumber" ? "0x1312d00" : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});
await new Promise((r) => chain.listen(0, "127.0.0.1", r));
cleanups.push(() => chain.close());
const chainUrl = `http://127.0.0.1:${chain.address().port}/`;

/* --- the bootstrap provider (§4: used once, host-side, not anonymized) -- */

let specifierReads = 0;
const makeProvider = (hash) => ({
  async request({ method, params }) {
    if (method !== "eth_call") throw new Error(`unexpected bootstrap call: ${method}`);
    specifierReads++;
    const data = params[0].data;
    if (data === SEL_HASH) return "0x" + pad(hash);
    if (data === SEL_RESOLVERS) return encodeStringArray([resolverUrl]);
    throw new Error(`unexpected selector: ${data}`);
  },
});

/* --- 1. the happy path -------------------------------------------------- */

// `network.ambient` because the passthrough worker answers calls with a plain
// `fetch` — the browser platform it was written against. Without it the child
// has no sockets of its own and this worker cannot reach anything; that is the
// default, and the socket-capability test below is the other half of the story.
const worker = new AnonRpcWorker({
  address: SPECIFIER,
  preExisting: { rpcProvider: makeProvider(workerHash) },
  network: { ambient: true },
});
cleanups.push(() => worker.close());

await worker.ready;
ok("worker booted: specifier read, bundle keccak-verified, running confined");
if (specifierReads !== 2) fail(`expected 2 specifier reads, got ${specifierReads}`);
if (served !== 1) fail(`expected the resolver to be hit once, got ${served}`);

// A call issued through the sandbox, out to a server only the worker touches.
const res = await worker.fetch(chainUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
});
if (res.status !== 200) fail(`worker fetch returned ${res.status}`);
const { result } = await res.json();
if (result !== "0x1312d00") fail(`unexpected RPC result: ${result}`);
if (workerRpcCalls !== 1) fail(`expected 1 call to reach the chain, got ${workerRpcCalls}`);
ok(`eth_blockNumber answered through the confined worker (${result})`);

// Buffered, ordered delivery (§8): several calls in flight at once.
const many = await Promise.all(
  [1, 2, 3, 4, 5].map((i) =>
    worker
      .fetch(chainUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_blockNumber", params: [] }),
      })
      .then((r) => r.json()),
  ),
);
if (many.some((m) => m.result !== "0x1312d00")) fail("a concurrent call came back wrong");
if (new Set(many.map((m) => m.id)).size !== 5) fail(`ids were not correlated: ${many.map((m) => m.id)}`);
ok("five concurrent calls each got their own response (§8 correlation)");

/* --- 2. §12: a closed worker fails its calls ---------------------------- */

worker.close();
let closedErr;
await worker.fetch(chainUrl).catch((e) => (closedErr = e));
if (!closedErr) fail("fetch after close() resolved");
ok(`fetch after close() rejects (${closedErr.message})`);

/* --- 3. §4: bytes that do not match the pinned hash never run ---------- */

const wrongHash = "0x" + "11".repeat(32);
const tampered = new AnonRpcWorker({
  address: SPECIFIER,
  preExisting: { rpcProvider: makeProvider(wrongHash) },
  network: { ambient: true },
});
let hashErr;
await tampered.ready.catch((e) => (hashErr = e));
tampered.close();
if (!hashErr) fail("a bundle whose hash does not match the specifier was accepted");
if (!/hash mismatch/.test(hashErr.message)) fail(`expected a hash-mismatch error, got: ${hashErr.message}`);
ok("bundle rejected when keccak256 does not match workerHash (§4)");

/* --- 4. the sandbox is real: the worker cannot read the host's files ---- */

// A worker that tries what a hostile one would. Same boot path, different
// bundle — so this asserts the boundary, not the passthrough worker's manners.
const hostile = `
(async () => {
  const out = { fs: "?", spawn: "?", env: Object.keys(globalThis.process?.env ?? {}).length };
  try { const fs = await import("node:fs"); fs.readFileSync(${JSON.stringify(process.env.HOME + "/.ssh/id_ed25519")}); out.fs = "READ IT"; }
  catch (e) { out.fs = e.code ?? e.message; }
  try { const cp = await import("node:child_process"); cp.execSync("id"); out.spawn = "RAN IT"; }
  catch (e) { out.spawn = e.code ?? e.message; }
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`;
const hostileBytes = Buffer.from(hostile, "utf8");
const hostileHash = "0x" + Buffer.from(keccak_256(hostileBytes)).toString("hex");
const hostileResolver = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/javascript" });
  res.end(hostileBytes);
});
await new Promise((r) => hostileResolver.listen(0, "127.0.0.1", r));
cleanups.push(() => hostileResolver.close());
const hostileUrl = `http://127.0.0.1:${hostileResolver.address().port}/w.js`;

const probe = new AnonRpcWorker({
  address: SPECIFIER,
  network: { ambient: true },
  preExisting: {
    rpcProvider: {
      async request({ method, params }) {
        if (method !== "eth_call") throw new Error("unexpected");
        const data = params[0].data;
        if (data === SEL_HASH) return "0x" + pad(hostileHash);
        if (data === SEL_RESOLVERS) return encodeStringArray([hostileUrl]);
        throw new Error("unexpected selector");
      },
    },
  },
});
cleanups.push(() => probe.close());
await probe.ready;
const report = await (await probe.fetch("http://example.invalid/")).json();
probe.close();

if (report.fs === "READ IT") fail(`the worker read the host's private key: ${JSON.stringify(report)}`);
if (report.spawn === "RAN IT") fail(`the worker spawned a process: ${JSON.stringify(report)}`);
if (report.env !== 0) fail(`the worker saw ${report.env} environment variables, want 0`);
// Which layer refused matters for what this proves. Worker code cannot reach
// node's builtins at all (no `process`, no dynamic import in its vm context),
// so it is stopped before `--permission` or Landlock is consulted. That is the
// strongest outcome, but it means THIS test does not exercise the kernel —
// probe/run.mjs is the test that does, by running a probe with full node
// access as the child's own script and confirming the kernel denies it.
ok(`worker cannot reach node builtins: fs ${report.fs}, spawn ${report.spawn}, env 0 vars`);
ok("(kernel-layer denial is covered separately by probe/run.mjs)");

/* --- 5. the bridged socket capability (PROPOSED, not in SPEC.md) -------- */

// A plain TCP peer, not the JSON-RPC server above: the point of this capability
// is raw bytes, which is what a native tor-js needs in order to talk to relays
// without a KPS gateway.
const { createServer: createTcpServer } = await import("node:net");
let tcpConns = 0;
const tcp = createTcpServer((c) => {
  tcpConns++;
  c.on("data", () => c.end("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello"));
  c.on("error", () => {});
});
await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
cleanups.push(() => tcp.close());
const TCP_PORT = tcp.address().port;

// A worker in the default posture: no sockets of its own (landlock denies every
// TCP connect), reaching the network only through `anonRpcWorker.socket`. This
// is the shape a native tor-js would use to skip the KPS gateway.
//
// It reports what it found so the assertions below can tell the two failure
// modes apart: a capability that is missing, versus one that is refused.
const socketWorker = `
(async () => {
  const out = { hasSocket: !!anonRpcWorker.socket, ownDial: "?", bridged: "?", denied: "?" };

  // 1. Can it dial for itself? It should not even have the means to try.
  try { const net = await import("node:net"); net.connect(80, "127.0.0.1"); out.ownDial = "REACHED node:net"; }
  catch (e) { out.ownDial = e.code ?? e.message; }

  // 2. The bridged capability, against the allow-listed chain.
  try {
    const s = await anonRpcWorker.socket.connect(${JSON.stringify("127.0.0.1")}, CHAIN_PORT);
    const w = s.writable.getWriter();
    await w.write(new TextEncoder().encode("GET / HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n"));
    await w.close();
    const r = s.readable.getReader();
    let text = "";
    for (;;) { const { value, done } = await r.read(); if (done) break; text += new TextDecoder().decode(value); }
    out.bridged = text.split("\\r\\n")[0];
    out.remote = s.remoteAddress.port === CHAIN_PORT ? "port matches" : "port mismatch";
  } catch (e) { out.bridged = "ERROR " + (e.code ?? e.message); }

  // 3. A destination the policy does not allow.
  try { await anonRpcWorker.socket.connect("10.1.2.3", 80); out.denied = "ALLOWED"; }
  catch (e) { out.denied = e.code ?? e.message; }

  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`.replace(/CHAIN_PORT/g, String(TCP_PORT));

const sockBytes = Buffer.from(socketWorker, "utf8");
const sockHash = "0x" + Buffer.from(keccak_256(sockBytes)).toString("hex");
const sockResolver = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/javascript" });
  res.end(sockBytes);
});
await new Promise((r) => sockResolver.listen(0, "127.0.0.1", r));
cleanups.push(() => sockResolver.close());
const sockUrl = `http://127.0.0.1:${sockResolver.address().port}/w.js`;

const socketed = new AnonRpcWorker({
  address: SPECIFIER,
  // The default posture — no `ambient` — plus an allow-list for the local
  // chain. Loopback is denied by default, and a wallet pointing its worker at
  // a node on localhost is exactly why the escape hatch exists.
  network: { policy: { allow: ["127.0.0.1/32"] } },
  preExisting: {
    rpcProvider: {
      async request({ method, params }) {
        if (method !== "eth_call") throw new Error("unexpected");
        const data = params[0].data;
        if (data === SEL_HASH) return "0x" + pad(sockHash);
        if (data === SEL_RESOLVERS) return encodeStringArray([sockUrl]);
        throw new Error("unexpected selector");
      },
    },
  },
});
cleanups.push(() => socketed.close());
await socketed.ready;
const sock = await (await socketed.fetch("http://example.invalid/")).json();
socketed.close();

if (!sock.hasSocket) fail("anonRpcWorker.socket was absent when the harness granted it");
if (sock.ownDial === "REACHED node:net") fail(`the worker reached node:net: ${JSON.stringify(sock)}`);
if (!/^HTTP\/1\.1 /.test(sock.bridged)) fail(`bridged socket did not carry HTTP: ${JSON.stringify(sock)}`);
if (sock.remote !== "port matches") fail(`remoteAddress wrong: ${JSON.stringify(sock)}`);
if (sock.denied !== "permission-denied") fail(`policy did not refuse 10.1.2.3: ${JSON.stringify(sock)}`);
ok(`bridged socket carried a real connection ("${sock.bridged}") with no sockets of the worker's own`);
ok(`address policy refused a non-allow-listed destination (${sock.denied})`);

// The kernel layer under it: the same child, asked directly. This is what
// proves the sandbox rather than the vm context — probe/run.mjs runs the full
// ladder, this asserts the one property the capability depends on.
{
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    LAUNCHER,
    [
      "--ro", dirname(process.execPath), "--ro", "/lib", "--ro", "/usr/lib", "--ro", "/proc",
      "--rw", "/dev/null", "--ro", "/dev/urandom", "--ro", "/etc/ssl", "--restrict-net", "--no-udp", "--no-unix",
      "--", process.execPath, "--permission", "-e",
      `const n=require("node:net");const s=n.connect(${chain.address().port},"127.0.0.1");` +
        `s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});` +
        `s.on("error",e=>{console.log(e.code);process.exit(0)});`,
    ],
    { encoding: "utf8", timeout: 20_000, env: {} },
  );
  const verdict = (r.stdout ?? "").trim();
  if (verdict !== "EACCES") {
    fail(`--restrict-net did not deny a direct dial from the child (got ${verdict || r.stderr})`);
  }

  // The launcher asks for the best ABI the kernel offers and says what it got.
  // Asserting the shape catches a regression to a pinned version, which would
  // silently leave UDP open on kernels that can close it (ABI 10+).
  const posture = (r.stderr ?? "").match(
    /landlock fully enforced \(abi (\d+), fs, net: ([^,)]+), syscalls: (\d+) denied\)/,
  );
  if (!posture) fail(`launcher did not report its enforcement posture: ${r.stderr}`);
  const [, abi, net, denied] = posture;
  // The syscall deny-list is the layer that matters after a V8 or JIT bug,
  // when every JS-level check including --permission is worthless. Asserting
  // it is non-empty catches a launcher that silently stopped installing it.
  if (Number(denied) < 20) fail(`only ${denied} syscalls denied; the deny-list looks truncated`);
  if (Number(abi) < 4) fail(`launcher accepted landlock abi ${abi}, below the floor of 4`);
  // seccomp closes the UDP gap that landlock leaves below abi 10, so the
  // posture is the same on every supported kernel.
  const wantNet = "tcp+udp";
  if (net !== wantNet) fail(`abi ${abi} should deny ${wantNet}, reported ${net}`);
  ok(`landlock denies the child's own TCP connect (EACCES) at abi ${abi}, net: ${net}, ${denied} syscalls denied`);
}

/* --- 6. a worker that escapes the vm context, which it can --------------- */

// `node:vm` is not a security boundary and this proves it rather than assuming
// it: the harness hands the context outer-realm functions (fetch, console,
// setTimeout), and `fetch.constructor` is therefore the OUTER realm's Function
// constructor. One call and worker code holds the real `process`.
//
// That is fine, and is the whole reason the sandbox is a process and a kernel
// ruleset rather than a vm context. This case asserts that the layers which do
// matter still hold for a worker that has escaped: no internal bindings, no
// environment, no sockets.
const escapee = `
(async () => {
  const out = {};
  try {
    const F = fetch.constructor;          // outer-realm Function
    const proc = F("return process")();
    out.reachedProcess = !!proc && typeof proc.pid === "number";
    out.env = proc.env ? Object.keys(proc.env).length : "no env";
    // process.binding is the main route from \`process\` to internals, and so
    // to raw sockets. --permission is what closes it.
    try { out.binding = typeof proc.binding("tcp_wrap"); } catch (e) { out.binding = e.code ?? e.message; }
    // A function built by the outer realm still cannot import: there is no
    // host-defined import callback for code compiled this way.
    try { await F("return import('node:net')")(); out.import = "GOT node:net"; }
    catch (e) { out.import = e.code ?? e.message; }
  } catch (e) { out.escapeFailed = e.message; }
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`;
const escBytes = Buffer.from(escapee, "utf8");
const escHash = "0x" + Buffer.from(keccak_256(escBytes)).toString("hex");
const escResolver = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/javascript" });
  res.end(escBytes);
});
await new Promise((r) => escResolver.listen(0, "127.0.0.1", r));
cleanups.push(() => escResolver.close());
const escUrl = `http://127.0.0.1:${escResolver.address().port}/w.js`;

const escaper = new AnonRpcWorker({
  address: SPECIFIER,
  preExisting: {
    rpcProvider: {
      async request({ method, params }) {
        if (method !== "eth_call") throw new Error("unexpected");
        const data = params[0].data;
        if (data === SEL_HASH) return "0x" + pad(escHash);
        if (data === SEL_RESOLVERS) return encodeStringArray([escUrl]);
        throw new Error("unexpected selector");
      },
    },
  },
});
cleanups.push(() => escaper.close());
await escaper.ready;
const esc = await (await escaper.fetch("http://example.invalid/")).json();
escaper.close();

// Recorded, not asserted false: if a future node closes this the test should
// say so rather than fail, because nothing here depends on it staying open.
ok(`worker escapes the vm context to real \`process\`: ${esc.reachedProcess} (vm is not a boundary, by design)`);
if (esc.env !== 0) fail(`escaped worker saw ${esc.env} environment variables, want 0`);
if (esc.binding === "object") fail(`escaped worker reached process.binding: ${JSON.stringify(esc)}`);
if (esc.import === "GOT node:net") fail(`escaped worker imported node:net: ${JSON.stringify(esc)}`);
ok(`…and is still contained: binding ${esc.binding}, import ${esc.import}, env 0 vars`);

console.log("\n✅ node-harness e2e passed");
cleanup();
process.exit(0);
