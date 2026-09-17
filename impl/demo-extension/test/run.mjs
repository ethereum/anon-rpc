// Loads the built demo extension into Chromium and drives its popup, then
// checks the archive the site hands out.
//
// The second half is not ceremony: the download link is the whole deliverable
// on the site side, and a corrupt or mis-structured zip is a broken link that
// no other test would notice.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";

const HERE = import.meta.dirname;
const PKG = resolve(HERE, "..");
const IMPL = resolve(PKG, "..");
const UNPACKED = resolve(PKG, "dist/unpacked");
const ZIP = resolve(PKG, "dist/anon-rpc-demo-extension.zip");
const BUNDLE = resolve(IMPL, "passthrough-worker/dist/passthrough-worker.js");

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

// Build everything: the extension embeds the harness assets and pins the
// passthrough bundle by the hash of its current bytes.
await new Promise((res, rej) => {
  const p = spawn("npm", ["run", "build", "--workspaces", "--if-present"], { cwd: IMPL, stdio: "ignore" });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error("build failed"))));
});

/* --- the archive -------------------------------------------------------- */

// Parsed here rather than shelling out to `unzip`, so the check holds on a
// machine that has no unzip.
{
  const buf = await readFile(ZIP);
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) await fail("zip has no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (dirOffset + dirSize > buf.length) await fail("zip central directory runs past the end of the file");

  const names = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) await fail(`zip central directory entry ${i} has a bad signature`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      await fail(`zip entry ${i} points at a bad local header`);
    }
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Walked independently of the build's own walk, so a bug in that one shows
  // up here rather than being agreed with.
  const onDisk = (await readdir(UNPACKED, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => relative(UNPACKED, resolve(e.parentPath, e.name)).split(sep).join("/"))
    .sort();
  if (names.sort().join(",") !== onDisk.join(",")) {
    await fail(`zip contents differ from dist/unpacked\n  zip: ${names}\n  dir: ${onDisk}`);
  }
  // The harness assets must arrive in their own directory, not loose among the
  // demo's pages — the manifest and the harness defaults both name it.
  if (!names.includes("anon-rpc/sandbox.html")) {
    await fail("archive has no anon-rpc/sandbox.html — the harness assets did not keep their directory");
  }
  // A zip cannot be "Load unpacked"ed, so the manifest has to be at the root
  // for the directory the user extracts to be loadable.
  if (!names.includes("manifest.json")) await fail("manifest.json is not at the archive root");
  ok(`archive is a valid zip: ${names.length} entries, ${(buf.length / 1024).toFixed(1)}kb, manifest at the root`);

  // Byte-stability: two builds of the same input must produce the same file,
  // or every deploy shows a spurious diff.
  const again = zipOf(await readFile(ZIP));
  if (again !== zipOf(buf)) await fail("zip is not byte-stable");
  function zipOf(b) {
    return Buffer.from(keccak_256(b)).toString("hex");
  }
}

/* --- the manifest ------------------------------------------------------- */

{
  const m = JSON.parse(await readFile(resolve(UNPACKED, "manifest.json"), "utf8"));
  const stale = Object.keys(m).filter((k) => k.startsWith("//"));
  if (stale.length) await fail(`manifest still carries comment keys: ${stale}`);
  if (JSON.stringify(m).includes('"//')) await fail("manifest still carries nested comment keys");
  if (!m.sandbox?.pages?.includes("anon-rpc/sandbox.html")) {
    await fail("manifest does not declare the sandbox page — worker code would run at the extension's origin");
  }
  if (!/blob:/.test(m.content_security_policy?.sandbox ?? "")) {
    await fail("sandbox CSP lacks blob:, so the worker bundle cannot be importScripts'd");
  }
  const pkg = JSON.parse(await readFile(resolve(PKG, "package.json"), "utf8"));
  if (m.version !== pkg.version) await fail(`manifest version ${m.version} != package ${pkg.version}`);
  ok(`manifest is shipping-clean: no comment keys, sandbox declared, version ${m.version}`);
}

/* --- a stub chain + resolver -------------------------------------------- */

const bundle = await readFile(BUNDLE);
const workerHash = "0x" + Buffer.from(keccak_256(bundle)).toString("hex");
const SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";
const WATCH = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

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
    const b = Buffer.from(s, "utf8");
    const padded = Math.ceil(b.length / 32) * 32;
    bodies += word(b.length) + b.toString("hex").padEnd(padded * 2, "0");
    cursor += 32 + padded;
  }
  return "0x" + head + offsets + bodies;
}

let specifierReads = 0;
let bundleFetches = 0;
let balanceCalls = 0;
let balance = 1234n * 10n ** 18n;

const server = createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
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
      /* answered as unknown below */
    }
    const send = (result) => {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, result }));
    };
    if (msg.method === "eth_call") {
      specifierReads++;
      const data = msg.params?.[0]?.data;
      if (data === selector("workerHash()")) return send("0x" + pad(workerHash));
      if (data === selector("workerResolvers()")) return send(encodeStringArray([`${ORIGIN}/worker.js`]));
    }
    if (msg.method === "eth_getBalance") {
      balanceCalls++;
      return send("0x" + balance.toString(16));
    }
    res.writeHead(404, cors);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
cleanups.push(() => new Promise((r) => server.close(r)));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* --- load it ------------------------------------------------------------ */

const profile = await mkdtemp(resolve(tmpdir(), "anon-rpc-demo-ext-"));
cleanups.push(() => rm(profile, { recursive: true, force: true }));

const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  // The full Chromium build: playwright's default headless is
  // chromium-headless-shell, which has no extension support and would load
  // nothing at all, silently.
  channel: "chromium",
  args: ["--no-sandbox", `--disable-extensions-except=${UNPACKED}`, `--load-extension=${UNPACKED}`],
});
cleanups.push(() => context.close());

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
const extensionId = new URL(sw.url()).host;
ok(`extension loaded (${extensionId})`);

const errors = [];

// The first entry of the popup's PUBLIC_RPCS list. The prefill probe asks each
// in order for eth_chainId and takes the first that answers as mainnet, so
// answering this one makes the probe deterministic.
const FIRST_PUBLIC_RPC = "https://ethereum-rpc.publicnode.com";
let probeHits = 0;

/**
 * The popup, opened as a tab. A real popup is the same document.
 *
 * Hermetic, like the site's demo test: nothing off 127.0.0.1 is reachable.
 * The one exception is the first public RPC the prefill probe tries, which is
 * answered here — so the probe is exercised rather than merely tolerated, and
 * it cannot depend on a live endpoint.
 */
async function openPopup() {
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(FIRST_PUBLIC_RPC)) {
      probeHits++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}',
      });
    }
    const parsed = new URL(url);
    // The popup's own document, script and stylesheet are chrome-extension://
    // URLs and must obviously be allowed — blocking them loads a blank page
    // whose every later assertion fails for the wrong reason.
    if (parsed.protocol === "chrome-extension:") return route.continue();
    const host = parsed.hostname;
    return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

const page = await openPopup();

// Fresh profile: the watch address and both RPC fields prefill themselves,
// exactly as the web demo does. The fields being empty is what a reader hits
// first, so it is worth asserting rather than assuming.
if ((await page.inputValue("#watch")) !== WATCH) {
  await fail("watch address did not prefill with the beacon deposit contract");
}
await page
  .waitForFunction(
    (rpc) =>
      document.querySelector("#bootstrap")?.value === rpc &&
      document.querySelector("#worker-rpc")?.value === rpc,
    FIRST_PUBLIC_RPC,
    { timeout: 20_000 },
  )
  .catch(() => {});
const prefilled = {
  bootstrap: await page.inputValue("#bootstrap"),
  workerRpc: await page.inputValue("#worker-rpc"),
};
if (prefilled.bootstrap !== FIRST_PUBLIC_RPC || prefilled.workerRpc !== FIRST_PUBLIC_RPC) {
  await fail(`RPC fields did not prefill from the probe: ${JSON.stringify(prefilled)}`);
}
if (probeHits < 1) await fail("the prefill probe made no request");
ok(`watch address and both RPC fields prefilled on a fresh profile (${FIRST_PUBLIC_RPC})`);

/* --- an RPC URL that never worked must not become the default ----------- */

// The web demo persists the two RPC URLs only once they have served. Checked
// before the successful run below, because afterwards the proven values would
// mask a failure to honour the rule.
await page.fill("#bootstrap", "http://127.0.0.1:1/dead");
await page.fill("#worker-rpc", "http://127.0.0.1:1/dead");
await page.fill("#specifier", SPECIFIER);
await page.click("#toggle");
await page.waitForFunction(() => document.getElementById("pill")?.textContent === "error", {
  timeout: 30_000,
}).catch(() => {});
if ((await page.textContent("#pill"))?.trim() !== "error") {
  await fail(`a dead bootstrap RPC did not report an error (pill: ${await page.textContent("#pill")})`);
}
{
  const after = await openPopup();
  // A failed start must also not leave the session "running" — that would make
  // the next popup resume polling a worker which never booted.
  if ((await after.textContent("#pill"))?.trim() === "watching") {
    await fail("popup resumed watching after a start that failed");
  }
  const kept = await after.inputValue("#bootstrap");
  if (kept.includes(":1/dead")) await fail(`an unproven bootstrap URL was persisted: ${kept}`);
  await after.close();
  ok("a bootstrap URL that never booted a worker is not persisted, and does not leave it 'running'");
}

await page.fill("#bootstrap", `${ORIGIN}/rpc`);
await page.fill("#worker-rpc", `${ORIGIN}/rpc`);
await page.fill("#specifier", SPECIFIER);
await page.fill("#watch", WATCH);
await page.fill("#config", "");
await page.click("#toggle");

await page.waitForFunction(() => !document.getElementById("balance-card")?.hidden, { timeout: 60_000 })
  .catch(() => {});
const shown = (await page.textContent("#balance")) ?? "";
if (!shown.includes("1,234")) {
  await fail(
    `popup did not show the balance (got "${shown.trim()}")\n` +
      `  status: ${(await page.textContent("#detail"))?.trim()}\n` +
      `  counters: specifierReads=${specifierReads} bundleFetches=${bundleFetches} balanceCalls=${balanceCalls}\n` +
      `  fields: ${JSON.stringify({
        bootstrap: await page.inputValue("#bootstrap"),
        workerRpc: await page.inputValue("#worker-rpc"),
        specifier: await page.inputValue("#specifier"),
      })}\n` +
      `  sw storage: ${JSON.stringify(
        await sw.evaluate(async () => ({
          local: await chrome.storage.local.get(null),
          session: await chrome.storage.session.get(null),
        })),
      )}\n` +
      `  sw reach: ${await sw.evaluate(async (o) => {
        try {
          const r = await fetch(`${o}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}',
          });
          return `ok ${r.status}`;
        } catch (e) {
          return `ERR ${e?.message ?? String(e)}`;
        }
      }, ORIGIN)}\n` +
      `  console: ${errors.join("\n")}`,
  );
}
if (specifierReads !== 2) await fail(`expected 2 specifier reads, got ${specifierReads}`);
if (bundleFetches !== 1) await fail(`expected 1 bundle fetch, got ${bundleFetches}`);
if (balanceCalls < 1) await fail("no eth_getBalance reached the stub chain");
ok(`popup watched a balance through the worker (${shown.trim().split(" ")[0]} ETH)`);
ok("§4 ran once: specifier read twice, bundle fetched and hash-verified once");

const bootNote = (await page.textContent("#boot-note")) ?? "";
if (!/cold boot/.test(bootNote)) await fail(`first boot should report cold, said: "${bootNote}"`);
ok(`first boot reported honestly: ${bootNote.trim()}`);

/* --- the point of the architecture: reopening is warm -------------------- */

// Closing the popup destroys its document, exactly as losing focus does. The
// worker lives in the offscreen document, so it should still be running — and
// reattaching must not re-read the specifier or re-fetch the bundle.
await page.close();
const readsBefore = specifierReads;
const fetchesBefore = bundleFetches;

balance += 5n * 10n ** 18n; // so the reopened popup has something new to show

const again = await openPopup();
await again.waitForFunction(() => document.getElementById("pill")?.textContent === "watching", {
  timeout: 60_000,
}).catch(() => {});
const resumed = (await again.textContent("#pill")) ?? "";
if (resumed.trim() !== "watching") {
  await fail(
    `reopened popup did not resume watching (pill: "${resumed.trim()}", detail: ${(await again.textContent("#detail"))?.trim()})`,
  );
}
if (specifierReads !== readsBefore || bundleFetches !== fetchesBefore) {
  await fail(
    `reopening re-booted the worker (specifier reads ${readsBefore}→${specifierReads}, ` +
      `bundle fetches ${fetchesBefore}→${bundleFetches})`,
  );
}
ok("reopened popup resumed watching with no re-read, no re-fetch, no re-verify");

await again.waitForFunction(() => /1,239/.test(document.getElementById("balance")?.textContent ?? ""), {
  timeout: 60_000,
}).catch(() => {});
const after = (await again.textContent("#balance")) ?? "";
if (!after.includes("1,239")) await fail(`reopened popup did not poll again (shows "${after.trim()}")`);
ok("…and kept polling: the new balance arrived through the same worker");

const fatal = errors.filter((t) => !/favicon|ERR_FILE_NOT_FOUND/i.test(t));
if (fatal.length) await fail(`console errors:\n${fatal.join("\n")}`);
ok("no console errors (CSP violations would appear here)");

console.log("\n✅ demo-extension tests passed");
await cleanup();
process.exit(0);
