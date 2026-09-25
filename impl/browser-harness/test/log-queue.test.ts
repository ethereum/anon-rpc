// §13.1 retention. The interesting cases are the ones where this queue
// deliberately differs from CallQueue: it drops, and it stays readable after
// close.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LogQueue } from "../src/host/log-queue.js";

test("delivers entries in the order they were produced (§13.1)", async () => {
  const q = new LogQueue<number>(10);
  q.push(1);
  q.push(2);
  q.push(3);
  assert.equal(await q.take(), 1);
  assert.equal(await q.take(), 2);
  assert.equal(await q.take(), 3);
});

test("a pending take resolves when an entry arrives", async () => {
  const q = new LogQueue<string>(10);
  const p = q.take();
  q.push("x");
  assert.equal(await p, "x");
});

test("drops the OLDEST once the retention bound is reached", async () => {
  const q = new LogQueue<number>(3);
  for (const n of [1, 2, 3, 4, 5]) q.push(n);
  assert.equal(q.size, 3);
  assert.equal(q.dropped, 2);
  // 1 and 2 are gone; what survives is the most recent window.
  assert.deepEqual([await q.take(), await q.take(), await q.take()], [3, 4, 5]);
});

test("a waiting taker is fed directly and never counts against the bound", async () => {
  const q = new LogQueue<number>(1);
  const p = q.take();
  q.push(1);
  q.push(2); // retained
  assert.equal(await p, 1);
  assert.equal(await q.take(), 2);
  assert.equal(q.dropped, 0);
});

test("aborted take is withdrawn without consuming an entry (§13.1)", async () => {
  const q = new LogQueue<string>(10);
  const ac = new AbortController();
  const aborted = q.take(ac.signal);
  ac.abort();
  await assert.rejects(aborted, (e: Error) => e.name === "AbortError");
  q.push("survivor");
  assert.equal(await q.take(), "survivor");
});

test("pre-aborted signal rejects immediately", async () => {
  const q = new LogQueue<string>(10);
  await assert.rejects(q.take(AbortSignal.abort()), (e: Error) => e.name === "AbortError");
});

test("entries retained at close stay readable, then take rejects (§13.1)", async () => {
  const q = new LogQueue<string>(10);
  q.push("still booting");
  q.push("about to fail");
  q.close(new Error("worker failed"));

  // The whole point: a worker's last words survive the failure they explain.
  assert.equal(await q.take(), "still booting");
  assert.equal(await q.take(), "about to fail");
  await assert.rejects(q.take(), /worker failed/);
});

test("close rejects the pending taker rather than hanging it", async () => {
  const q = new LogQueue<string>(10);
  const waiting = q.take();
  q.close(new Error("worker closed"));
  await assert.rejects(waiting, /worker closed/);
});

test("pushes after close are ignored", async () => {
  const q = new LogQueue<string>(10);
  q.close(new Error("gone"));
  q.push("too late");
  await assert.rejects(q.take(), /gone/);
});

test("concurrent takers are served in order, none stranded", async () => {
  const q = new LogQueue<number>(10);
  const takes = [q.take(), q.take(), q.take()];
  q.push(1);
  q.push(2);
  q.push(3);
  assert.deepEqual(await Promise.all(takes), [1, 2, 3]);
});
