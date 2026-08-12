// Site smoke test: drives the BUILT demo (dist/) end-to-end with Playwright
// against an anvil chain — a specifier deployed by the real publish script, a
// local resolver, and the real harness boot inside the page. This is the test
// that catches "the bundle resolves the wrong artifact" regressions, which
// typecheck and the harness e2e cannot see.
//
// Skips gracefully when Foundry is absent (anvil is the chain).

import { spawn, execSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const HERE = new URL(".", import.meta.url).pathname; // impl/site/test/
const SITE = new URL("..", import.meta.url).pathname; // impl/site/
const IMPL = new URL("../..", import.meta.url).pathname; // impl/

// Anvil's well-known dev key #0 and dev account #1 as the watched address.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WATCH = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch {} });
process.on("exit", cleanup);
const fail = (m) => { console.error("❌ " + m); cleanup(); process.exit(1); };
const ok = (m) => console.log("  ✓ " + m);

try {
  execSync("anvil --version", { stdio: "ignore" });
} catch {
  // In CI a skip would mask a broken foundry install as green: fail instead.
  if (process.env.CI) fail("foundry is required in CI (anvil not found)");
  console.log("⚠ foundry not installed — skipping site smoke test (https://getfoundry.sh)");
  process.exit(0);
}

// Fresh build of everything the page loads.
await new Promise((resolve, reject) => {
  const p = spawn("npm", ["run", "build"], { cwd: IMPL, stdio: "ignore" });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("build failed"))));
});

// The failure mode this test exists for: harness build-time defines must not
// leak into the site bundle as bare identifiers. Vite hashes output names, so
// scan every built JS file.
const jsFiles = (await readdir(`${SITE}dist`, { recursive: true })).filter((f) => f.endsWith(".js"));
if (jsFiles.length === 0) fail("no JS files in the built site");
for (const f of jsFiles) {
  const bundleJs = await readFile(`${SITE}dist/${f}`, "utf8");
  for (const ident of ["__IFRAME_BOOT_SRC__", "__WORKER_RUNTIME_SRC__"]) {
    if (bundleJs.includes(ident)) fail(`site bundle ${f} contains unresolved build-time define ${ident}`);
  }
}
ok(`site bundles have no unresolved build-time defines (${jsFiles.length} JS file${jsFiles.length === 1 ? "" : "s"})`);

// The hosted markdown pages: repo docs rendered into the site at build time.
const docPages = [
  ["spec", "anon-rpc Specification"],
  ["wallets", "Integration Guide: Web Wallets and Web Applications"],
  ["networks", "Integration Guide: Anonymizing Networks"],
];
for (const [slug, heading] of docPages) {
  const html = await readFile(`${SITE}dist/${slug}/index.html`, "utf8");
  if (!html.includes(heading)) fail(`/${slug}/ is missing its rendered markdown (want "${heading}")`);
  if (html.includes("<!--DOC_HTML-->")) fail(`/${slug}/ still contains the unreplaced DOC_HTML slot`);
  if (!html.includes("View on GitHub")) fail(`/${slug}/ is missing the View on GitHub link`);
  if (!html.includes('class="shiki')) fail(`/${slug}/ code blocks are not syntax-highlighted`);
}
ok("doc pages (spec, wallets, networks) render with GitHub links and highlighted code");

// The wallet guide's quick start is generated per known worker: every
// deployment in known-workers.json must have a tab and a code panel carrying
// its own address, or the guide is advertising a stale one.
{
  const known = JSON.parse(await readFile(`${IMPL}../known-workers.json`, "utf8")).workers;
  const html = await readFile(`${SITE}dist/wallets/index.html`, "utf8");
  if (html.includes("WORKER_PICKER")) fail("/wallets/ still contains the picker markers");
  for (const w of known) {
    if (!html.includes(`id="worker-tab-${w.id}"`)) fail(`/wallets/ picker has no tab for ${w.id}`);
    if (!html.includes(`id="worker-panel-${w.id}"`)) fail(`/wallets/ picker has no panel for ${w.id}`);
    if (!html.includes(w.specifier)) fail(`/wallets/ picker is missing ${w.id}'s specifier address`);
    const gateway = w.config?.gateways?.[0];
    if (gateway && !html.includes(gateway)) fail(`/wallets/ ${w.id} sample is missing its config gateway`);
  }
  // Without JavaScript the first worker's sample must still be on the page.
  const openPanels = [...html.matchAll(/id="worker-panel-([\w-]+)"([^>]*)>/g)]
    .filter(([, , attrs]) => !attrs.includes("hidden"))
    .map(([, id]) => id);
  if (openPanels.join() !== known[0].id) {
    fail(`/wallets/ should open on ${known[0].id} alone, got [${openPanels}]`);
  }
  ok(`/wallets/ quick start tabs all ${known.length} known workers, opening on ${known[0].id}`);
}

// anvil
const anvilPort = 21000 + Math.floor(Math.random() * 9000);
const anvil = spawn("anvil", ["--port", String(anvilPort)], { stdio: "ignore" });
cleanups.push(() => anvil.kill("SIGKILL"));
const rpc = `http://127.0.0.1:${anvilPort}`;
for (let i = 0; ; i++) {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
    });
    if (r.ok) break;
  } catch {}
  if (i > 50) fail("anvil didn't start");
  await new Promise((r) => setTimeout(r, 100));
}

// Local resolver serving the worker bundle (CORS for the page origin).
const workerBundle = await readFile(`${IMPL}passthrough-worker/dist/passthrough-worker.js`);
const resolver = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
  res.end(workerBundle);
});
await new Promise((r) => resolver.listen(0, "127.0.0.1", r));
cleanups.push(() => resolver.close());
const resolverUrl = `http://127.0.0.1:${resolver.address().port}/w.js`;

// Deploy the specifier with the real publish script (all knobs pinned).
const out = await new Promise((resolve, reject) => {
  const p = spawn("node", ["publish-worker.mjs", "--yes"], {
    cwd: `${IMPL}specifier`,
    env: {
      ...process.env,
      RPC_URL: rpc,
      PRIVATE_KEY: ANVIL_KEY,
      RESOLVER_URLS: resolverUrl,
      GITHUB_RESOLVER: "0",
      SKIP_RESOLVER_CHECK: "0",
      WORKER_BUNDLE: `${IMPL}passthrough-worker/dist/passthrough-worker.js`,
      ETHERSCAN_API_KEY: "",
      VERIFIER: "etherscan",
    },
  });
  let o = "";
  p.stdout.on("data", (b) => (o += b));
  p.stderr.on("data", (b) => (o += b));
  p.on("exit", (code) => (code === 0 ? resolve(o) : reject(new Error(`publish failed:\n${o}`))));
});
const specifier = out.match(/address: "(0x[0-9a-fA-F]{40})"/)?.[1];
if (!specifier) fail("no specifier deployed");
ok(`specifier on anvil: ${specifier}`);

// Serve the built site.
const site = createServer(async (req, res) => {
  const path = req.url.split("?")[0].replace(/\/$/, "/index.html");
  try {
    const body = await readFile(`${SITE}dist${path}`);
    const type = path.endsWith(".html") ? "text/html"
      : path.endsWith(".css") ? "text/css"
      : path.endsWith(".svg") ? "image/svg+xml"
      : path.endsWith(".map") ? "application/json"
      : "text/javascript";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
cleanups.push(() => site.close());
const siteUrl = `http://127.0.0.1:${site.address().port}`;

// Drive the demo UI.
const browser = await chromium.launch({ args: ["--no-sandbox"] });
cleanups.push(() => browser.close());
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [page:error]", e.message));

// Hermetic: only local servers are reachable. The page otherwise loads Google
// Fonts (whose late swap reflows the layout — which made a CI click miss the
// copy button) and probes live public RPC endpoints; a CI test must depend on
// neither.
await page.route("**/*", (route) => {
  const host = new URL(route.request().url()).hostname;
  return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
});

await page.goto(`${siteUrl}/demo/`);

// Fresh visit: watch address prefills with the beacon deposit contract.
if ((await page.inputValue("#watch")) !== "0x00000000219ab540356cBB839Cbe05303d7705Fa") {
  fail("watch address did not prefill with the beacon deposit contract");
}
ok("watch address prefilled with the default");

// The demo's preset picker is driven by the same known-workers.json as the
// wallet guide: every entry, plus the demo-only "custom" option.
{
  const known = JSON.parse(await readFile(`${IMPL}../known-workers.json`, "utf8")).workers;
  const options = await page.$$eval("#preset option", (os) => os.map((o) => o.value));
  const want = [...known.map((w) => w.id), "custom"];
  if (options.join(",") !== want.join(",")) {
    fail(`demo presets don't match known-workers.json (got ${options}, want ${want})`);
  }
  ok(`demo preset picker lists the known workers (${options.join(", ")})`);
}

await page.fill("#bootstrap", rpc);
await page.click("#copy");
{
  const got = await page.inputValue("#worker-rpc");
  if (got !== rpc) {
    fail(`copy button didn't copy the bootstrap URL (worker-rpc: ${JSON.stringify(got)}, bootstrap: ${JSON.stringify(await page.inputValue("#bootstrap"))})`);
  }
}
ok("copy button fills worker RPC from bootstrap");
await page.fill("#specifier", specifier);
await page.fill("#watch", WATCH);

await page.click("#toggle");
await page.waitForSelector(".pill.live", { timeout: 30000 }).catch(async () => {
  fail(`worker never went live — status: ${await page.textContent("#detail")}`);
});
ok("worker booted: specifier read + hash-verified bundle running");

await page.waitForFunction(
  () => document.getElementById("balance")?.textContent?.includes("10,000"),
  null,
  { timeout: 15000 },
);
ok("balance displayed through the sandboxed worker");

// Once watching, the status line reports the last request's outcome + timing.
const detail = await page.textContent("#detail");
if (!/request OK in \d+ ms/.test(detail ?? "")) {
  fail(`status detail missing request timing — got: ${detail}`);
}
ok(`status shows request outcome (${detail.trim()})`);

// Change the balance on-chain; the next poll must reflect it.
await fetch(rpc, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "anvil_setBalance",
    params: [WATCH, "0x" + (99995n * 10n ** 17n).toString(16)], // 9999.5 ETH
  }),
});
await page.waitForFunction(
  () => document.getElementById("balance")?.textContent?.includes("9,999.5"),
  null,
  { timeout: 20000 },
);
const delta = await page.textContent("#delta");
if (!delta?.includes("0.5")) fail(`expected a 0.5 delta, got: ${delta}`);
ok(`balance change detected on next poll (${delta.trim()})`);

// RPC URLs persist only after proven use (worker booted + balance fetched);
// specifier/watch persist as typed. After the successful run above, a reload
// must restore all four.
await page.reload();
if (
  (await page.inputValue("#bootstrap")) !== rpc ||
  (await page.inputValue("#worker-rpc")) !== rpc ||
  (await page.inputValue("#specifier")) !== specifier ||
  (await page.inputValue("#watch")) !== WATCH
) {
  fail("settings did not persist across reload after successful use");
}
ok("all settings persist across reload after successful use");

console.log("\n✅ site smoke test passed");
cleanup();
process.exit(0);
