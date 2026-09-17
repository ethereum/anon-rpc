// Builds the demo extension twice over: as an unpacked directory you can load
// straight into Chrome, and as the .zip the site offers for download.
//
//   dist/unpacked/                        chrome://extensions → Load unpacked
//   dist/anon-rpc-demo-extension.zip      what the site links to
//
// The four harness assets are copied from @anon-rpc/browser-extension-harness
// rather than written here, so this directory is also a worked example of the
// install step that package's README describes.

import { build } from "esbuild";
import { cp, mkdir, copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import JSON5 from "json5";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const OUT = resolve(HERE, "dist");
const UNPACKED = resolve(OUT, "unpacked");
const ZIP_NAME = "anon-rpc-demo-extension.zip";

await rm(OUT, { recursive: true, force: true });
await mkdir(UNPACKED, { recursive: true });

/* --- the harness's packaged assets -------------------------------------- */

const harnessStatic = resolve(
  dirname(require.resolve("@anon-rpc/browser-extension-harness/package.json")),
  "dist/static",
);
try {
  await readdir(harnessStatic);
} catch {
  throw new Error(
    `@anon-rpc/browser-extension-harness has not been built (${harnessStatic} is missing). ` +
      "Run `npm run build --workspaces` first.",
  );
}
// Recursive, and the tree is kept as-is: the assets arrive in an `anon-rpc/`
// directory of the package's own naming, which is where the harness's default
// offscreenUrl and iframeUrl point.
await cp(harnessStatic, UNPACKED, { recursive: true });

/* --- the demo's own code ------------------------------------------------ */

// adopters.json5 is the repo's single list of published workers. It is parsed
// here and injected, because no bundler reads JSON5 natively.
const adopters = JSON5.parse(await readFile(resolve(HERE, "../../adopters.json5"), "utf8"));

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
  // Everything is bundled: these files are loaded from chrome-extension:// URLs
  // where bare specifiers do not resolve.
  define: { __ADOPTERS__: JSON.stringify({ workers: adopters.workers ?? [] }) },
};

await build({ ...common, entryPoints: [resolve(HERE, "src/background.ts")], outfile: resolve(UNPACKED, "background.js") });
await build({ ...common, entryPoints: [resolve(HERE, "src/popup.ts")], outfile: resolve(UNPACKED, "popup.js") });
await copyFile(resolve(HERE, "src/popup.html"), resolve(UNPACKED, "popup.html"));
await copyFile(resolve(HERE, "src/popup.css"), resolve(UNPACKED, "popup.css"));

/* --- the manifest ------------------------------------------------------- */

// Version comes from package.json so there is one place to bump, and the
// `//`-prefixed keys are stripped: they are there to explain the manifest in
// the repo, and Chrome warns about unrecognised keys.
const pkg = JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(HERE, "manifest.json"), "utf8"));
const strip = (v) =>
  Array.isArray(v)
    ? v.map(strip)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("//")).map(([k, x]) => [k, strip(x)]))
      : v;
const shipped = { ...strip(manifest), version: pkg.version };
await writeFile(resolve(UNPACKED, "manifest.json"), JSON.stringify(shipped, null, 2) + "\n");

/* --- the archive -------------------------------------------------------- */

// Entry order is sorted so the archive is byte-stable across builds. The walk
// is recursive and entry names keep their `anon-rpc/` prefix: extracting the
// archive has to reproduce the directory the manifest and the harness defaults
// both name.
const { zip } = await import("./zip.mjs");
const files = (await filesUnder(UNPACKED)).sort();
const archive = zip(
  await Promise.all(files.map(async (name) => ({ name, data: await readFile(resolve(UNPACKED, name)) }))),
);
await writeFile(resolve(OUT, ZIP_NAME), archive);

const kb = (n) => `${(n / 1024).toFixed(1)}kb`;
console.log(`\n  dist/unpacked/            ${files.length} files`);
console.log(`  dist/${ZIP_NAME}  ${kb(archive.length)}\n`);
console.log("build complete");

/** Every file under `dir`, as paths relative to it and always `/`-separated. */
async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    out.push(relative(dir, resolve(e.parentPath, e.name)).split(sep).join("/"));
  }
  return out;
}
