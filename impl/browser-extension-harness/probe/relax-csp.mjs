import { chromium } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Can an extension simply allow inline script for its own pages? If it could,
// srcdoc would work and no packaged sandbox page would be needed.
for (const csp of [
  "script-src 'self' 'unsafe-inline'; object-src 'self'",
  "script-src 'self' 'unsafe-eval'; object-src 'self'",
  "script-src 'self' blob:; object-src 'self'",
]) {
  const ext = await mkdtemp(resolve(tmpdir(), "relax-"));
  await writeFile(
    resolve(ext, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "relax",
      version: "0.0.1",
      background: { service_worker: "sw.js", type: "module" },
      content_security_policy: { extension_pages: csp },
    }),
  );
  await writeFile(resolve(ext, "sw.js"), "// anchor\n");
  const profile = await mkdtemp(resolve(tmpdir(), "relax-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    args: ["--no-sandbox", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let loaded = false;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 8000 });
    loaded = !!sw;
  } catch {
    loaded = false;
  }
  console.log(`${loaded ? "LOADED  " : "REJECTED"}  extension_pages: ${csp}`);
  await context.close();
  await rm(ext, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
