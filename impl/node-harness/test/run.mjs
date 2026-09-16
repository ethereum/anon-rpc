// End-to-end: the REAL passthrough worker bundle, hash-verified from a
// specifier read, running inside a QuickJS-WASM isolate on a worker_thread,
// answering a JSON-RPC request through the harness's anonymized fetch.
//
// Hermetic and chain-free. §5 takes the bootstrap provider as an injectable
// dependency, so the specifier read is stubbed with the ABI encoding a real
// contract would return — which exercises the same decode path as mainnet
// without needing anvil. The bundle bytes, the keccak256 check, the isolate and
// the capability API are all the real thing.
//
// No platform skip. That is the headline difference from the previous
// strategy's e2e, which could only run on Linux 5.13+ with a Go-built launcher
// present: the boundary is now the interpreter, so this runs anywhere Node does.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, "..");
const IMPL = resolve(HARNESS, "..");
const BUNDLE = resolve(HARNESS, "../passthrough-worker/dist/passthrough-worker.js");

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch {} });
process.on("exit", cleanup);
const fail = (m) => { console.error("❌ " + m); cleanup(); process.exit(1); };
const ok = (m) => console.log("  ✓ " + m);

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

/** Serve some bytes as a worker bundle, and a provider that pins their hash. */
async function publish(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
  const hash = "0x" + Buffer.from(keccak_256(bytes)).toString("hex");
  const server = createServer((_q, res) => {
    served++;
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(bytes);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/w.js`;
  return {
    hash,
    url,
    provider: {
      async request({ method, params }) {
        if (method !== "eth_call") throw new Error(`unexpected bootstrap call: ${method}`);
        specifierReads++;
        const data = params[0].data;
        if (data === SEL_HASH) return "0x" + pad(hash);
        if (data === SEL_RESOLVERS) return encodeStringArray([url]);
        throw new Error(`unexpected selector: ${data}`);
      },
    },
  };
}
let served = 0;
let specifierReads = 0;

/* --- an "ethereum node" for the worker to reach through the isolate ----- */

let workerRpcCalls = 0;
const chain = createServer((req, res) => {
  workerRpcCalls++;
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { id, method } = JSON.parse(body || "{}");
    const result = method === "eth_blockNumber" ? "0x1312d00" : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});
await new Promise((r) => chain.listen(0, "127.0.0.1", r));
cleanups.push(() => chain.close());
const chainUrl = `http://127.0.0.1:${chain.address().port}/`;

// Every worker below that needs the local chain carries this. Loopback is
// DENIED by default — the granted fetch is policy-checked, which is the point
// of it being a grant — and a wallet pointing its worker at a node on
// localhost is exactly why the escape hatch exists.
const allowLoopback = { policy: { allow: ["127.0.0.1/32"] } };

/* --- 1. the happy path -------------------------------------------------- */

const real = await publish(bundle);
const worker = new AnonRpcWorker({
  address: SPECIFIER,
  preExisting: { rpcProvider: real.provider },
  network: allowLoopback,
});
cleanups.push(() => worker.close());

await worker.ready;
ok("worker booted: specifier read, bundle keccak-verified, running in a QuickJS isolate");
if (specifierReads !== 2) fail(`expected 2 specifier reads, got ${specifierReads}`);
if (served !== 1) fail(`expected the resolver to be hit once, got ${served}`);

const res = await worker.fetch(chainUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
});
if (res.status !== 200) fail(`worker fetch returned ${res.status}`);
const { result } = await res.json();
if (result !== "0x1312d00") fail(`unexpected RPC result: ${result}`);
if (workerRpcCalls !== 1) fail(`expected 1 call to reach the chain, got ${workerRpcCalls}`);
ok(`eth_blockNumber answered through the isolated worker (${result})`);

// The reference worker is unmodified: it calls the ambient `fetch` it was
// written against, which here is a capability the host installed and mediates.
ok("the unmodified reference bundle ran — `fetch` as a grant, not a platform fact");

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

{
  const wrongHash = "0x" + "11".repeat(32);
  const tampered = new AnonRpcWorker({
    address: SPECIFIER,
    network: allowLoopback,
    preExisting: {
      rpcProvider: {
        async request({ method, params }) {
          if (method !== "eth_call") throw new Error("unexpected");
          const data = params[0].data;
          if (data === SEL_HASH) return "0x" + pad(wrongHash);
          if (data === SEL_RESOLVERS) return encodeStringArray([real.url]);
          throw new Error("unexpected selector");
        },
      },
    },
  });
  let hashErr;
  await tampered.ready.catch((e) => (hashErr = e));
  tampered.close();
  if (!hashErr) fail("a bundle whose hash does not match the specifier was accepted");
  if (!/hash mismatch/.test(hashErr.message)) fail(`expected a hash-mismatch error, got: ${hashErr.message}`);
  ok("bundle rejected when keccak256 does not match workerHash (§4)");
}

/** Run a worker whose only job is to report a JSON object, and return it. */
async function interrogate(source, init = {}) {
  const pub = await publish(source);
  const w = new AnonRpcWorker({
    address: SPECIFIER,
    preExisting: { rpcProvider: pub.provider },
    ...init,
  });
  cleanups.push(() => w.close());
  await w.ready;
  const out = await (await w.fetch("http://report.invalid/")).json();
  w.close();
  return out;
}

/* --- 4. zero ambient capability: there is nothing to reach ------------- */

// The previous strategy's equivalent test asserted that a hostile worker's
// access was DENIED. Here the interesting result is that the names it would
// use do not exist: no process, no require, no import, no ambient platform.
const hostile = await interrogate(
  `
(async () => {
  const out = {};
  out.process = typeof globalThis.process;
  out.require = typeof globalThis.require;
  out.globalCount = Object.getOwnPropertyNames(globalThis).length;
  // The node:vm escape, all three doors. Each one returns the GUEST's
  // Function, which compiles in the GUEST's global scope.
  out.viaCapability = String(anonRpcWorker.signalReady.constructor("return typeof process")());
  out.viaConsole = String(console.log.constructor("return typeof globalThis.require")());
  out.ctorIsOurs = anonRpcWorker.signalReady.constructor === Function;
  // No module loader is installed, so nothing can be loaded.
  try { await import("node:fs"); out.import = "GOT node:fs"; } catch (e) { out.import = e.message; }
  // The raw bridge the platform is built on was deleted from the global.
  out.bridge = ["__host_send","__host_request","__host_random","__host_url"]
    .map((n) => typeof globalThis[n]).join(",");
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`,
  { capabilities: { fetch: false } },
);

if (hostile.process !== "undefined") fail(`the guest has a \`process\`: ${JSON.stringify(hostile)}`);
if (hostile.require !== "undefined") fail(`the guest has \`require\`: ${JSON.stringify(hostile)}`);
if (hostile.viaCapability !== "undefined" || hostile.viaConsole !== "undefined") {
  fail(`the realm escape WORKED: ${JSON.stringify(hostile)}`);
}
if (!hostile.ctorIsOurs) fail(`a host function's constructor is foreign: ${JSON.stringify(hostile)}`);
if (hostile.import === "GOT node:fs") fail(`the guest imported node:fs: ${JSON.stringify(hostile)}`);
if (hostile.bridge !== "undefined,undefined,undefined,undefined") {
  fail(`the raw host bridge is reachable: ${hostile.bridge}`);
}
ok(
  `realm escape is CLOSED: fn.constructor is the guest's Function, ` +
    `\`return process\` gives ${hostile.viaCapability}`,
);
ok(`guest has no process, no require, no module loader (import: "${hostile.import}")`);
ok(`raw host bridge unreachable; ${hostile.globalCount} globals total, all accounted for`);

/* --- 5. a capability that is off is ABSENT, not filtered --------------- */

const absent = await interrogate(
  `
(async () => {
  const out = {
    fetch: typeof globalThis.fetch,
    socket: typeof anonRpcWorker.socket,
    // §10/§11 are REQUIRED but unimplemented, so they are present and throw
    // \`unsupported\` (§12) — the opposite convention to an optional capability.
    kps: typeof anonRpcWorker.kps,
    storage: typeof anonRpcWorker.storage,
  };
  try { await anonRpcWorker.kps.dial("x"); } catch (e) { out.kpsCode = e.code; }
  try { await anonRpcWorker.storage.get("k"); } catch (e) { out.storageCode = e.code; }
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`,
  { capabilities: { fetch: false, socket: false } },
);
if (absent.fetch !== "undefined") fail(`fetch present when not granted: ${JSON.stringify(absent)}`);
if (absent.socket !== "undefined") fail(`socket present when not granted: ${JSON.stringify(absent)}`);
if (absent.kps !== "object" || absent.storage !== "object") {
  fail(`a REQUIRED capability was absent rather than throwing: ${JSON.stringify(absent)}`);
}
if (absent.kpsCode !== "unsupported" || absent.storageCode !== "unsupported") {
  fail(`§10/§11 stubs did not report code "unsupported": ${JSON.stringify(absent)}`);
}
ok("an ungranted optional capability is absent (`if (anonRpcWorker.socket)` answers truthfully)");
ok(`an unimplemented REQUIRED capability is present and throws "unsupported" (§12)`);

/* --- 6. the granted fetch is policy-checked ---------------------------- */

// Ambient fetch never was. This is the substantive gain: the host performs the
// request, so the address policy is a boundary rather than a filter.
const policed = await interrogate(
  `
(async () => {
  const out = {};
  try { const r = await fetch(${JSON.stringify(chainUrl)}); out.loopback = r.status; }
  catch (e) { out.loopback = e.code ?? e.message; }
  try { await fetch("http://10.1.2.3/"); out.rfc1918 = "ALLOWED"; }
  catch (e) { out.rfc1918 = e.code ?? e.message; }
  try { await fetch("file:///etc/passwd"); out.file = "ALLOWED"; }
  catch (e) { out.file = e.code ?? e.message; }
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`,
  { capabilities: { fetch: true } }, // NO allow-list: loopback must be refused
);
if (policed.loopback !== "permission-denied") {
  fail(`the granted fetch reached loopback with no allow-list: ${JSON.stringify(policed)}`);
}
if (policed.rfc1918 !== "permission-denied") fail(`fetch reached RFC1918: ${JSON.stringify(policed)}`);
if (policed.file !== "permission-denied") fail(`fetch accepted a file:// URL: ${JSON.stringify(policed)}`);
ok(`granted fetch refused loopback, RFC1918 and file:// by policy (${policed.loopback})`);

/* --- 7. the bridged socket capability (PROPOSED, not in SPEC.md) ------- */

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

const sock = await interrogate(
  `
(async () => {
  const out = { hasSocket: !!anonRpcWorker.socket };
  try {
    const s = await anonRpcWorker.socket.connect("127.0.0.1", ${TCP_PORT});
    const w = s.writable.getWriter();
    await w.write(new TextEncoder().encode("GET / HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n"));
    await w.close();
    const r = s.readable.getReader();
    let text = "";
    for (;;) { const { value, done } = await r.read(); if (done) break; text += new TextDecoder().decode(value); }
    out.bridged = text.split("\\r\\n")[0];
    out.body = text.endsWith("hello");
    out.remote = s.remoteAddress.port === ${TCP_PORT} ? "port matches" : "port mismatch";
    out.closed = JSON.stringify(await s.closed);
  } catch (e) { out.bridged = "ERROR " + (e.code ?? "?") + ": " + e.message; }
  // A destination the policy does not allow.
  try { await anonRpcWorker.socket.connect("10.1.2.3", 80); out.denied = "ALLOWED"; }
  catch (e) { out.denied = e.code ?? e.message; }
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`,
  { capabilities: { fetch: false, socket: true }, network: allowLoopback },
);

if (!sock.hasSocket) fail("anonRpcWorker.socket was absent when the harness granted it");
if (!/^HTTP\/1\.1 /.test(sock.bridged)) fail(`bridged socket did not carry HTTP: ${JSON.stringify(sock)}`);
if (!sock.body) fail(`bridged socket lost the body: ${JSON.stringify(sock)}`);
if (sock.remote !== "port matches") fail(`remoteAddress wrong: ${JSON.stringify(sock)}`);
if (sock.denied !== "permission-denied") fail(`policy did not refuse 10.1.2.3: ${JSON.stringify(sock)}`);
if (tcpConns !== 1) fail(`expected 1 TCP connection, got ${tcpConns}`);
ok(`bridged socket carried a real connection ("${sock.bridged}"), closed: ${sock.closed}`);
ok(`address policy refused a non-allow-listed destination (${sock.denied})`);

/* --- 8. resource limits, which node:vm has no usable form of ----------- */

// A guest that never yields, never returns, or eats all the memory it can.
// Each of these would hang or kill the previous harness's child; here the
// isolate reports a worker failure and the host keeps running. The strongest
// assertion in this file is that the process gets to the end of it.
for (const [label, body, want] of [
  ["infinite loop", "for(;;){}", /interrupt/i],
  ["deep recursion", "(function f(){ return f() })()", /stack overflow/i],
  ["heap exhaustion", "const a=[]; for(;;) a.push(new Uint8Array(1<<20));", /memory/i],
]) {
  const pub = await publish(`anonRpcWorker.signalReady(); ${body}`);
  const w = new AnonRpcWorker({
    address: SPECIFIER,
    preExisting: { rpcProvider: pub.provider },
    capabilities: { fetch: false },
    // A short deadline so the loop case does not spend the default 5s.
    limits: { deadlineMs: 750, memoryBytes: 32 * 1024 * 1024 },
  });
  cleanups.push(() => w.close());
  let err;
  const started = Date.now();
  await w.ready.catch((e) => (err = e));
  // signalReady() runs before the hostile line, so `ready` may resolve first;
  // the failure then arrives on the next call instead.
  if (!err) await w.fetch("http://report.invalid/").catch((e) => (err = e));
  const ms = Date.now() - started;
  w.close();
  if (!err || !want.test(err.message)) {
    fail(`hostile guest "${label}" was not contained: ${err?.message ?? "no error"}`);
  }
  ok(`hostile guest contained: ${label} → ${err.message.slice(0, 60)} (${ms}ms)`);
}

// Reached only if the host survived every case above.
ok("host process survived every hostile guest");

console.log("\n✅ node-harness e2e passed");
cleanup();
process.exit(0);
