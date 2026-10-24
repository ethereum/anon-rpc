// The package's test entry: unit tests for the wire codec, the body stream
// protocol and the two host modes against a fake `chrome`, then the e2es.
//
// The split matters. The codec can be checked anywhere; everything else about
// this package is a browser-extension mechanic that only a browser can answer,
// so the e2es are not optional colour — they are the test. The Firefox one
// skips itself unless FIREFOX_BIN and GECKODRIVER point at a Firefox and
// a geckodriver (CI provides both).

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
await run("body-stream.test.mjs", "body stream tests");
await run("workers.test.mjs", "host-mode tests");
await run("e2e.mjs", "extension e2e");
await run("e2e-firefox.mjs", "Firefox extension e2e");
