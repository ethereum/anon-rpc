// Builds the library: one ESM file per module, not a single bundle. Consumers
// bundle this into very different places — the browser harness's worker
// runtime needs only the error helpers, and a single file would hand it the
// §4 code and keccak with them. Separate modules plus `sideEffects: false` let
// a consumer's bundler keep only what it imports. Types are emitted by tsc
// after this (package.json).

import { build } from "esbuild";
import { mkdir, readdir, rm } from "node:fs/promises";

// Fresh dist every build, so renamed sources leave no stale .d.ts behind.
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const sources = (await readdir("src")).filter((f) => f.endsWith(".ts"));
await build({
  entryPoints: sources.map((f) => `src/${f}`),
  outdir: "dist",
  bundle: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});
