// End-to-end test of the prototype against a REAL kps peer.
//
// Pipeline:
//   1. build the bundles
//   2. compute the worker bundle's keccak hash and ABI-encode a mock specifier
//      (workerHash() / workerResolvers()) so the §4 path runs for real
//   3. start an in-process kps echo peer (@kpstreams/server, npm — no Go, no
//      kps checkout) and format its ip:port:certhash address
//   4. serve the page + dist assets + a /hello passthrough endpoint
//   5. drive headless Chromium: instantiate AnonRpcWorker, await ready,
//      exercise a plain-fetch passthrough AND a kps-routed echo, assert results
//
// Run: npm run test:e2e

import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { keccak_256 } from "@noble/hashes/sha3";
import { chromium } from "playwright";
import { listen } from "@kpstreams/server";
import { build as esbuild } from "esbuild";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  cleanup();
  process.exit(1);
}

/* --- minimal ABI encoders matching src/host/specifier.ts decoders --- */

const enc = new TextEncoder();
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const selector = (sig) => "0x" + toHex(keccak_256(enc.encode(sig))).slice(0, 8);

function pad32(b) {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32 || 32);
  out.set(b);
  return out;
}
function word(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0; i--) { out[i] = n & 0xff; n = Math.floor(n / 256); }
  return out;
}
function concat(arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
// Encode `string[]` as a single dynamic return value (head offset = 0x20).
function encodeStringArray(strings) {
  const items = strings.map((s) => enc.encode(s));
  const len = word(items.length);
  const heads = [];
  const tails = [];
  let tailOffset = items.length * 32;
  for (const item of items) {
    heads.push(word(tailOffset));
    const tail = concat([word(item.length), pad32(item)]);
    tails.push(tail);
    tailOffset += tail.length;
  }
  const array = concat([len, ...heads, ...tails]);
  return concat([word(0x20), array]);
}

// Three workers under test, each with its own mock specifier address:
// the capability-exercising test worker, the minimal template, and the
// template again resolved over a kps resolver (§4.1–4.2).
const TEST_ADDR = "0xabc0000000000000000000000000000000000001";
const PT_ADDR = "0xabc0000000000000000000000000000000000002";
const PT_KPS_ADDR = "0xabc0000000000000000000000000000000000003";
const PT_KPS_BAD_ADDR = "0xabc0000000000000000000000000000000000004";
const PT_KPS_GZ_ADDR = "0xabc0000000000000000000000000000000000005";
const FAIL_ADDR = "0xabc0000000000000000000000000000000000006";

// A worker that refuses to become ready (§7 signalFailed) — plain source, no
// build: its bytes are the hash-pinned artifact like any other bundle. The
// trailing signalReady() must be ignored (failure is final).
const failingWorkerBytes = new TextEncoder().encode(
  `anonRpcWorker.signalFailed({ code: "e2e-refuse", message: "deliberately failing" });
anonRpcWorker.signalReady();
`,
);

async function main() {
  // 1. build all workspaces
  await run("npm", ["run", "build"], { cwd: ROOT });

  // 2. hash both worker bundles for their mock specifiers
  const testWorkerBytes = new Uint8Array(await readFile(`${ROOT}test-worker/dist/test-worker.js`));
  const ptWorkerBytes = new Uint8Array(
    await readFile(`${ROOT}passthrough-worker/dist/passthrough-worker.js`),
  );

  // 3. kps echo server + a kps bundle server speaking the §4.2 GET exchange
  const kpsAddr = await startKpsServer();
  console.log(`kps echo server: ${kpsAddr}`);
  const { addr: kpsBundleAddr, requests: kpsBundleRequests } = await startKpsBundleServer(ptWorkerBytes);
  console.log(`kps bundle server: ${kpsBundleAddr}`);

  // 4. http server
  const { origin, ethCallMap, port } = await startHttpServer({
    testWorkerBytes,
    ptWorkerBytes,
    kpsBundleAddr,
  });
  console.log(`http server: ${origin}`);

  // 5. drive chromium
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--force-webrtc-ip-handling-policy=default",
    ],
  });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`  [page:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`  [page:error] ${e.message}`));

  await page.goto(`${origin}/`);
  await page.waitForFunction(() => "AnonRpcWorker" in window, null, { timeout: 5000 });

  const evalCfg = {
    ethCallMap, // nested: address -> selector -> return data
    testAddress: TEST_ADDR,
    ptAddress: PT_ADDR,
    ptKpsAddress: PT_KPS_ADDR,
    ptKpsBadAddress: PT_KPS_BAD_ADDR,
    ptKpsGzAddress: PT_KPS_GZ_ADDR,
    failAddress: FAIL_ADDR,
    kpsAddr,
    origin,
  };

  const result = await page.evaluate(
    async (cfg) => {
      const provider = {
        request: async ({ method, params }) => {
          if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
          const sel = params[0].data.slice(0, 10);
          const ret = cfg.ethCallMap[params[0].to]?.[sel];
          if (!ret) throw new Error(`no mock eth_call for ${params[0].to} ${sel}`);
          return ret;
        },
      };
      const w = new window.AnonRpcWorker({
        address: cfg.testAddress,
        // §7.1: delivered to the worker as anonRpcWorker.config (structured
        // clone — the nested array must survive the two postMessage hops).
        config: { network: "e2e", retries: 3, tags: ["a", "b"] },
        preExisting: { rpcProvider: provider },
      });
      await w.ready;

      // §13.1: the worker logged "test-worker starting" at its very first
      // instruction, long before this line asked for it. Retention is what
      // makes that entry still be here — a push-based sink would have had
      // nobody to push it to.
      const takeLog = (ms = 5000) =>
        Promise.race([
          w.acceptLog().catch((e) => ({ level: "!", args: [String(e?.message ?? e)] })),
          new Promise((r) => setTimeout(() => r(null), ms)),
        ]);
      const firstLogRaw = await takeLog();
      const firstLog = firstLogRaw && { level: firstLogRaw.level, args: firstLogRaw.args.map(String) };

      const sandbox = document.querySelector("iframe")?.getAttribute("sandbox");

      const r1 = await w.fetch(`${cfg.origin}/hello`);
      const passthrough = await r1.text();
      const configEcho = r1.headers.get("x-anon-rpc-config");

      const payload = "ping-over-real-kps-" + "x".repeat(100);
      // x-kps-via: dial → the worker uses kps.dial + an explicit connection
      // and reports conn.remoteAddress back (§10.1). The stream-body call
      // below keeps the kps.openStream sugar path covered.
      const r2 = await w.fetch(`kps+echo://${cfg.kpsAddr}`, {
        method: "POST",
        body: payload,
        headers: { "x-kps-via": "dial" },
      });
      const echoed = await r2.text();
      const kpsRemote = r2.headers.get("x-kps-remote");

      // Request-object input: method/headers/body must be honored, not
      // silently downgraded to a bare GET.
      const r3 = await w.fetch(
        new Request(`${cfg.origin}/echo`, { method: "POST", body: "via-request-object" }),
      );
      const echoedReq = await r3.text();

      // A ReadableStream body is transferred across the boundary intact.
      const r4 = await w.fetch(`kps+echo://${cfg.kpsAddr}`, {
        method: "POST",
        body: new Blob(["stream-body-via-kps"]).stream(),
      });
      const echoedStream = await r4.text();

      // A pre-aborted fetch rejects with AbortError and must not disturb the
      // call queue for subsequent fetches.
      let abortName = "";
      try {
        await w.fetch(`${cfg.origin}/hello`, { signal: AbortSignal.abort() });
      } catch (e) {
        abortName = e?.name ?? String(e);
      }
      const r5 = await w.fetch(`${cfg.origin}/hello`);
      const afterAbort = await r5.text();
      // §11 storage demo: the worker persists a call counter and reports it.
      const callCount = r5.headers.get("x-anon-rpc-call-count");

      w.close();

      // The minimal template worker works standalone under its own specifier.
      const pt = new window.AnonRpcWorker({
        address: cfg.ptAddress,
        preExisting: { rpcProvider: provider },
      });
      await pt.ready;
      const rp = await pt.fetch(`${cfg.origin}/hello`);
      const ptBody = await rp.text();
      const ptCountHeader = rp.headers.get("x-anon-rpc-call-count");
      pt.close();

      // §4.1–4.2 gauntlet: unrecognized entry + every kps failure mode fall
      // through, and the final pinned-bytes resolver boots the worker.
      const ptKps = new window.AnonRpcWorker({
        address: cfg.ptKpsAddress,
        preExisting: { rpcProvider: provider },
      });
      await ptKps.ready;
      const rk = await ptKps.fetch(`${cfg.origin}/hello`);
      const ptKpsBody = await rk.text();
      ptKps.close();

      // Only failing kps resolvers: ready must reject (with the per-resolver
      // diagnostics), not hang.
      const ptKpsBad = new window.AnonRpcWorker({
        address: cfg.ptKpsBadAddress,
        preExisting: { rpcProvider: provider },
      });
      let kpsBadBootError = "";
      try {
        await ptKpsBad.ready;
      } catch (e) {
        kpsBadBootError = String(e?.message ?? e);
      }
      ptKpsBad.close();

      // §7 signalFailed: ready rejects with the structured reason; the
      // worker's follow-up signalReady() is ignored (failure is final).
      const failing = new window.AnonRpcWorker({
        address: cfg.failAddress,
        preExisting: { rpcProvider: provider },
      });
      let signalFailedError = null;
      try {
        await failing.ready;
      } catch (e) {
        signalFailedError = { name: e?.name, code: e?.code, message: e?.message };
      }
      failing.close();

      // §4.2 content coding: bundle served as Content-Encoding: gzip.
      const ptKpsGz = new window.AnonRpcWorker({
        address: cfg.ptKpsGzAddress,
        preExisting: { rpcProvider: provider },
      });
      await ptKpsGz.ready;
      const rgz = await ptKpsGz.fetch(`${cfg.origin}/hello`);
      const ptKpsGzBody = await rgz.text();
      ptKpsGz.close();

      // A multi-argument entry, to show args cross as a LIST rather than a
      // pre-joined string: the worker logs ("routing over kps to", addr).
      let kpsLog = null;
      for (let i = 0; i < 20 && !kpsLog; i++) {
        const e = await takeLog(2000);
        if (!e) break;
        if (e.args.length > 1) kpsLog = { level: e.level, args: e.args.map(String) };
      }

      return {
        firstLog, kpsLog,
        sandbox, passthrough, echoed, sentPayload: payload, kpsRemote,
        echoedReq, echoedStream, abortName, afterAbort, callCount, configEcho,
        ptBody, ptCountHeader, ptKpsBody, kpsBadBootError, ptKpsGzBody, signalFailedError,
      };
    },
    evalCfg,
  );

  // assertions
  check("iframe sandbox is allow-scripts only (§6)", result.sandbox, "allow-scripts");
  check(
    "acceptLog delivers a line logged before anyone was listening (§13.1)",
    JSON.stringify(result.firstLog),
    JSON.stringify({ level: "info", args: ["test-worker starting"] }),
  );
  check(
    "log args cross as a list, with the level intact (§13.1)",
    JSON.stringify(result.kpsLog?.args?.[0]) + "/" + result.kpsLog?.level,
    JSON.stringify("routing over kps to") + "/debug",
  );
  check("plain fetch passthrough body", result.passthrough, `hello from ${origin}`);
  check(
    "init config delivered to the worker (§7.1)",
    result.configEcho,
    '{"network":"e2e","retries":3,"tags":["a","b"]}',
  );
  check("kps-routed echo round-trips bytes", result.echoed, result.sentPayload);
  // Dial side: remoteAddress is the dialed endpoint (SPEC §10.1, KPS 0.2.x).
  check(
    "worker observes conn.remoteAddress (§10.1)",
    result.kpsRemote,
    kpsAddr.split(":").slice(0, 2).join(":"),
  );
  check("Request-object POST body honored (§5)", result.echoedReq, "via-request-object");
  check("ReadableStream body transfers across the boundary", result.echoedStream, "stream-body-via-kps");
  check("pre-aborted fetch rejects with AbortError", result.abortName, "AbortError");
  check("fetch after an aborted fetch still works (§8 no-drop)", result.afterAbort, `hello from ${origin}`);
  // 5 calls were delivered above (the aborted one was withdrawn, never seen).
  check("worker-persisted call counter (§11 storage)", result.callCount, "5");
  check("minimal passthrough-worker template serves fetch", result.ptBody, `hello from ${origin}`);
  check("minimal template adds no extra headers", result.ptCountHeader, null);
  check(
    "bundle resolved over a kps resolver, unrecognized entry ignored (§4.1–4.2)",
    result.ptKpsBody,
    `hello from ${origin}`,
  );
  // The real @kpstreams/server saw each failure-mode route, in resolver-list
  // order, before the pinned bytes were accepted (§4.2 fall-through) — plus
  // the negative boot's lone /missing.js attempt.
  check(
    "every §4.2 failure mode was attempted in order against the kps server",
    kpsBundleRequests.join(" "),
    "/missing.js /redirect.js /chunked.js /tampered.js /badcoding.js /w.js /missing.js /gzip.js",
  );
  if (!/no resolver yielded bytes matching workerHash/.test(result.kpsBadBootError)) {
    fail(`kps-only failing resolvers: expected a diagnostic boot rejection, got: ${result.kpsBadBootError}`);
  }
  console.log("  ✓ boot rejects with diagnostics when every kps resolver fails");
  check(
    "gzip-encoded bundle advertised, decoded, and verified (§4.2)",
    result.ptKpsGzBody,
    `hello from ${origin}`,
  );
  check(
    "signalFailed rejects ready with the structured reason; late signalReady ignored (§7)",
    JSON.stringify(result.signalFailedError),
    JSON.stringify({ name: "WorkerFailedError", code: "e2e-refuse", message: "deliberately failing" }),
  );

  // Reload the page and start a fresh worker: the counter must continue —
  // this is what proves the store is IndexedDB, not per-page memory.
  await page.reload();
  await page.waitForFunction(() => "AnonRpcWorker" in window, null, { timeout: 5000 });
  const afterReload = await page.evaluate(async (cfg) => {
    const provider = {
      request: async ({ method, params }) => {
        if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
        const ret = cfg.ethCallMap[params[0].to]?.[params[0].data.slice(0, 10)];
        if (!ret) throw new Error("no mock eth_call");
        return ret;
      },
    };
    const w = new window.AnonRpcWorker({
      address: cfg.testAddress,
      preExisting: { rpcProvider: provider },
    });
    await w.ready;
    const r = await w.fetch(`${cfg.origin}/hello`);
    const callCount = r.headers.get("x-anon-rpc-call-count");
    const configEcho = r.headers.get("x-anon-rpc-config");
    w.close();
    return { callCount, configEcho };
  }, evalCfg);
  check("storage persists across page reloads (IndexedDB, §11)", afterReload.callCount, "6");
  // This worker was constructed WITHOUT config: §7.1 requires undefined.
  check("absent config surfaces as undefined (§7.1)", afterReload.configEcho, null);

  console.log("\n✅ all e2e assertions passed");
  cleanup();
  process.exit(0);

  /* helpers bound to closure */

  async function startHttpServer({ testWorkerBytes, ptWorkerBytes, kpsBundleAddr }) {
    // The page has no bundler, so bundle the PUBLISHED entry (dist/host.js,
    // deps external) against node_modules here — exercising exactly what a
    // consumer's bundler would resolve.
    const bundled = await esbuild({
      entryPoints: [`${ROOT}browser-harness/dist/host.js`],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "warning",
    });
    const hostBundle = bundled.outputFiles[0].contents;
    const page = await readFile(`${HERE}page.html`);

    const server = createServer(async (req, res) => {
      const url = req.url.split("?")[0];
      if (url === "/") return send(res, 200, "text/html", page);
      if (url === "/dist/host.js") return send(res, 200, "text/javascript", hostBundle);
      if (url === "/dist/test-worker.js") return send(res, 200, "text/javascript", testWorkerBytes);
      if (url === "/dist/passthrough-worker.js") return send(res, 200, "text/javascript", ptWorkerBytes);
      if (url === "/dist/failing-worker.js") return send(res, 200, "text/javascript", failingWorkerBytes);
      if (url === "/hello") return send(res, 200, "text/plain", `hello from ${originRef.value}`);
      if (url === "/echo" && req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => send(res, 200, "application/octet-stream", Buffer.concat(chunks)));
        return;
      }
      send(res, 404, "text/plain", "not found");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    originRef.value = origin;

    // One mock specifier per worker: address -> selector -> ABI return data.
    const specifier = (bytes, url) => ({
      [selector("workerHash()")]: "0x" + toHex(keccak_256(bytes)),
      [selector("workerResolvers()")]: "0x" + toHex(encodeStringArray([url])),
    });
    const ethCallMap = {
      [TEST_ADDR]: specifier(testWorkerBytes, `${origin}/dist/test-worker.js`),
      [PT_ADDR]: specifier(ptWorkerBytes, `${origin}/dist/passthrough-worker.js`),
      // §4.1–4.2 gauntlet: an unrecognized entry kind, then every kps failure
      // mode (404, redirect, forbidden Transfer-Encoding, tampered bytes) —
      // each must fail that resolver WITHOUT failing the boot — and finally
      // the pinned bytes. Order is asserted via the server's request log.
      [PT_KPS_ADDR]: {
        [selector("workerHash()")]: "0x" + toHex(keccak_256(ptWorkerBytes)),
        [selector("workerResolvers()")]:
          "0x" + toHex(encodeStringArray([
            "future-scheme:opaque-thing",
            `kps:${kpsBundleAddr}/missing.js`,
            `kps:${kpsBundleAddr}/redirect.js`,
            `kps:${kpsBundleAddr}/chunked.js`,
            `kps:${kpsBundleAddr}/tampered.js`,
            `kps:${kpsBundleAddr}/badcoding.js`,
            `kps:${kpsBundleAddr}/w.js`,
          ])),
      },
      // Only failing kps resolvers: the boot itself must reject.
      [PT_KPS_BAD_ADDR]: {
        [selector("workerHash()")]: "0x" + toHex(keccak_256(ptWorkerBytes)),
        [selector("workerResolvers()")]:
          "0x" + toHex(encodeStringArray([`kps:${kpsBundleAddr}/missing.js`])),
      },
      // §7 signalFailed: the worker deliberately refuses readiness.
      [FAIL_ADDR]: specifier(failingWorkerBytes, `${origin}/dist/failing-worker.js`),
      // §4.2 content coding: the bundle arrives gzipped and is decoded before
      // the hash check (the route 500s unless gzip was advertised).
      [PT_KPS_GZ_ADDR]: {
        [selector("workerHash()")]: "0x" + toHex(keccak_256(ptWorkerBytes)),
        [selector("workerResolvers()")]:
          "0x" + toHex(encodeStringArray([`kps:${kpsBundleAddr}/gzip.js`])),
      },
    };
    return { origin, ethCallMap, port };
  }
}

const originRef = { value: "" };

function check(label, actual, expected) {
  if (actual !== expected) fail(`${label}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${label}`);
}

function send(res, status, type, body) {
  // The worker fetches /hello from a null origin (sandboxed iframe), so the
  // response must be CORS-readable or it would come back opaque.
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(body);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// In-process kps echo peer via the published @kpstreams/server package —
// mirrors the Go demo server's behaviour: echo every stream's bytes back
// until the peer finishes its write half, then close.
async function startKpsServer() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const listener = await listen({
    port,
    address: "127.0.0.1",
    certPath: `${HERE}.tmp-kps.cert`,
    keyPath: `${HERE}.tmp-kps.key`,
  });
  cleanups.push(() => void listener.close());

  (async () => {
    for (;;) {
      let conn;
      try {
        conn = await listener.accept();
      } catch {
        return; // listener closed
      }
      (async () => {
        for (;;) {
          let stream;
          try {
            stream = await conn.acceptStream();
          } catch {
            return; // connection closed
          }
          echoStream(stream).catch(() => {});
        }
      })();
    }
  })();

  return listener.address("127.0.0.1");
}

// A KPS listener speaking the §4.2 bundle-fetch exchange: one GET per stream,
// request read to EOF, response headers + bytes written, then closeWrite.
// Routes cover every §4.2 failure mode so the harness's fall-through can be
// proven against a real server:
//   /w.js        → 200 + the pinned bytes
//   /tampered.js → 200 + DIFFERENT bytes (harness must reject the hash)
//   /missing.js  → 404 (non-200 fails the resolver)
//   /chunked.js  → 200 + Transfer-Encoding header + the PINNED bytes — only
//                  the §4.2 abandon rule stops this one from succeeding
//   /redirect.js → 301 + Location (redirects must never be followed)
//   /badcoding.js→ 200 + an UNADVERTISED Content-Encoding + the pinned bytes
//                  (§4.2: only advertised codings may be used)
//   /gzip.js     → 200 + Content-Encoding: gzip + gzipped pinned bytes; 500
//                  unless the request advertised gzip in Accept-Encoding
// Requests are recorded (in order) for the caller to assert on.
async function startKpsBundleServer(bundleBytes) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const listener = await listen({
    port,
    address: "127.0.0.1",
    certPath: `${HERE}.tmp-kps-bundle.cert`,
    keyPath: `${HERE}.tmp-kps-bundle.key`,
  });
  cleanups.push(() => void listener.close());

  (async () => {
    for (;;) {
      let conn;
      try {
        conn = await listener.accept();
      } catch {
        return; // listener closed
      }
      (async () => {
        for (;;) {
          let stream;
          try {
            stream = await conn.acceptStream();
          } catch {
            return; // connection closed
          }
          serveBundle(stream).catch(() => {});
        }
      })();
    }
  })();

  const requests = [];

  async function serveBundle(stream) {
    const reader = stream.readable.getReader();
    const chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const req = Buffer.concat(chunks).toString("utf8");
    console.log(`  [kps-bundle] ${req.split("\r\n")[0]}`);
    const m = /^GET (\S+) HTTP\/1\.1\r\n/.exec(req);
    const hasHost = /\r\nHost: \S+/i.test(req);
    const path = m && hasHost ? m[1] : null;
    if (path) requests.push(path);

    const writer = stream.writable.getWriter();
    const send = (head, body = Buffer.alloc(0)) =>
      writer.write(Buffer.from(head)).then(() => (body.length ? writer.write(body) : undefined));

    if (path === "/w.js") {
      await send(`HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: ${bundleBytes.length}\r\n\r\n`, bundleBytes);
    } else if (path === "/gzip.js") {
      // §4.2: a server may only use a coding the request advertised — enforce
      // that here so the e2e also proves the harness SENT Accept-Encoding.
      const advertised = /\r\nAccept-Encoding: ([^\r]*)/i.exec(req)?.[1] ?? "";
      if (!advertised.split(/,\s*/).includes("gzip")) {
        await send("HTTP/1.1 500 Internal Server Error\r\n\r\n", Buffer.from("gzip not advertised"));
      } else {
        const gz = gzipSync(bundleBytes);
        await send(`HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\n\r\n`, gz);
      }
    } else if (path === "/badcoding.js") {
      await send(`HTTP/1.1 200 OK\r\nContent-Encoding: x-magic\r\n\r\n`, bundleBytes);
    } else if (path === "/tampered.js") {
      const evil = Buffer.concat([Buffer.from("//evil\n"), bundleBytes]);
      await send(`HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\n\r\n`, evil);
    } else if (path === "/chunked.js") {
      // The PINNED bytes behind a forbidden header: a lenient client would
      // succeed here, so only the §4.2 abandon rule makes this entry fail.
      await send(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n`, bundleBytes);
    } else if (path === "/redirect.js") {
      await send(`HTTP/1.1 301 Moved Permanently\r\nLocation: https://elsewhere.test/w.js\r\n\r\n`);
    } else {
      await send("HTTP/1.1 404 Not Found\r\n\r\n", Buffer.from("nope"));
    }
    await writer.close(); // EOF terminates the body (§4.2)
    await stream.close().catch(() => {});
  }

  return { addr: listener.address("127.0.0.1"), requests };
}

async function echoStream(stream) {
  console.log("  [kps] new stream");
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.close(); // FIN: peer observes EOF after the echoed bytes
  } finally {
    await stream.close().catch(() => {});
  }
}

main().catch((e) => fail(e.stack || String(e)));
