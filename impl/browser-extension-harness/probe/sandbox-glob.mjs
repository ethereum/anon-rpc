// Does `sandbox.pages` accept a wildcard path?
//
// The question behind it: if the packaged assets live in a version-stamped
// directory (`anon-rpc/<version>-<hash>/`), the manifest has to name the
// sandboxed page inside it. Either `sandbox.pages` can match the directory
// with a pattern and the manifest is written once, or it cannot and every
// integrator edits their manifest on every upgrade.
//
// Run directly; prints what the browser does, not what the docs imply.
//
// Two things this has to get right to measure anything at all:
//
//   * The iframe carries NO `sandbox` attribute. That attribute produces an
//     opaque origin by itself, which is exactly the signal being measured —
//     the harness sets it in production, which is why neither the e2e nor
//     probe/csp.mjs can answer this question.
//   * `new Worker(blob:…)` does NOT throw when CSP forbids it. It fails
//     asynchronously through an error event, so a synchronous try/catch
//     reports success on a worker that never ran.
//
// So each case reports two independent signals, and a listed page should
// differ from the unlisted control in both:
//
//   origin  "null" = sandboxed by the manifest, "chrome-extension://…" = not
//   worker  did a blob: Worker actually start (the relaxed sandbox CSP)

import { chromium } from "playwright";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const EXACT_ONLY = process.argv.includes("--exact-only");

const ext = await mkdtemp(resolve(tmpdir(), "sandbox-glob-probe-"));

// Same page, five ways of being listed. The two controls bracket the result:
// whatever a wildcard does, it must differ from "not listed" to mean anything,
// and match "listed exactly" to be usable.
const CASES = [
  { label: "listed exactly, at the root", page: "root.html", listed: "root.html" },
  {
    label: "listed exactly, in a version dir",
    page: "exact/1.0.0-aaaabbbb/sandbox.html",
    listed: "exact/1.0.0-aaaabbbb/sandbox.html",
  },
  {
    label: "* for the version segment",
    page: "starseg/1.0.0-aaaabbbb/sandbox.html",
    listed: "starseg/*/sandbox.html",
  },
  {
    label: "* spanning segments",
    page: "starall/1.0.0-aaaabbbb/sandbox.html",
    listed: "starall/*",
  },
  { label: "NOT listed (control)", page: "control.html", listed: undefined },
];

const listed = CASES.map((c) => c.listed).filter((p) => p && (!EXACT_ONLY || !p.includes("*")));

await writeFile(
  resolve(ext, "manifest.json"),
  JSON.stringify(
    {
      manifest_version: 3,
      name: "sandbox-glob-probe",
      version: "0.0.1",
      background: { service_worker: "sw.js", type: "module" },
      sandbox: { pages: listed },
      content_security_policy: {
        sandbox:
          "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; child-src 'self' blob:; worker-src 'self' blob:;",
      },
    },
    null,
    2,
  ),
);
await writeFile(resolve(ext, "sw.js"), "// id anchor\n");

// Each page loads a sibling script — never an inline one. Inline is allowed by
// the sandbox CSP and forbidden by the extension_pages CSP, so an inline probe
// would go silent on exactly the pages it needs to report on.
const PAGE_SCRIPT = `
// eval is the decisive signal: 'unsafe-eval' is in the sandbox CSP and absent
// from MV3's default extension_pages CSP, and it fails synchronously.
let evalWorks;
try {
  evalWorks = eval("1+1") === 2 ? "allowed" : "odd result";
} catch (e) {
  evalWorks = "BLOCKED (" + e.constructor.name + ")";
}
const report = (worker) =>
  parent.postMessage({ origin: String(location.origin), eval: evalWorks, worker }, "*");
let w;
try {
  w = new Worker(URL.createObjectURL(new Blob(["postMessage('started')"], { type: "text/javascript" })));
} catch (e) {
  report("threw synchronously: " + e.message);
}
if (w) {
  // Both outcomes are asynchronous; whichever arrives first is the answer.
  w.onmessage = (e) => report("ran (" + e.data + ")");
  w.onerror = () => report("blocked (error event)");
  setTimeout(() => report("blocked (silent, no message and no error)"), 1500);
}
`;

for (const c of CASES) {
  await mkdir(resolve(ext, dirname(c.page)), { recursive: true });
  const script = c.page.replace(/\.html$/, ".js");
  await writeFile(
    resolve(ext, c.page),
    `<!doctype html><meta charset="utf-8"><script src="${script.split("/").pop()}"></script>`,
  );
  await writeFile(resolve(ext, script), PAGE_SCRIPT);
}

await writeFile(
  resolve(ext, "probe.html"),
  `<!doctype html><meta charset="utf-8"><title>probe</title><pre id="out">running</pre><script src="probe.js"></script>`,
);
await writeFile(
  resolve(ext, "probe.js"),
  `
const CASES = ${JSON.stringify(CASES)};
const results = {};

function load(c) {
  return new Promise((done) => {
    const iframe = document.createElement("iframe");
    // Deliberately NO sandbox attribute: see the header.
    iframe.style.display = "none";
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      results[c.label] = v;
      done();
    };
    const onMsg = (ev) => {
      if (ev.source !== iframe.contentWindow) return;
      finish(ev.data);
    };
    window.addEventListener("message", onMsg);
    const timer = setTimeout(() => finish("SILENT: the page or its script never ran"), 4000);
    iframe.src = chrome.runtime.getURL(c.page);
    document.body.appendChild(iframe);
  });
}

(async () => {
  for (const c of CASES) await load(c);
  document.getElementById("out").textContent = JSON.stringify(results, null, 1);
})();
`,
);

const profile = await mkdtemp(resolve(tmpdir(), "sandbox-glob-profile-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  args: ["--no-sandbox", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
const extId = new URL(sw.url()).host;

const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(`chrome-extension://${extId}/probe.html`);
await page.waitForFunction(() => document.getElementById("out")?.textContent !== "running", {
  timeout: 60_000,
});

console.log(`\n=== sandbox.pages entries as written${EXACT_ONLY ? " (--exact-only)" : ""} ===\n`);
console.log(JSON.stringify(listed, null, 1));
console.log("\n=== what each page got ===");
console.log('(origin "null" = the manifest sandboxed it)\n');
console.log(await page.textContent("#out"));
console.log("\n=== the browser's own complaints ===\n");
console.log(errors.length ? errors.join("\n") : "(none)");

await context.close();
await rm(ext, { recursive: true, force: true });
await rm(profile, { recursive: true, force: true });
