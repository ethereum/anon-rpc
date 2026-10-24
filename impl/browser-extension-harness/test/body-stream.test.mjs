// The chunked body protocol (body-stream.ts), without a browser: two
// BodyStreams joined by an in-memory "port" that JSON-round-trips every
// message and delivers it asynchronously, as extension messaging does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(HERE, "../src/body-stream.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
  logLevel: "warning",
});
const tmp = resolve(HERE, ".body-stream.built.mjs");
await writeFile(tmp, out.outputFiles[0].text);
const { BodyStreams, MAX_CHUNK } = await import(tmp);
process.on("exit", () => rmSync(tmp, { force: true }));

/** Two contexts, each routing what the other sends it. */
function pair() {
  const sent = [];
  let a, b;
  const hop = (to) => (msg) => {
    sent.push(msg.t);
    const copy = JSON.parse(JSON.stringify(msg));
    setTimeout(() => to().route(copy), 0);
  };
  a = new BodyStreams(hop(() => b));
  b = new BodyStreams(hop(() => a));
  return { a, b, sent };
}

/** A source that records how many chunks were read from it, and its cancel. */
function source(chunks, { error } = {}) {
  const log = { reads: 0, cancelled: undefined };
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      log.reads++;
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else if (error) c.error(error);
      else c.close();
    },
    cancel(reason) {
      log.cancelled = reason ?? "(no reason)";
    },
  }, { highWaterMark: 0 });
  return { stream, log };
}

const bytes = (...n) => new Uint8Array(n);
const tick = () => new Promise((r) => setTimeout(r, 20));

test("chunks arrive in order, and the stream ends", async () => {
  const { a, b } = pair();
  const { stream } = source([bytes(1, 2), bytes(3), bytes(4, 5, 6)]);
  a.send("response", 1, stream);
  const got = [];
  for await (const c of b.receive("response", 1).stream) got.push(...c);
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6]);
});

test("backpressure: the sender reads no further ahead than the receiver asks", async () => {
  const { a, b } = pair();
  const { stream, log } = source(Array.from({ length: 10 }, (_, i) => bytes(i)));
  a.send("response", 1, stream);
  const reader = b.receive("response", 1).stream.getReader();
  await reader.read();
  await tick();
  // One chunk delivered, one read ahead (highWaterMark 1): nothing more.
  assert.ok(log.reads <= 2, `source was read ${log.reads} times for one chunk consumed`);
  reader.releaseLock();
});

test("a chunk larger than MAX_CHUNK is split, and its bytes survive", async () => {
  const { a, b, sent } = pair();
  const big = new Uint8Array(MAX_CHUNK * 2 + 7).map((_, i) => i % 251);
  a.send("response", 1, source([big]).stream);
  const parts = [];
  for await (const c of b.receive("response", 1).stream) parts.push(c);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.byteLength <= MAX_CHUNK));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) (joined.set(p, off), (off += p.byteLength));
  assert.deepEqual(joined, big);
  assert.equal(sent.filter((t) => t === "body.chunk").length, 3);
});

test("cancelling the received stream cancels the source, with the reason", async () => {
  const { a, b } = pair();
  const { stream, log } = source([bytes(1), bytes(2), bytes(3)]);
  a.send("response", 1, stream);
  const received = b.receive("response", 1).stream;
  const reader = received.getReader();
  await reader.read();
  await reader.cancel(new Error("not interested"));
  await tick();
  assert.equal(log.cancelled, "not interested");
});

test("a source error errors the received stream, name and message intact", async () => {
  const { a, b } = pair();
  a.send("response", 1, source([bytes(1)], { error: new TypeError("worker blew up") }).stream);
  const reader = b.receive("response", 1).stream.getReader();
  await reader.read();
  await assert.rejects(reader.read(), { name: "TypeError", message: "worker blew up" });
});

test("an abort errors the receiving side and cancels the sending side", async () => {
  const { a, b } = pair();
  const { stream, log } = source([bytes(1), bytes(2)]);
  a.send("request", 7, stream);
  const reader = b.receive("request", 7).stream.getReader();
  await reader.read();
  const reason = new DOMException("aborted", "AbortError");
  a.abort(7, reason);
  b.abort(7, reason);
  await assert.rejects(reader.read(), { name: "AbortError" });
  await tick();
  assert.ok(log.cancelled, "source was cancelled");
});

test("closeAll ends every body when the port goes away", async () => {
  const { a, b } = pair();
  a.send("response", 1, source([bytes(1), bytes(2)]).stream);
  const r1 = b.receive("response", 1).stream.getReader();
  const r2 = b.receive("response", 2).stream.getReader();
  b.closeAll(new Error("offscreen document disconnected"));
  await assert.rejects(r1.read(), /disconnected/);
  await assert.rejects(r2.read(), /disconnected/);
});

test("request and response bodies of one call do not cross wires", async () => {
  const { a, b } = pair();
  a.send("request", 1, source([bytes(1)]).stream);
  b.send("response", 1, source([bytes(2)]).stream);
  const req = [];
  const res = [];
  await Promise.all([
    (async () => { for await (const c of b.receive("request", 1).stream) req.push(...c); })(),
    (async () => { for await (const c of a.receive("response", 1).stream) res.push(...c); })(),
  ]);
  assert.deepEqual([req, res], [[1], [2]]);
});

test("an empty body ends without sending a chunk", async () => {
  const { a, b, sent } = pair();
  a.send("response", 1, source([new Uint8Array(0)]).stream);
  const got = [];
  for await (const c of b.receive("response", 1).stream) got.push(c);
  assert.equal(got.length, 0);
  assert.ok(!sent.includes("body.chunk"));
});
