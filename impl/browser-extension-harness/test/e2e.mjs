// End-to-end: a real MV3 extension, loaded unpacked into Chromium, answering
// eth_blockNumber through the real passthrough worker bundle.
//
// This has to be a browser test. Everything interesting about this package is a
// browser-extension mechanic that has no representation outside one — whether a
// service worker can reach an offscreen document, whether a page listed in
// `sandbox.pages` really loads at an opaque origin, whether a blob Worker can
// be spawned inside it under the sandbox CSP. Unit tests can check the codec;
// only Chromium can check the premise.
//
// It assembles the extension from example/ + dist/static/ into a temp
// directory, because the manifest needs the test server's port baked in and
// because that mirrors what an integrator does: copy the harness's static
// assets in beside their own code.

import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const BUNDLE = resolve(PKG, "../passthrough-worker/dist/passthrough-worker.js");

const cleanups = [];
const cleanup = async () => {
  for (const f of cleanups.splice(0).reverse()) {
    try {
      await f();
    } catch {
      /* best effort */
    }
  }
};
const fail = async (m) => {
  console.error("❌ " + m);
  await cleanup();
  process.exit(1);
};
const ok = (m) => console.log("  ✓ " + m);

/* --- build first --------------------------------------------------------- */

// The test must run against the artifacts, not against whatever dist/ held
// before: this package's dist/static is copied into the extension verbatim, and
// the passthrough bundle below is pinned by the hash of its current bytes.
await new Promise((res, rej) => {
  const p = spawn("npm", ["run", "build", "--workspaces", "--if-present"], {
    cwd: resolve(PKG, ".."),
    stdio: "ignore",
  });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error("build failed"))));
});

/* --- the stub chain + resolver ------------------------------------------ */

const bundle = await readFile(BUNDLE).catch(() => null);
if (!bundle) await fail(`passthrough worker bundle missing: ${BUNDLE} (run npm run build --workspaces)`);
const workerHash = "0x" + Buffer.from(keccak_256(bundle)).toString("hex");
const SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";
// A second specifier, pinning a worker that reports its own environment. This
// is the privilege-separation check: worker code must NOT inherit the
// extension's identity or its host permissions, even though the offscreen
// document that loaded it has both.
const SPECIFIER_PROBE = "0x000000000000000000000000000000000000beef";
// A third specifier whose FIRST specifier read fails and whose later ones
// succeed, for the "a failed boot must not be cached" case below.
const SPECIFIER_FLAKY = "0x000000000000000000000000000000000000fa11";
let flakyCalls = 0;

const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
const word = (n) => pad(n.toString(16));
const selector = (sig) => "0x" + Buffer.from(keccak_256(Buffer.from(sig))).toString("hex").slice(0, 8);
function encodeStringArray(strings) {
  let head = word(32) + word(strings.length);
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

const probeBundle = Buffer.from(
  `
(async () => {
  const out = {};
  // Extension APIs: a sandboxed page has none, and neither does a worker in it.
  out.chrome = typeof chrome;
  out.chromeRuntime = typeof chrome !== "undefined" && chrome ? typeof chrome.runtime : "no chrome";
  // Identity: an opaque origin serialises as "null".
  out.origin = self.location && self.location.origin ? String(self.location.origin) : "(none)";
  out.href = self.location ? String(self.location.href) : "(none)";
  // Host permissions: the offscreen document fetched THIS VERY BUNDLE from an
  // endpoint with no CORS headers. If the worker could do the same, it would
  // have the extension's privileges.
  try {
    const r = await fetch(NOCORS_URL);
    out.noCors = "ALLOWED " + r.status;
  } catch (e) {
    out.noCors = "blocked";
  }
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`,
  "utf8",
);
let probeBytes = probeBundle; // NOCORS_URL is substituted once the port is known
let probeHash = "";

let bundleFetches = 0;
let probeFetches = 0;
let workerRpcCalls = 0;
let bootstrapCalls = 0;
const nullOrigins = new Set();

const server = createServer((req, res) => {
  // The worker runs at a NULL origin, so its requests are ordinary
  // cross-origin ones and need CORS. Host permissions do not help it — that is
  // the isolation working, not a misconfiguration.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.url === "/ping") {
    // A reachability check for the driver only; deliberately not counted, so
    // it cannot be mistaken for the worker having made a call.
    res.writeHead(200, { ...cors, "content-type": "text/plain" });
    return res.end("pong");
  }

  if (req.url === "/probe-worker.js") {
    // NO cors headers, deliberately. The offscreen document can read this
    // because the extension holds host permissions; a null origin cannot.
    probeFetches++;
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(probeBytes);
  }

  if (req.url === "/nocors") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }

  if (req.url === "/worker.js") {
    bundleFetches++;
    res.writeHead(200, { ...cors, "content-type": "text/javascript" });
    return res.end(bundle);
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let msg = {};
    try {
      msg = JSON.parse(body || "{}");
    } catch {
      /* fall through to the error below */
    }
    const send = (result) => {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, result }));
    };

    // The §4 specifier read, answered as the contract would.
    if (msg.method === "eth_call") {
      bootstrapCalls++;
      const data = msg.params?.[0]?.data;
      const to = (msg.params?.[0]?.to ?? "").toLowerCase();
      if (to === SPECIFIER_FLAKY.toLowerCase() && flakyCalls++ < 1) {
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        return res.end(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "flaky: first call fails" } }),
        );
      }
      const probe = to === SPECIFIER_PROBE.toLowerCase();
      if (data === selector("workerHash()")) return send("0x" + pad(probe ? probeHash : workerHash));
      if (data === selector("workerResolvers()")) {
        return send(encodeStringArray([`${ORIGIN}${probe ? "/probe-worker.js" : "/worker.js"}`]));
      }
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "bad selector" } }));
    }

    if (msg.method === "eth_blockNumber") {
      // Who asked? A request carrying `Origin: null` came from inside the
      // sandboxed frame; one from the extension's origin would mean the
      // isolation is not doing its job.
      nullOrigins.add(req.headers.origin ?? "(none)");
      workerRpcCalls++;
      return send("0x1312d00");
    }

    res.writeHead(404, cors);
    res.end();
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
cleanups.push(() => new Promise((r) => server.close(r)));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// The probe bundle's bytes are final only now, and its hash pins those exact
// bytes (§4) — so it is computed here, after substitution, not before.
probeBytes = Buffer.from(
  probeBundle.toString("utf8").replace("NOCORS_URL", JSON.stringify(`${ORIGIN}/nocors`)),
  "utf8",
);
probeHash = "0x" + Buffer.from(keccak_256(probeBytes)).toString("hex");

/* --- assemble the extension --------------------------------------------- */

const extDir = await mkdtemp(resolve(tmpdir(), "anon-rpc-ext-"));
cleanups.push(() => rm(extDir, { recursive: true, force: true }));

// The harness's static assets, copied in exactly as an integrator would.
await cp(resolve(PKG, "dist/static"), extDir, { recursive: true });

// The example's own code, bundled — a service worker resolves no bare
// specifiers, so this is the integrator's build step.
await build({
  entryPoints: [resolve(PKG, "example/background.ts")],
  outfile: resolve(extDir, "background.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
  define: {
    __TEST_ORIGIN__: JSON.stringify(ORIGIN),
    __SPECIFIER__: JSON.stringify(SPECIFIER),
  },
});
await build({
  entryPoints: [resolve(PKG, "example/page.ts")],
  outfile: resolve(extDir, "page.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});
await cp(resolve(PKG, "example/page.html"), resolve(extDir, "page.html"));

// The manifest, used as-is. Note what is NOT done here: the server's port is
// not substituted into the match patterns. A Chrome match pattern's host may
// not carry a port — `http://127.0.0.1:41234/*` is INVALID, and Chrome's
// response is to warn and drop the permission, so every fetch then fails with
// a bare "Failed to fetch". `http://127.0.0.1/*` already matches every port.
const manifest = JSON.parse(await readFile(resolve(PKG, "example/manifest.json"), "utf8"));
await writeFile(resolve(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

/* --- run it -------------------------------------------------------------- */

const userDataDir = await mkdtemp(resolve(tmpdir(), "anon-rpc-profile-"));
cleanups.push(() => rm(userDataDir, { recursive: true, force: true }));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  // `channel: "chromium"` is load-bearing, not tidiness. Playwright's DEFAULT
  // headless is the separate `chromium-headless-shell` binary, which has no
  // extension support at all — an extension loaded into it is silently absent
  // and the service worker simply never appears. This selects the full
  // Chromium build in new-headless mode, where extensions work.
  channel: "chromium",
  args: [
    "--no-sandbox",
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ],
});
cleanups.push(() => context.close());

// The service worker is the extension's identity: its URL carries the id.
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
const extensionId = new URL(sw.url()).host;
ok(`extension loaded, service worker running (${extensionId})`);

// Precondition: can the service worker reach the stub server at all? If host
// permissions are wrong every later failure is an opaque "Failed to fetch", so
// this separates "the extension cannot reach the network" from "the harness is
// broken".
const reach = await sw.evaluate(async (origin) => {
  try {
    const r = await fetch(`${origin}/ping`);
    return `ok ${r.status} ${await r.text()}`;
  } catch (e) {
    return `ERR ${e?.message ?? String(e)}`;
  }
}, ORIGIN);
console.log("  · service worker reachability:", reach);

const consoleErrors = [];
// The service worker and the offscreen document both have consoles of their
// own, and a CSP violation or a dropped permission shows up in one of them
// rather than in the page's.
const swLogs = [];
sw.on("console", (m) => swLogs.push(`[sw:${m.type()}] ${m.text()}`));
context.on("serviceworker", (w) => w.on("console", (m) => swLogs.push(`[sw:${m.type()}] ${m.text()}`)));
context.on("page", (p) =>
  p.on("console", (m) => swLogs.push(`[${new URL(p.url()).pathname}:${m.type()}] ${m.text()}`)),
);
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(`chrome-extension://${extensionId}/page.html`);

// The page auto-runs the call on load; wait for it to stop saying "pending".
await page
  .waitForFunction(() => document.getElementById("out")?.textContent !== "pending", { timeout: 60_000 })
  .catch(() => {});
const raw = await page.textContent("#out");
let result;
try {
  result = JSON.parse(raw);
} catch {
  await fail(`page did not produce JSON: ${raw}`);
}

if (!result.ok) {
  await fail(
    `anonymized fetch failed: ${result.error}\n` +
      `page console: ${consoleErrors.join("\n")}\n` +
      `other contexts: ${swLogs.join("\n")}`,
  );
}
if (result.json?.result !== "0x1312d00") {
  await fail(`unexpected RPC result: ${JSON.stringify(result.json)}`);
}
ok(`eth_blockNumber answered through the extension's worker (${result.json.result})`);

if (bootstrapCalls !== 2) await fail(`expected 2 specifier reads, got ${bootstrapCalls}`);
if (bundleFetches !== 1) await fail(`expected the resolver to be hit once, got ${bundleFetches}`);
ok("§4 specifier read + hash-verified bundle fetch happened in the offscreen document");

// The whole point of the sandboxed page: the request that reached the server
// came from an opaque origin, not from chrome-extension://<id>.
if (!nullOrigins.has("null")) {
  await fail(`worker requests did not come from a null origin: ${[...nullOrigins].join(", ")}`);
}
if ([...nullOrigins].some((o) => o.startsWith("chrome-extension://"))) {
  await fail(`a worker request carried the EXTENSION's origin: ${[...nullOrigins].join(", ")}`);
}
ok(`worker requests carry Origin: null — the sandboxed page is at an opaque origin`);

// The offscreen document exists and holds the isolation chain.
const offscreenPages = context
  .backgroundPages()
  .concat(context.pages())
  .filter((p) => p.url().includes("anon-rpc-offscreen.html"));
ok(
  offscreenPages.length
    ? "offscreen document is visible to the driver"
    : "offscreen document is not enumerable by Playwright (expected; it is not a page or background page)",
);

// A second call must reuse the booted worker: no new specifier read, no new
// bundle fetch. This is what makes MV3's service-worker lifecycle survivable.
await page.click("#go");
await page.waitForFunction(() => document.getElementById("out")?.textContent !== "pending", { timeout: 30_000 });
const second = JSON.parse(await page.textContent("#out"));
if (!second.ok) await fail(`second call failed: ${second.error}`);
if (bootstrapCalls !== 2 || bundleFetches !== 1) {
  await fail(
    `second call re-booted the worker (specifier reads ${bootstrapCalls}, bundle fetches ${bundleFetches})`,
  );
}
if (workerRpcCalls !== 2) await fail(`expected 2 worker RPC calls, got ${workerRpcCalls}`);
ok("a second call reused the booted worker — no re-read, no re-fetch, no re-verify");

/* --- privilege separation: the worker is not the extension --------------- */

// A different specifier, pinning a worker that reports what it can reach. The
// page takes the address from its query string, so this is the same extension
// and the same harness — only the worker differs.
const probePage = await context.newPage();
await probePage.goto(`chrome-extension://${extensionId}/page.html?address=${SPECIFIER_PROBE}`);
await probePage
  .waitForFunction(() => document.getElementById("out")?.textContent !== "pending", { timeout: 60_000 })
  .catch(() => {});
const probeRaw = await probePage.textContent("#out");
let probeResult;
try {
  probeResult = JSON.parse(probeRaw);
} catch {
  await fail(`probe page did not produce JSON: ${probeRaw}`);
}
if (!probeResult.ok) await fail(`probe worker failed: ${probeResult.error}`);
const env = probeResult.json;

if (probeFetches !== 1) await fail(`expected 1 probe bundle fetch, got ${probeFetches}`);
ok("the offscreen document fetched a bundle from a NO-CORS endpoint — it has host permissions");

if (env.chrome !== "undefined") {
  await fail(`worker code can see the extension API: chrome is ${env.chrome} (${JSON.stringify(env)})`);
}
ok(`worker code cannot reach the extension API (typeof chrome === "${env.chrome}")`);

if (env.origin !== "null") {
  await fail(`worker origin is ${env.origin}, expected "null" (${JSON.stringify(env)})`);
}
ok(`worker's own origin is "null" — not chrome-extension://${extensionId}`);

if (env.noCors !== "blocked") {
  await fail(
    `worker reached a no-CORS endpoint (${env.noCors}) — it inherited the extension's host permissions`,
  );
}
ok("worker CANNOT reach the same no-CORS endpoint — it has none of the extension's host permissions");

/* --- a boot that failed must not be cached ------------------------------- */

// The offscreen document caches booted workers by address+config so that a
// restarted service worker reattaches instead of re-verifying. A worker whose
// boot FAILED must be evicted from that cache: its `ready` is already
// rejected, so keeping it would answer every retry with the original error —
// and the usual cause is a setting the user is about to correct, which would
// then appear to make no difference.
{
  const flakyUrl = `chrome-extension://${extensionId}/page.html?address=${SPECIFIER_FLAKY}`;
  const first = await context.newPage();
  await first.goto(flakyUrl);
  await first
    .waitForFunction(() => document.getElementById("out")?.textContent !== "pending", { timeout: 30_000 })
    .catch(() => {});
  const failed = JSON.parse((await first.textContent("#out")) ?? "{}");
  await first.close();
  if (failed.ok) await fail("the flaky specifier's first boot was expected to fail");

  const second = await context.newPage();
  await second.goto(flakyUrl);
  await second
    .waitForFunction(() => document.getElementById("out")?.textContent !== "pending", { timeout: 60_000 })
    .catch(() => {});
  const retried = JSON.parse((await second.textContent("#out")) ?? "{}");
  await second.close();
  if (!retried.ok) {
    await fail(`retrying after a failed boot returned the cached failure: ${retried.error}`);
  }
  ok("a boot that failed is evicted from the cache, so the retry is a real retry");
}

/* --- §6: a cross-origin iframeUrl is refused ----------------------------- */

// `iframeUrl` says where the null-origin document comes from. A cross-origin
// one would let a third party choose what runs in the frame that is supposed
// to CONTAIN the worker, and receive the capability port — so §6 requires the
// harness to reject it rather than trust the host to get it right.
const evilPage = await context.newPage();
await evilPage.goto(
  `chrome-extension://${extensionId}/page.html?iframeUrl=${encodeURIComponent(`${ORIGIN}/evil.html`)}`,
);
await evilPage
  .waitForFunction(() => document.getElementById("out")?.textContent !== "pending", { timeout: 30_000 })
  .catch(() => {});
const evil = JSON.parse(await evilPage.textContent("#out"));
if (evil.ok) await fail("a cross-origin iframeUrl was accepted");
if (!/same-origin/i.test(evil.error ?? "")) {
  await fail(`cross-origin iframeUrl failed for the wrong reason: ${evil.error}`);
}
ok(`cross-origin iframeUrl refused (§6): ${evil.error.slice(0, 72)}…`);

const fatal = consoleErrors.filter((t) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(t));
if (fatal.length) await fail(`console errors:\n${fatal.join("\n")}`);
ok("no console errors (CSP violations would appear here)");

console.log("\n✅ browser-extension-harness e2e passed");
await cleanup();
process.exit(0);
