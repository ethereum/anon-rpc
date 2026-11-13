import { test } from "node:test";
import assert from "node:assert/strict";
import { copyConnectSrc, workerCsp } from "../src/connect-src.js";

test("copyConnectSrc passes undefined and copies a valid list", () => {
  assert.equal(copyConnectSrc(undefined), undefined);
  const list = ["https://rpc.example", "wss:", "'self'"];
  const copy = copyConnectSrc(list);
  assert.deepEqual(copy, list);
  assert.notEqual(copy, list);
});

test("copyConnectSrc refuses entries that would add expressions or directives", () => {
  for (const bad of [["https://a.example https://b.example"], ["https://a.example; script-src *"], ["a,b"], [""], [42], "https://a.example"]) {
    assert.throws(() => copyConnectSrc(bad), TypeError, JSON.stringify(bad));
  }
});

test("workerCsp confines connections and script loads", () => {
  assert.equal(
    workerCsp(["https://rpc.example", "wss:"]),
    "default-src 'none'; script-src blob: data: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src blob:; connect-src https://rpc.example wss:",
  );
  assert.match(workerCsp([]), /connect-src 'none'$/);
});
