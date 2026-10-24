import { test } from "node:test";
import assert from "node:assert/strict";
import { CallQueue } from "../src/call-queue.js";

test("delivers queued items in FIFO order", async () => {
  const q = new CallQueue<number>();
  q.push(1);
  q.push(2);
  q.push(3);
  assert.equal(await q.take(), 1);
  assert.equal(await q.take(), 2);
  assert.equal(await q.take(), 3);
});

test("pending take resolves when an item arrives", async () => {
  const q = new CallQueue<string>();
  const p = q.take();
  q.push("x");
  assert.equal(await p, "x");
});

test("aborted take is withdrawn and never consumes an item (§8)", async () => {
  const q = new CallQueue<string>();
  const ac = new AbortController();
  const aborted = q.take(ac.signal);
  ac.abort();
  await assert.rejects(aborted, (e: Error) => e.name === "AbortError");
  // The next push must not vanish into the dead waiter.
  q.push("survivor");
  assert.equal(await q.take(), "survivor");
});

test("pre-aborted signal rejects immediately", async () => {
  const q = new CallQueue<string>();
  await assert.rejects(q.take(AbortSignal.abort()), (e: Error) => e.name === "AbortError");
});

test("concurrent takes are served FIFO, none stranded", async () => {
  const q = new CallQueue<number>();
  const t1 = q.take();
  const t2 = q.take();
  q.push(10);
  q.push(20);
  assert.equal(await t1, 10);
  assert.equal(await t2, 20);
});

test("abort of one pending take leaves the others live", async () => {
  const q = new CallQueue<number>();
  const ac = new AbortController();
  const dead = q.take(ac.signal);
  const live = q.take();
  ac.abort();
  await assert.rejects(dead);
  q.push(42);
  assert.equal(await live, 42);
});

test("pushFront returns an item to the head of the queue", async () => {
  const q = new CallQueue<string>();
  q.push("second");
  q.pushFront("first");
  assert.equal(await q.take(), "first");
  assert.equal(await q.take(), "second");
});

test("pushFront delivers to a pending take", async () => {
  const q = new CallQueue<string>();
  const p = q.take();
  q.pushFront("x");
  assert.equal(await p, "x");
});

test("remove withdraws only not-yet-delivered items", async () => {
  const q = new CallQueue<string>();
  q.push("a");
  q.push("b");
  assert.equal(q.remove("a"), true);
  assert.equal(q.remove("a"), false); // already removed
  assert.equal(await q.take(), "b");
});

test("rejectAll rejects pending takes", async () => {
  const q = new CallQueue<string>();
  const pending = q.take();
  q.rejectAll(new Error("closed"));
  await assert.rejects(pending, /closed/);
});

test("rejectAll clears queued items", async () => {
  const q = new CallQueue<string>();
  q.push("dropped");
  q.rejectAll(new Error("closed"));
  // Nothing left to take: this take only ends via the abort below.
  // (AbortSignal.timeout would not keep the event loop alive.)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20);
  await assert.rejects(q.take(ac.signal), (e: Error) => e.name === "AbortError");
  clearTimeout(timer);
});
