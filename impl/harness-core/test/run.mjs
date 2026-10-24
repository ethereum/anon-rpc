// Bundles each *.test.ts with esbuild and runs them under node --test.
// (No ts-node/tsx dependency; esbuild is already the build toolchain.)

import { build } from "esbuild";
import { readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const HERE = new URL(".", import.meta.url).pathname;
const OUT = `${HERE}.tmp`;

await rm(OUT, { recursive: true, force: true });
const entryPoints = (await readdir(HERE)).filter((f) => f.endsWith(".test.ts")).map((f) => HERE + f);

await build({
  entryPoints,
  outdir: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  logLevel: "warning",
});

const outFiles = (await readdir(OUT)).filter((f) => f.endsWith(".test.js")).map((f) => `${OUT}/${f}`);
const p = spawn(process.execPath, ["--test", ...outFiles], { stdio: "inherit" });
p.on("exit", (code) => process.exit(code ?? 1));
