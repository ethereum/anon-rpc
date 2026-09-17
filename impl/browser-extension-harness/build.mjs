// Builds the package's three execution contexts plus the files an extension
// copies into its own package:
//
//   dist/background.js                        ESM — imported by the service worker
//   dist/offscreen.js                         ESM — imported by an offscreen document
//   dist/static/anon-rpc/<stamp>/offscreen.{html,js}  — a ready-made offscreen document
//   dist/static/anon-rpc/<stamp>/sandbox.{html,js}    — the §6 sandboxed page
//
// The install step copies the whole `anon-rpc` directory into an extension, so
// the files land together rather than loose among the extension's own pages.
//
// ## Why the assets sit in a version-stamped directory
//
// `background.js` is imported from node_modules and rebuilt by the
// integrator's bundler, so it tracks the installed version automatically. The
// two static files are COPIES, and copies do not update themselves. They are
// the far half of a protocol whose near half is in background.js, so an
// upgrade that re-bundles one and not the other pairs mismatched halves — and
// the symptom is not an error: `mount.ts` ignores messages it does not
// recognise and nothing on the boot path has a timeout, so `worker.ready`
// simply never settles.
//
// Stamping the version into the PATH removes the failure mode rather than
// reporting it. background.js resolves `anon-rpc/<stamp>/offscreen.html` from
// its own build, so a stale copy is not a subtly wrong file, it is a missing
// one — and assets.ts turns that into a sentence naming the fix.
//
// The stamp is `<package version>-<8 hex of the asset bytes>`. A content hash
// rather than a commit sha because a published tarball carries no git context
// and a sha lies on a dirty tree, and because the bytes are what has to match.
// The version is in front so a human can read the directory.
//
// The integrator's manifest does NOT need updating per version: `sandbox.pages`
// honours wildcards, so `anon-rpc/*/sandbox.html` is written once. That is
// measured, not assumed — see probe/sandbox-glob.mjs.
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
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const outdir = "dist";
/** The directory an extension ends up with, name included. */
const ASSET_DIR = "anon-rpc";
/** Assets are built here, then moved under their stamp once it can be computed. */
const staging = `${outdir}/.assets`;
await rm(outdir, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

const { version } = JSON.parse(await readFile("package.json", "utf8"));

const common = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  logLevel: "info",
};

/* --- the copied assets, first: the stamp is computed from their bytes ---- */

// The packaged offscreen document's script: fully bundled, because it is loaded
// from a chrome-extension:// URL where bare specifiers do not resolve.
await build({
  ...common,
  entryPoints: ["src/offscreen/document.ts"],
  outfile: `${staging}/offscreen.js`,
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
await copyFile(bootSrc, `${staging}/sandbox.js`);

// The two HTML pages.
for (const f of await readdir(`static/${ASSET_DIR}`)) {
  await copyFile(`static/${ASSET_DIR}/${f}`, `${staging}/${f}`);
}

// The stamp. Names are hashed alongside contents, so adding or renaming a file
// changes it too — otherwise two different sets of assets could share a stamp.
const assetFiles = (await readdir(staging)).sort();
const digest = createHash("sha256");
for (const f of assetFiles) {
  digest.update(f);
  digest.update(await readFile(resolve(staging, f)));
}
const stamp = `${version}-${digest.digest("hex").slice(0, 8)}`;
const assetPath = `${ASSET_DIR}/${stamp}`;

const staticOut = `${outdir}/static/${assetPath}`;
await mkdir(staticOut, { recursive: true });
for (const f of assetFiles) await copyFile(resolve(staging, f), resolve(staticOut, f));
await rm(staging, { recursive: true, force: true });

/* --- the library entries, which must know where the assets landed -------- */

const define = {
  __ASSET_PATH__: JSON.stringify(assetPath),
  __PKG_VERSION__: JSON.stringify(version),
};

await build({
  ...common,
  define,
  entryPoints: ["src/background/index.ts"],
  outfile: `${outdir}/background.js`,
  packages: "external",
  sourcemap: true,
});
await build({
  ...common,
  define,
  entryPoints: ["src/offscreen/index.ts"],
  outfile: `${outdir}/offscreen.js`,
  packages: "external",
  sourcemap: true,
});

console.log(`build complete — assets at ${assetPath}/ (${assetFiles.length} files)`);
