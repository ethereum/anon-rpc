import { test } from "node:test";
import assert from "node:assert/strict";
import { copyForwardedEntries } from "../src/forwarded.js";

test("modeled members are not forwarded; everything else is, copied", () => {
  const anonOptions = { isolationKey: "k" };
  const out = copyForwardedEntries({
    method: "POST",
    headers: {},
    body: "x",
    redirect: "follow",
    signal: new AbortController().signal,
    cache: "no-store",
    anonOptions,
  });
  assert.deepEqual(out, { cache: "no-store", anonOptions: { isolationKey: "k" } });
  assert.notEqual(out!.anonOptions, anonOptions);
});

test("no forwarded entries, or no init, is undefined", () => {
  assert.equal(copyForwardedEntries({ method: "GET" }), undefined);
  assert.equal(copyForwardedEntries(undefined), undefined);
});

test("a non-plain entry throws a TypeError naming it", () => {
  assert.throws(() => copyForwardedEntries({ anonOptions: { isolationKey: 1n } }), {
    name: "TypeError",
    message: /^init\.anonOptions\.isolationKey is not a plain value/,
  });
});

test('a forwarded "__proto__" key stays an own property', () => {
  const out = copyForwardedEntries(JSON.parse('{"__proto__": "own"}'))!;
  assert.ok(Object.hasOwn(out, "__proto__"));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});
