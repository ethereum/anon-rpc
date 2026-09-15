// Builds the harness's two execution contexts:
//
//   host.js         ESM  — the library entry, run by the host application
//   worker-host.js  ESM  — the script `node --permission` runs INSIDE the
//                          confined child: it receives the verified bundle
//                          over IPC and gives it the §7 capability API
//
// Unlike the browser harness, worker-host is NOT inlined into host.js. There
// the null-origin iframe cannot load a host-origin script and must be handed
// source text; here the child is a real process that reads a real file, and
// the harness grants Landlock read access to this directory. A file on disk
// also means node parses it normally, so stack traces point at real lines.
//
// The Go launcher is built separately (`npm run build:launcher`) so that
// `npm run build --workspaces` does not require a Go toolchain.

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
};

// npm dependencies stay external in the host build so consumers dedupe them.
await build({
  ...common,
  entryPoints: ["src/host/index.ts"],
  outfile: `${outdir}/host.js`,
  packages: "external",
});

// worker-host runs with an empty environment inside a sandbox that grants read
// access to this file and nothing else of ours, so its dependencies are bundled
// in rather than resolved from node_modules at runtime.
await build({
  ...common,
  entryPoints: ["src/child/worker-host.ts"],
  outfile: `${outdir}/worker-host.js`,
});

console.log("build complete");
