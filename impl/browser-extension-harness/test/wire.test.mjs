// The one part of this package that can be tested without a browser: the codec
// that gets bytes across extension messaging intact.
//
// It is worth its own test because the failure it guards against is silent.
// Under JSON serialisation — still the default; structured clone is opt-in and
// only from Chrome 148 — a Uint8Array does not throw on the way through, it
// arrives as `{"0":72,"1":105}`. Something that looks like data, is not data,
// and produces a confusing error much later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// btoa/atob exist in Node 22 globals, so the browser module runs as-is.
const out = await build({
  entryPoints: [resolve(HERE, "../src/wire.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
  logLevel: "warning",
});
const tmp = resolve(HERE, ".wire.built.mjs");
await writeFile(tmp, out.outputFiles[0].text);
const { toB64, fromB64, toWireError } = await import(tmp);
// rmSync, not the promise version: an `exit` handler runs to completion
// synchronously and nothing async in it ever finishes, so the async form
// leaves the artifact behind — and then someone commits it.
process.on("exit", () => rmSync(tmp, { force: true }));

test("bytes survive the round trip", () => {
  for (const bytes of [
    new Uint8Array([0]),
    new Uint8Array([0, 1, 2, 253, 254, 255]),
    new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":"0x1312d00"}'),
  ]) {
    assert.deepEqual(fromB64(toB64(bytes)), bytes);
  }
});

test("empty and absent bodies are both undefined, not empty strings", () => {
  // The distinction matters at the far side: `undefined` means "no body", and
  // a zero-length body is the same thing to `fetch`.
  assert.equal(toB64(undefined), undefined);
  assert.equal(toB64(new Uint8Array(0)), undefined);
  assert.equal(fromB64(undefined), undefined);
});

test("a body larger than the argument-stack limit round-trips", () => {
  // The naive String.fromCharCode(...bytes) overflows somewhere around 100k
  // arguments — which is to say, on real response bodies and not on test ones.
  const big = new Uint8Array(512 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const round = fromB64(toB64(big));
  assert.equal(round.length, big.length);
  assert.deepEqual(round.subarray(0, 1024), big.subarray(0, 1024));
  assert.deepEqual(round.subarray(big.length - 1024), big.subarray(big.length - 1024));
});

test("base64 is what makes this necessary: JSON alone mangles a Uint8Array", () => {
  // The bug this codec exists to prevent, demonstrated rather than asserted in
  // a comment. Note it does not throw — that is the whole problem.
  const bytes = new Uint8Array([72, 105]);
  const viaJson = JSON.parse(JSON.stringify(bytes));
  assert.deepEqual(viaJson, { 0: 72, 1: 105 });
  assert.ok(!(viaJson instanceof Uint8Array));
  // Via the codec, it is still bytes.
  assert.deepEqual(fromB64(JSON.parse(JSON.stringify(toB64(bytes)))), bytes);
});

test("error codes cross intact so a host can branch on them (§12)", () => {
  const e = Object.assign(new Error("nope"), { code: "permission-denied", name: "RpcError" });
  assert.deepEqual(toWireError(e), {
    name: "RpcError",
    message: "nope",
    code: "permission-denied",
  });
  // A non-Error still produces the §12 shape rather than throwing.
  assert.deepEqual(toWireError("boom"), { name: "Error", message: "boom" });
  // A numeric `code` is dropped rather than passed off as a §12 code string.
  assert.deepEqual(toWireError(Object.assign(new Error("x"), { code: 42 })), {
    name: "Error",
    message: "x",
  });
});
