import { test } from "node:test";
import assert from "node:assert/strict";
import { toResponse } from "../src/host/AnonRpcWorker.js";

const body = new TextEncoder().encode("{}");

test("Response.url is the request URL when the worker omits url", () => {
  const r = toResponse({ status: 200, headers: [], body }, "https://rpc.example/v1");
  assert.equal(r.url, "https://rpc.example/v1");
});

test("the fallback is serialized as fetch would: absolute, with a path", () => {
  const r = toResponse({ status: 200, headers: [], body }, "https://ethereum-rpc.publicnode.com");
  assert.equal(r.url, "https://ethereum-rpc.publicnode.com/");
});

test("Response.url is the worker's post-redirect URL when it reports one", () => {
  const r = toResponse({ status: 200, headers: [], body, url: "https://rpc.example/v2" }, "https://rpc.example/v1");
  assert.equal(r.url, "https://rpc.example/v2");
});
