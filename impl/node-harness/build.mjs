// Builds the harness's execution contexts:
//
//   host.js           ESM — the library entry, run by the host application
//   isolate-thread.js ESM — runs on a worker_thread and owns the QuickJS
//                           isolate the worker bundle executes in
//   worker-host.js    ESM — the SUPERSEDED node:vm + Landlock path, kept
//                           because its findings are still the reason the
//                           QuickJS one exists (see README.md)
//
// isolate-thread bundles its dependencies rather than resolving them at
// runtime, which matters for one of them in particular: the QuickJS variant
// ships its WASM as base64 inside a .mjs, so esbuild inlines the interpreter
// into this file and there is no .wasm to locate, load or grant access to.
//
// The Go launcher is built separately (`npm run build:launcher`) so that
// `npm run build --workspaces` does not require a Go toolchain. It is only
// needed for the superseded path.

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

const outdir = "dist";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  // prelude.guest.js is SOURCE TEXT for the QuickJS isolate, not a module of
  // this program: it is handed to the interpreter as a string. The text loader
  // is what stops esbuild from parsing, bundling or transpiling it — the
  // isolate's own parser is the only one that should ever see it.
  loader: { ".guest.js": "text" },
};

// npm dependencies stay external in the host build so consumers dedupe them.
await build({
  ...common,
  entryPoints: ["src/host/index.ts"],
  outfile: `${outdir}/host.js`,
  packages: "external",
});

// The isolate thread. Its dependencies — including the QuickJS interpreter —
// are bundled in, so the built file is self-contained.
await build({
  ...common,
  entryPoints: ["src/child/isolate-thread.ts"],
  outfile: `${outdir}/isolate-thread.js`,
});

// The superseded node:vm path, still built so its e2e keeps running.
await build({
  ...common,
  entryPoints: ["src/child/worker-host.ts"],
  outfile: `${outdir}/worker-host.js`,
});

console.log("build complete");
