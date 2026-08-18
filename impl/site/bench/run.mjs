// anon-rpc latency benchmark.
//
// Answers the question adopters actually ask — "what does routing my RPC
// through this cost me?" — with two separate numbers per arm:
//
//   bootstrap    one-time cost to reach a usable client (specifier read from
//                mainnet, bundle fetched and keccak-verified, worker running)
//   per-request  steady-state cost of one eth_getBalance thereafter
//
// Conflating those makes tor-js look far worse than it is, so they never share
// a statistic here.
//
// Method notes, because the numbers are only as good as these:
//
//   * Arms are INTERLEAVED, round-robin, one sample each per round. Running all
//     of one arm and then all of another lets RPC-side drift masquerade as a
//     difference between arms. `direct` runs in every round as the control, so
//     each round carries its own baseline.
//   * Distributions, not means. Tor is heavy-tailed and the tail is what a user
//     feels; a mean hides exactly the thing they would complain about.
//   * Failed samples are discarded but COUNTED. With a public RPC the discard
//     rate is itself a result.
//   * The live mainnet specifier path is measured, not a locally pinned bundle:
//     the chain read and resolver fetch are part of what an adopter pays.
//
// On passthrough's overhead: it is a CORS preflight per request, because the
// worker's opaque origin cannot use the page origin's preflight cache. This is
// scoped to workers that fulfil calls with the BROWSER's fetch — passthrough is
// the reference worker, so it does. Anonymizing workers bring their own
// transport and are unaffected: probe-preflight.mjs shows tor-js making zero
// requests through the browser's HTTP stack, preflight or otherwise.
//
// Not measured yet: BANDWIDTH. tor-js's traffic rides a WebRTC data channel
// inside a null-origin iframe, where neither CDP nor getStats() can see it from
// the driving page. The right instrument is byte counters in the KPS gateway,
// which is a change to tor-js-gateway rather than something this script can do.
//
// Usage:
//   BENCH_RPC_URL=<url> node bench/run.mjs [--n 50] [--rpc URL] [--out results.json]
//                      [--summary-md summary.md]

import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const KNOWN_WORKERS = require("../../../known-workers.json").workers;

// The beacon deposit contract, as the demo watches: a large balance that
// changes constantly, so nothing can be served from a trivially warm cache.
const WATCH = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const N = Number(arg("n", 50));
// A stalled arm must cost that arm, not the run: page.evaluate has no timeout
// of its own, so an arm that never boots would hang here indefinitely.
const BOOT_TIMEOUT_MS = Number(arg("boot-timeout", 60_000));
const SAMPLE_TIMEOUT_MS = Number(arg("sample-timeout", 30_000));
// No endpoint is baked in: in CI it comes from the BENCH_RPC_URL secret, and
// locally from the same env var or --rpc. Keeping it out of the tree also means
// swapping providers — or pointing at a controlled endpoint — needs no commit.
const RPC = arg("rpc", process.env.BENCH_RPC_URL);
const OUT = arg("out", null);
const SUMMARY_MD = arg("summary-md", null);

// Every known worker becomes an arm, so a newly published worker is measured
// without touching this file. `direct` is the control: no harness at all.
const ARMS = [
  { id: "direct" },
  ...KNOWN_WORKERS.map((w) => ({ id: w.id, specifier: w.specifier, config: w.config })),
];

const t0 = performance.now();
const stage = (m) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`);

if (!RPC) {
  console.error(
    "❌ no RPC endpoint. Pass --rpc <url> or set BENCH_RPC_URL.\n" +
    "   In CI this comes from the BENCH_RPC_URL repository secret.",
  );
  process.exit(1);
}

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch {} });
process.on("exit", cleanup);
const fail = (m) => { console.error(`❌ ${m}`); cleanup(); process.exit(1); };

/** p-th percentile of a sorted array, nearest-rank. */
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN;

// --- vite dev server: the bench page is dev-only by design, never built ---

// Vite's own API rather than spawning `npx vite` and screen-scraping its
// stdout for a port. The subprocess version failed in CI with nothing but
// "did not start within 30s", because a banner that never matched the regex
// is indistinguishable from a server that never came up — and it needed a
// detached process group to avoid orphaning the real server behind npx.
// None of that applies when the server is in-process.
stage("starting vite…");
const SITE_DIR = new URL("..", import.meta.url).pathname;
const vite = await createServer({
  configFile: `${SITE_DIR}vite.config.js`,
  root: `${SITE_DIR}src`,
  server: { port: 0 },
  logLevel: "warn",
});
await vite.listen();
cleanups.push(() => vite.close());
const baseUrl = vite.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
if (!baseUrl) fail("vite started but reported no local URL");

stage(`vite up at ${baseUrl}`);

// --- browser ---

const browser = await chromium.launch();
stage("browser launched");
cleanups.push(() => browser.close());
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error(`  page error: ${m.text()}`);
});
// NOT networkidle: vite dev holds an HMR websocket open, so "no network for
// 500ms" may never become true and this would sit until the goto timeout.
await page.goto(`${baseUrl}/bench/`, { waitUntil: "domcontentloaded" });
stage("page loaded");
await page.waitForFunction(() => typeof window.__bench?.boot === "function", null, { timeout: 30_000 });
stage("bench harness ready");

// --- phase 1: boot each arm once, timed ---

console.log(`\nanon-rpc bench — n=${N} per arm, eth_getBalance on ${WATCH.slice(0, 10)}…`);
console.log(`RPC: ${new URL(RPC).host}\n`);
console.log("booting arms (live mainnet specifier path)…");

const boots = [];
for (const armDef of ARMS) {
  stage(`booting ${armDef.id}…`);
  const [b] = await Promise.race([
    page.evaluate(([arms, rpc]) => window.__bench.boot(arms, rpc), [[armDef], RPC]),
    new Promise((r) => setTimeout(() => r([{ id: armDef.id, ok: false, bootMs: BOOT_TIMEOUT_MS, error: `boot timed out after ${BOOT_TIMEOUT_MS}ms` }]), BOOT_TIMEOUT_MS)),
  ]);
  boots.push(b);
}

for (const b of boots) {
  if (!b.ok) console.log(`  ✗ ${b.id}: ${b.error}`);
  else if (b.id !== "direct") console.log(`  ✓ ${b.id}: ${b.bootMs.toFixed(0)}ms`);
}
const live = boots.filter((b) => b.ok).map((b) => b.id);
const deadArms = boots.filter((b) => !b.ok);
// A worker that cannot boot is a measurement — reliability is part of what this
// reports — so a dead arm is recorded rather than treated as a broken run. Only
// a run where nothing at all came up has nothing to say.
if (live.length === 0) fail("no arm booted — nothing measured");

// --- phase 2: interleaved steady-state samples ---

console.log(`\nsampling ${N} rounds, arms interleaved…`);
const samples = [];
for (let round = 0; round < N; round++) {
  // Rotate which arm leads each round so a fixed arm never always benefits (or
  // suffers) from being first after the inter-round gap.
  const order = live.map((_, i) => live[(i + round) % live.length]);
  for (const id of order) {
    const s = await Promise.race([
      page.evaluate(
        ([armId, rpc, watch]) => window.__bench.sample(armId, rpc, watch),
        [id, RPC, WATCH],
      ),
      new Promise((r) => setTimeout(
        () => r({ id, ok: false, ms: SAMPLE_TIMEOUT_MS, error: `timed out after ${SAMPLE_TIMEOUT_MS}ms` }),
        SAMPLE_TIMEOUT_MS,
      )),
    ]);
    samples.push({ round, ...s });
  }
  if ((round + 1) % 10 === 0) process.stdout.write(`  ${round + 1}/${N}\n`);
}

// --- report ---

console.log("\n--- bootstrap (one-time) ---\n");
console.log("arm".padEnd(14) + "cost");
for (const b of boots.filter((b) => b.ok && b.id !== "direct")) {
  console.log(b.id.padEnd(14) + `${b.bootMs.toFixed(0)}ms`);
}

console.log("\n--- per-request (steady state) ---\n");
console.log(
  "arm".padEnd(14) + "n".padEnd(6) + "p50".padEnd(10) + "p90".padEnd(10) +
  "p99".padEnd(10) + "discarded",
);

const summary = [];
for (const id of ARMS.map((a) => a.id)) {
  const dead = deadArms.find((b) => b.id === id);
  if (dead) {
    summary.push({ arm: id, n: 0, p50: NaN, p90: NaN, p99: NaN, discarded: 0, bootFailed: dead.error });
    console.log(id.padEnd(14) + `did not boot — ${dead.error}`);
    continue;
  }
  const mine = samples.filter((s) => s.id === id);
  const okMs = mine.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const discarded = mine.length - okMs.length;
  const row = {
    arm: id,
    n: okMs.length,
    p50: pct(okMs, 50),
    p90: pct(okMs, 90),
    p99: pct(okMs, 99),
    discarded,
  };
  summary.push(row);
  const ms = (v) => (Number.isNaN(v) ? "—" : `${v.toFixed(0)}ms`);
  console.log(
    id.padEnd(14) + String(row.n).padEnd(6) + ms(row.p50).padEnd(10) +
    ms(row.p90).padEnd(10) + ms(row.p99).padEnd(10) +
    (discarded ? `${discarded} (${((discarded / mine.length) * 100).toFixed(0)}%)` : "0"),
  );
}

// The overhead an integrator is actually deciding about: each arm against the
// control from the same run, not against a remembered number.
const control = summary.find((r) => r.arm === "direct");
if (control && !Number.isNaN(control.p50)) {
  console.log("\n--- overhead vs direct (p50) ---\n");
  for (const r of summary.filter((r) => r.arm !== "direct" && !Number.isNaN(r.p50))) {
    const d = r.p50 - control.p50;
    console.log(`${r.arm.padEnd(14)}+${d.toFixed(0)}ms  (${(r.p50 / control.p50).toFixed(1)}×)`);
  }
}

const errors = [...new Set(samples.filter((s) => !s.ok).map((s) => `${s.id}: ${s.error}`))];
if (errors.length) {
  console.log("\ndiscard reasons:");
  for (const e of errors) console.log(`  ${e}`);
}

if (OUT) {
  await writeFile(OUT, JSON.stringify({
    // No Date.now() in the payload beyond this stamp: everything else is a
    // measured duration, so a re-run is comparable without re-normalising.
    ranAt: new Date().toISOString(),
    rpcHost: new URL(RPC).host,
    watch: WATCH,
    n: N,
    boots,
    summary,
    samples,
  }, null, 2));
  console.log(`\nraw samples → ${OUT}`);
}

if (SUMMARY_MD) {
  const ms = (v) => (Number.isNaN(v) ? "—" : `${v.toFixed(0)}ms`);
  const bootOf = (id) => {
    const b = boots.find((x) => x.id === id);
    if (!b || id === "direct") return "—";
    // A boot failure is the row's result, so it is stated in the cell rather
    // than relegated to a footnote under the table.
    return b.ok ? `${b.bootMs.toFixed(0)}ms` : `**did not boot** — ${b.error}`;
  };
  const md = [
    `### anon-rpc bench — n=${N} per arm`,
    "",
    `\`eth_getBalance\` on \`${WATCH}\` via \`${new URL(RPC).host}\`.`,
    "",
    "| arm | bootstrap | p50 | p90 | p99 | discarded |",
    "|---|---|---|---|---|---|",
    ...summary.map((r) =>
      `| ${r.arm} | ${bootOf(r.arm)} | ${ms(r.p50)} | ${ms(r.p90)} | ${ms(r.p99)} | ${r.discarded} |`),
    "",
    "An arm that did not boot is a result, not a broken run: whether a worker comes",
    "up at all is part of what this measures, and the schedule is what makes that",
    "visible over time.",
    "",
    "Bootstrap is one sample per arm and varies widely between runs — treat it as",
    "indicative, not a measurement. Bandwidth is not measured: tor-js's bytes ride a",
    "WebRTC data channel and need counters in the KPS gateway.",
    "",
  ].join("\n");
  await writeFile(SUMMARY_MD, md);
  console.log(`summary → ${SUMMARY_MD}`);
}

console.log("\nnote: bandwidth is not measured — tor-js's bytes ride a WebRTC data");
console.log("channel inside a null-origin iframe, so they need gateway-side counters.\n");

// Teardown, awaited — cleanup() is synchronous, so the unawaited browser.close()
// it would fire leaves Playwright's transport open and the process hanging after
// the report is printed. Exit explicitly: by this point every number is out, and
// waiting on whatever handle remains only costs the caller their terminal.
await browser.close().catch(() => {});
cleanup();
process.exit(0);
