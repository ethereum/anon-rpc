// Builds the package's three execution contexts plus the files an extension
// copies into its own package:
//
//   dist/background.js                   ESM — imported by the service worker
//   dist/offscreen.js                    ESM — imported by an offscreen document
//   dist/static/anon-rpc/offscreen.{html,js}  — a ready-made offscreen document
//   dist/static/anon-rpc/sandbox.{html,js}    — the §6 sandboxed page
//
// The install step copies that whole `anon-rpc` directory into an extension,
// so the files land together rather than loose among the extension's own
// pages. The name is fixed here rather than chosen at copy time because the
// defaults in AnonRpcWorker.ts point at it.
//
// The two library entries keep npm dependencies external so consumers dedupe
// them. The two STATIC bundles do not: they are copied into an extension
// package and loaded by URL, where nothing resolves node_modules.
//
// sandbox.js is not built here at all — it is copied verbatim from the
// browser harness's own `dist/iframe-boot.js`. That is deliberate: the
// sandboxed page must run exactly the code the harness's `srcdoc` path runs,
// because the host half on the other side of the postMessage is identical. A
// re-bundle could drift; a copy cannot.

import { build } from "esbuild";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const outdir = "dist";
/** The directory an extension ends up with, name included. */
const ASSET_DIR = "anon-rpc";
const staticOut = `${outdir}/static/${ASSET_DIR}`;
await rm(outdir, { recursive: true, force: true });
await mkdir(staticOut, { recursive: true });

const common = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  logLevel: "info",
};

// Library entries: what an extension's own code imports.
await build({
  ...common,
  entryPoints: ["src/background/index.ts"],
  outfile: `${outdir}/background.js`,
  packages: "external",
  sourcemap: true,
});
await build({
  ...common,
  entryPoints: ["src/offscreen/index.ts"],
  outfile: `${outdir}/offscreen.js`,
  packages: "external",
  sourcemap: true,
});

// The packaged offscreen document's script: fully bundled, because it is loaded
// from a chrome-extension:// URL where bare specifiers do not resolve.
await build({
  ...common,
  entryPoints: ["src/offscreen/document.ts"],
  outfile: `${staticOut}/offscreen.js`,
});

// The sandboxed page's script, copied from the browser harness.
const require = createRequire(import.meta.url);
const bootSrc = resolve(
  dirname(require.resolve("@anon-rpc/browser-harness/package.json")),
  "dist/iframe-boot.js",
);
try {
  await stat(bootSrc);
} catch {
  throw new Error(
    `@anon-rpc/browser-harness has not been built (${bootSrc} is missing). ` +
      "Run `npm run build --workspaces` so its dist/iframe-boot.js exists.",
  );
}
await copyFile(bootSrc, `${staticOut}/sandbox.js`);

// The two HTML pages.
for (const f of await readdir(`static/${ASSET_DIR}`)) {
  await copyFile(`static/${ASSET_DIR}/${f}`, `${staticOut}/${f}`);
}

console.log("build complete");
