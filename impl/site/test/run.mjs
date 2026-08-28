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
import JSON5 from "json5";
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

// The header is generated from one source rather than copied into each shell.
// It was copied before, and had already drifted — three pages linked "Spec" at
// themselves — so the sameness is worth asserting rather than trusting.
{
  const pages = ["index", "demo", "spec", "wallets", "networks", "adopters"];
  let canonical;
  for (const slug of pages) {
    const html = await readFile(
      `${SITE}dist/${slug === "index" ? "index.html" : `${slug}/index.html`}`,
      "utf8",
    );
    if (html.includes("<!--NAV-->")) fail(`/${slug} still contains the unreplaced NAV slot`);
    const nav = html.match(/<nav class="nav-links">[\s\S]*?<\/nav>/)?.[0];
    if (!nav) fail(`/${slug} has no nav`);
    // The depth prefix and which link is current are the only legitimate
    // per-page differences; normalize both away and the rest must be identical.
    const shape = nav.replaceAll("../", "").replaceAll(' aria-current="page"', "");
    canonical ??= { slug, shape };
    if (shape !== canonical.shape) fail(`/${slug} nav differs from /${canonical.slug} nav`);
    // The landing page is reached by the brand mark, so it has no nav link of
    // its own to mark; every other page must mark exactly one.
    const marked = [...nav.matchAll(/aria-current="page"/g)].length;
    const want = slug === "index" ? 0 : 1;
    if (marked !== want) fail(`/${slug} marks ${marked} nav links current, want ${want}`);
  }
  ok(`all ${pages.length} pages share one generated nav, each marking its own link current`);
}

// The wallet guide's quick start is generated per known worker: every
// deployment in adopters.json5 must have a tab and a code panel carrying
// its own address, or the guide is advertising a stale one.
{
  const known = JSON5.parse(await readFile(`${IMPL}../adopters.json5`, "utf8")).workers;
  const html = await readFile(`${SITE}dist/wallets/index.html`, "utf8");
  if (html.includes("WORKER_PICKER")) fail("/wallets/ still contains the picker markers");
  for (const w of known) {
    if (!html.includes(`id="worker-tab-${w.id}"`)) fail(`/wallets/ picker has no tab for ${w.id}`);
    if (!html.includes(`id="worker-panel-${w.id}"`)) fail(`/wallets/ picker has no panel for ${w.id}`);
    if (!html.includes(w.specifier)) fail(`/wallets/ picker is missing ${w.id}'s specifier address`);
    const gateway = w.exampleConfig?.gateways?.[0];
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

// The adopters directory is the third consumer of adopters.json5. It is the
// page that advertises addresses to strangers, so a missing or stale entry here
// is worse than on the other two: assert every field it publishes.
{
  const file = JSON5.parse(await readFile(`${IMPL}../adopters.json5`, "utf8"));
  const html = await readFile(`${SITE}dist/adopters/index.html`, "utf8");
  if (html.includes("<!--ADOPTERS_HTML-->")) fail("/adopters/ still contains the unreplaced slot");
  for (const w of file.workers) {
    if (!html.includes(`id="worker-${w.id}"`)) fail(`/adopters/ has no entry for ${w.id}`);
    if (!html.includes(w.specifier)) fail(`/adopters/ is missing ${w.id}'s specifier address`);
    if (!html.includes(`?worker=${w.id}`)) fail(`/adopters/ has no demo link for ${w.id}`);
    const gateway = w.exampleConfig?.gateways?.[0];
    if (gateway && !html.includes(gateway)) fail(`/adopters/ omits ${w.id}'s config gateway`);
    // A worker that does not anonymize must be labelled as such on this page.
    const badge = w.kind === "reference" ? "Reference worker" : "Anonymizing network";
    if (!html.includes(badge)) fail(`/adopters/ is missing the "${badge}" badge for ${w.id}`);
  }
  const listed = [...html.matchAll(/id="adopter-([\w-]+)"/g)].map(([, id]) => id);
  if (listed.join() !== file.walletsAndApps.map((a) => a.id).join()) {
    fail(`/adopters/ wallet list doesn't match adopters.json5 (got [${listed}])`);
  }
  if (file.walletsAndApps.length === 0 && !html.includes("No shipping integrations listed yet")) {
    fail("/adopters/ has no adopters and no empty state saying so");
  }
  // Two distinct calls to action: integrate (for those who haven't), and get
  // listed (for those who have) — the latter pointing at the file, which
  // documents its own fields in comments.
  for (const id of ["become", "get-listed"]) {
    if (!html.includes(`id="${id}"`)) fail(`/adopters/ is missing the "${id}" section`);
  }
  if (!html.includes("adopters.json5")) fail("/adopters/ doesn't name the file to open a PR against");
  ok(`/adopters/ lists ${file.workers.length} networks and ${file.walletsAndApps.length} wallets/apps`);
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

// The demo's preset picker is driven by the same adopters.json5 as the
// wallet guide: every entry, plus the demo-only "custom" option.
{
  const known = JSON5.parse(await readFile(`${IMPL}../adopters.json5`, "utf8")).workers;
  const options = await page.$$eval("#preset option", (os) => os.map((o) => o.value));
  const want = [...known.map((w) => w.id), "custom"];
  if (options.join(",") !== want.join(",")) {
    fail(`demo presets don't match adopters.json5 (got ${options}, want ${want})`);
  }
  ok(`demo preset picker lists the known workers (${options.join(", ")})`);

  // Every /adopters/ entry links here as `?worker=<id>`; the link is only worth
  // publishing if it actually arrives on that worker. Run in a throwaway
  // context so the preset it persists can't leak into the boot test below, and
  // aim at a worker that is not the default, so selection is provable.
  const target = known[known.length - 1];
  const ctx = await browser.newContext();
  const linked = await ctx.newPage();
  await linked.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
  });
  await linked.goto(`${siteUrl}/demo/?worker=${target.id}`);
  const got = {
    preset: await linked.inputValue("#preset"),
    specifier: await linked.inputValue("#specifier"),
  };
  if (got.preset !== target.id || got.specifier !== target.specifier) {
    fail(`?worker=${target.id} did not select it (got ${JSON.stringify(got)})`);
  }
  ok(`/demo/?worker=<id> selects that worker (${target.id})`);

  // The config field is one textarea of arbitrary JSON for every preset: an
  // entry's example config is its starting value, and anything without one
  // starts blank — including "custom", and including a switch away from a
  // worker that had one (a leftover config would be sent to the next worker).
  for (const id of [...known.map((w) => w.id), "custom"]) {
    await linked.selectOption("#preset", id);
    const shown = await linked.inputValue("#config");
    const example = known.find((w) => w.id === id)?.exampleConfig;
    // Compared parsed, not as text: the box is free to format the JSON however
    // reads best, so long as it is that entry's config and nothing else.
    if (example === undefined) {
      if (shown !== "") fail(`demo config box for ${id} should be blank, got ${JSON.stringify(shown)}`);
    } else if (JSON.stringify(JSON.parse(shown)) !== JSON.stringify(example)) {
      fail(`demo config box for ${id} doesn't hold its example config (got ${JSON.stringify(shown)})`);
    }
  }
  // Unparseable JSON must be refused before a worker is ever constructed,
  // rather than surfacing later as an opaque startup failure.
  await linked.fill("#config", "{ not json");
  await linked.fill("#specifier", target.specifier);
  await linked.fill("#bootstrap", rpc);
  await linked.fill("#worker-rpc", rpc);
  await linked.click("#toggle");
  const detail = await linked.textContent("#detail");
  if (!/config must be valid JSON/.test(detail ?? "")) {
    fail(`invalid config JSON was not reported (status: ${detail})`);
  }
  await ctx.close();
  ok("demo config box holds each preset's example JSON, and rejects invalid JSON");
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
