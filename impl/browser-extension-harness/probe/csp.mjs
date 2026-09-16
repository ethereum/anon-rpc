// Does a sandboxed `srcdoc` iframe work inside an MV3 extension page?
//
// Run directly; prints what each isolation mechanism actually does, with the
// browser's own CSP messages rather than an inference from the spec.

import { chromium } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ext = await mkdtemp(resolve(tmpdir(), "csp-probe-"));

await writeFile(
  resolve(ext, "manifest.json"),
  JSON.stringify(
    {
      manifest_version: 3,
      name: "csp-probe",
      version: "0.0.1",
      // Only so Playwright can tell us the extension id.
      background: { service_worker: "sw.js", type: "module" },
      sandbox: { pages: ["packaged.html"] },
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

// The page that runs the experiments. Not inline — the extension_pages CSP
// forbids that too, which is itself half the point.
await writeFile(
  resolve(ext, "probe.html"),
  `<!doctype html><meta charset="utf-8"><title>probe</title><pre id="out">running</pre><script src="probe.js"></script>`,
);

await writeFile(
  resolve(ext, "probe.js"),
  `
const results = {};
const done = () => { document.getElementById("out").textContent = JSON.stringify(results, null, 1); };

function tryFrame(label, apply, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.display = "none";
    const onMsg = (ev) => {
      if (ev.source !== iframe.contentWindow) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      results[label] = "RAN: " + JSON.stringify(ev.data);
      resolve();
    };
    window.addEventListener("message", onMsg);
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      results[label] = "no message within " + timeoutMs + "ms (script never ran)";
      resolve();
    }, timeoutMs);
    apply(iframe);
    document.body.appendChild(iframe);
  });
}

(async () => {
  // 1. What the browser harness does on a web page: srcdoc + inline script.
  await tryFrame("srcdoc + inline script", (f) => {
    f.srcdoc = '<!doctype html><meta charset="utf-8"><script>parent.postMessage({ran:true, origin:String(location.origin)}, "*")<\\/script>';
  });

  // 2. The same, but the inline script also tries a blob: Worker — the second
  //    thing the harness needs and the first thing a strict CSP takes away.
  await tryFrame("srcdoc + blob worker", (f) => {
    f.srcdoc = '<!doctype html><meta charset="utf-8"><script>try{const b=new Blob(["postMessage(1)"],{type:"text/javascript"});const w=new Worker(URL.createObjectURL(b));parent.postMessage({ran:true,worker:"created"},"*")}catch(e){parent.postMessage({ran:true,worker:"ERR "+e.message},"*")}<\\/script>';
  });

  // 3. What this package does instead: a page declared in sandbox.pages.
  await tryFrame("packaged sandbox page", (f) => {
    f.src = chrome.runtime.getURL("packaged.html");
  });

  done();
})();
`,
);

// The packaged, manifest-declared sandboxed page.
await writeFile(
  resolve(ext, "packaged.html"),
  `<!doctype html><meta charset="utf-8"><script src="packaged.js"></script>`,
);
await writeFile(
  resolve(ext, "packaged.js"),
  `
let worker = "not tried";
try {
  const b = new Blob(["postMessage(1)"], { type: "text/javascript" });
  new Worker(URL.createObjectURL(b));
  worker = "created";
} catch (e) {
  worker = "ERR " + e.message;
}
parent.postMessage({ ran: true, origin: String(location.origin), worker }, "*");
`,
);

const profile = await mkdtemp(resolve(tmpdir(), "csp-profile-"));
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
  timeout: 30_000,
});

console.log("\n=== what each isolation mechanism does inside an MV3 extension page ===\n");
console.log(await page.textContent("#out"));
console.log("\n=== the browser's own CSP complaints ===\n");
console.log(errors.length ? errors.join("\n") : "(none)");

await context.close();
await rm(ext, { recursive: true, force: true });
await rm(profile, { recursive: true, force: true });
