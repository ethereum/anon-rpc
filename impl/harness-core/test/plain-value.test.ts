// §9.4 plain values: what is accepted, how it is copied, and what is refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyPlainValue, decodePlain, encodePlain } from "../src/plain-value.js";
import type { AnonFetch } from "../src/spec-types.js";

// §9.1: AnonFetch must stay usable wherever a plain fetch is expected.
const _assignable: typeof fetch = (async () => new Response()) as AnonFetch;
void _assignable;

test("primitives and numbers are delivered exactly", () => {
  for (const v of [undefined, null, true, false, "", "s", 0, 1.5, NaN, Infinity, -Infinity]) {
    assert.ok(Object.is(copyPlainValue(v), v), String(v));
  }
  assert.ok(Object.is(copyPlainValue(-0), -0), "-0 stays -0");
});

test("objects and arrays are deep copies", () => {
  const src = { a: [1, { b: "c" }], d: { e: null } };
  const out = copyPlainValue(src) as typeof src;
  assert.deepEqual(out, src);
  assert.notEqual(out, src);
  assert.notEqual(out.a, src.a);
  assert.notEqual(out.a[1], src.a[1]);
});

test("an undefined property is delivered as a present, undefined property", () => {
  const out = copyPlainValue({ a: undefined }) as Record<string, unknown>;
  assert.ok("a" in out);
  assert.equal(out.a, undefined);
});

test("array holes become undefined; non-index keys are dropped", () => {
  const arr: unknown[] = [1, , 3]; // eslint-disable-line no-sparse-arrays
  (arr as unknown as Record<string, unknown>).extra = "x";
  const out = copyPlainValue(arr) as unknown[];
  assert.equal(out.length, 3);
  assert.ok(1 in out, "hole is filled");
  assert.equal(out[1], undefined);
  assert.equal((out as unknown as Record<string, unknown>).extra, undefined);
});

test("null-prototype objects are plain; copies get Object.prototype", () => {
  const src = Object.assign(Object.create(null), { a: 1 });
  const out = copyPlainValue(src) as object;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual({ ...out }, { a: 1 });
});

test('a "__proto__" key stays an own property', () => {
  const src = JSON.parse('{"__proto__": {"polluted": true}}');
  const out = copyPlainValue(src) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.hasOwn(out, "__proto__"));
  assert.equal((out as { polluted?: unknown }).polluted, undefined);
});

test("symbol keys and non-enumerable properties are not copied", () => {
  const src: Record<string | symbol, unknown> = { a: 1, [Symbol("s")]: 2 };
  Object.defineProperty(src, "hidden", { value: 3, enumerable: false });
  assert.deepEqual(Reflect.ownKeys(copyPlainValue(src) as object), ["a"]);
});

test("Uint8Array (and subclasses) become a plain Uint8Array of just the view", () => {
  const backing = new Uint8Array([0, 1, 2, 3, 4]);
  const view = backing.subarray(1, 3);
  const out = copyPlainValue(view) as Uint8Array;
  assert.equal(Object.getPrototypeOf(out), Uint8Array.prototype);
  assert.deepEqual([...out], [1, 2]);
  assert.equal(out.byteOffset, 0);
  assert.equal(out.buffer.byteLength, 2);
  backing[1] = 9;
  assert.equal(out[0], 1, "a copy, not a view");

  const buf = Buffer.from([7, 8]);
  const fromBuf = copyPlainValue(buf) as Uint8Array;
  assert.equal(Object.getPrototypeOf(fromBuf), Uint8Array.prototype);
  assert.deepEqual([...fromBuf], [7, 8]);
});

test("ArrayBuffer is copied; resizable sources become fixed-length", () => {
  const ab = new Uint8Array([1, 2, 3]).buffer;
  const out = copyPlainValue(ab) as ArrayBuffer;
  assert.ok(out instanceof ArrayBuffer);
  assert.notEqual(out, ab);
  assert.deepEqual([...new Uint8Array(out)], [1, 2, 3]);

  // ES2024 API, newer than this package's lib target.
  const Resizable = ArrayBuffer as unknown as new (n: number, o: { maxByteLength: number }) => ArrayBuffer;
  const out2 = copyPlainValue(new Resizable(2, { maxByteLength: 8 })) as { resizable?: boolean };
  assert.equal(out2.resizable, false);
});

test("detached buffers are refused", () => {
  const ab = new ArrayBuffer(4);
  structuredClone(ab, { transfer: [ab] });
  assert.throws(() => copyPlainValue(ab), TypeError);
  const view = new Uint8Array(4);
  structuredClone(view.buffer, { transfer: [view.buffer] });
  assert.throws(() => copyPlainValue(view), TypeError);
});

test("values reachable twice are copied independently", () => {
  const shared = { x: 1 };
  const out = copyPlainValue({ a: shared, b: [shared] }) as { a: object; b: object[] };
  assert.deepEqual(out.a, { x: 1 });
  assert.notEqual(out.a, out.b[0]);
});

test("cycles are refused with a TypeError, not a hang", () => {
  const obj: Record<string, unknown> = { a: 1 };
  obj.self = obj;
  assert.throws(() => copyPlainValue(obj, "config"), {
    name: "TypeError",
    message: /config\.self .*contains itself/,
  });
  const arr: unknown[] = [];
  arr.push([arr]);
  assert.throws(() => copyPlainValue(arr), TypeError);
});

test("everything else is refused with a TypeError naming the path", () => {
  const refused: [string, unknown][] = [
    ["function", () => {}],
    ["symbol", Symbol("s")],
    ["bigint", 1n],
    ["Date", new Date()],
    ["Map", new Map()],
    ["Set", new Set()],
    ["RegExp", /x/],
    ["Uint16Array", new Uint16Array(1)],
    ["DataView", new DataView(new ArrayBuffer(1))],
    ["SharedArrayBuffer", new SharedArrayBuffer(1)],
    ["class instance", new (class Foo {})()],
    ["boxed string", new String("s")],
  ];
  for (const [label, v] of refused) {
    assert.throws(() => copyPlainValue({ deep: [v] }, "init.x"), {
      name: "TypeError",
      message: /^init\.x\.deep\[0\] is not a plain value/,
    }, label);
  }
});

// encodePlain/decodePlain: a JSON-only hop (extension messaging, the QuickJS
// guest) must deliver every plain value as itself. JSON.parse(JSON.stringify())
// stands in for the hop.
const viaJson = (v: unknown): any => decodePlain(JSON.parse(JSON.stringify(encodePlain(v))));

test("plain values survive JSON exactly, including what JSON loses", () => {
  for (const n of [NaN, Infinity, -Infinity, -0, 0, 1.5]) assert.ok(Object.is(viaJson(n), n), String(n));
  assert.equal(viaJson(undefined), undefined);
  const obj = viaJson({ a: undefined, b: [1, undefined, null], s: "x" });
  assert.ok("a" in obj && obj.a === undefined, "undefined property stays present");
  assert.deepEqual(obj.b, [1, undefined, null]);
  const bytes = viaJson({ u8: new Uint8Array([1, 2, 255]), ab: new Uint8Array([3]).buffer, empty: new Uint8Array(0) });
  assert.ok(bytes.u8 instanceof Uint8Array);
  assert.deepEqual([...bytes.u8], [1, 2, 255]);
  assert.ok(bytes.ab instanceof ArrayBuffer && !(bytes.ab instanceof Uint8Array));
  assert.deepEqual([...new Uint8Array(bytes.ab)], [3]);
  assert.equal(bytes.empty.byteLength, 0);
});

test('a "__proto__" key crosses as an own property', () => {
  const out = viaJson(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.hasOwn(out, "__proto__"));
  assert.equal(out.polluted, undefined);
});

test("holes become undefined; a value reachable twice is copied twice", () => {
  const shared = { x: 1 };
  // eslint-disable-next-line no-sparse-arrays
  const out = copyPlainValue({ arr: [1, , 3], a: shared, b: shared }) as any;
  assert.ok(1 in out.arr);
  assert.notEqual(out.a, out.b);
});

test("non-plain values and cycles fail with a TypeError naming the path", () => {
  for (const v of [1n, Symbol("s"), () => {}, new Date(), new Map(), new Uint16Array(1), new (class Foo {})()]) {
    assert.throws(() => encodePlain({ k: [v] }, "config"), { name: "TypeError", message: /^config\.k\[0\] is not a plain value/ });
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => encodePlain(cyclic, "config"), { name: "TypeError", message: /config\.self .*contains itself/ });
});
