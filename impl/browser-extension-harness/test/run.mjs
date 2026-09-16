// The package's test entry: unit tests for the wire codec, then the e2e.
//
// The split matters. The codec can be checked anywhere; everything else about
// this package is a browser-extension mechanic that only Chromium can answer,
// so the e2e is not optional colour — it is the test.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = (file, label) =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, [resolve(HERE, file)], { stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${label} failed (exit ${c})`))));
  });

await run("wire.test.mjs", "wire tests");
await run("e2e.mjs", "extension e2e");
