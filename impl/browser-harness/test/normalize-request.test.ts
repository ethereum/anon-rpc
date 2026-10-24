import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest } from "../src/host/normalize-request.js";

const dec = new TextDecoder();

async function drain(body: Uint8Array | ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!body) return "";
  if (body instanceof Uint8Array) return dec.decode(body);
  return dec.decode(new Uint8Array(await new Response(body).arrayBuffer()));
}

test("bare string URL produces no requestInit", async () => {
  const n = await normalizeRequest("http://x.test/a");
  assert.equal(n.url, "http://x.test/a");
  assert.equal(n.requestInit, undefined);
  assert.equal(n.signal, undefined);
});

test("URL object input", async () => {
  const n = await normalizeRequest(new URL("http://x.test/b?q=1"));
  assert.equal(n.url, "http://x.test/b?q=1");
});

test("init with method/headers/string body", async () => {
  const n = await normalizeRequest("http://x.test/", {
    method: "POST",
    headers: { "x-a": "1" },
    body: "hello",
  });
  assert.equal(n.requestInit?.method, "POST");
  assert.deepEqual(n.requestInit?.headers, [["x-a", "1"]]);
  assert.ok(n.requestInit?.body instanceof Uint8Array);
  assert.equal(await drain(n.requestInit?.body), "hello");
  assert.equal(n.requestInit?.hasSignal, undefined);
});

test("init signal is surfaced and flagged", async () => {
  const ac = new AbortController();
  const n = await normalizeRequest("http://x.test/", { signal: ac.signal });
  assert.equal(n.signal, ac.signal);
  assert.equal(n.requestInit?.hasSignal, true);
});

test("ReadableStream body is passed through for transfer, not buffered", async () => {
  const stream = new Blob(["streamed"]).stream();
  const n = await normalizeRequest("http://x.test/", { method: "POST", body: stream });
  assert.equal(n.requestInit?.body, stream);
  assert.ok(n.transfer?.includes(stream as unknown as Transferable));
});

test("buffered URLSearchParams body keeps its derived content-type", async () => {
  const n = await normalizeRequest("http://x.test/", {
    method: "POST",
    body: new URLSearchParams({ a: "1", b: "2" }),
  });
  const ct = n.requestInit?.headers?.find(([k]) => k === "content-type")?.[1];
  assert.match(ct ?? "", /application\/x-www-form-urlencoded/);
  assert.equal(await drain(n.requestInit?.body), "a=1&b=2");
});

test("buffered FormData body keeps its multipart boundary content-type", async () => {
  const fd = new FormData();
  fd.append("field", "value");
  const n = await normalizeRequest("http://x.test/", { method: "POST", body: fd });
  const ct = n.requestInit?.headers?.find(([k]) => k === "content-type")?.[1];
  assert.match(ct ?? "", /multipart\/form-data; boundary=/);
});

test("caller-set content-type is not overridden by the derived one", async () => {
  const n = await normalizeRequest("http://x.test/", {
    method: "POST",
    headers: { "Content-Type": "text/custom" },
    body: new URLSearchParams({ a: "1" }),
  });
  const cts = n.requestInit?.headers?.filter(([k]) => k.toLowerCase() === "content-type");
  assert.deepEqual(cts, [["Content-Type", "text/custom"]]);
});

test("fresh buffers are transferred; caller-owned Uint8Array is not", async () => {
  const fromString = await normalizeRequest("http://x.test/", { method: "POST", body: "abc" });
  assert.ok(
    fromString.transfer?.includes((fromString.requestInit?.body as Uint8Array).buffer as ArrayBuffer),
    "string-derived body buffer should be in the transfer list",
  );

  const mine = new Uint8Array([1, 2, 3]);
  const fromBytes = await normalizeRequest("http://x.test/", { method: "POST", body: mine });
  assert.equal(fromBytes.transfer?.length, 0, "caller's own buffer must not be detached");
});

test("Request input carries method/headers/body/signal (§5 typeof fetch)", async () => {
  const req = new Request("http://x.test/req", {
    method: "POST",
    headers: { "x-b": "2" },
    body: "req-body",
  });
  const n = await normalizeRequest(req);
  assert.equal(n.url, "http://x.test/req");
  assert.equal(n.requestInit?.method, "POST");
  assert.ok(n.requestInit?.headers?.some(([k, v]) => k === "x-b" && v === "2"));
  assert.equal(n.requestInit?.hasSignal, true);
  assert.equal(n.signal, req.signal);
  // Request bodies are streams; it must be transferred, and carry the bytes.
  assert.ok(n.requestInit?.body instanceof ReadableStream);
  assert.ok(n.transfer?.length === 1);
  assert.equal(await drain(n.requestInit?.body), "req-body");
});

test("init overrides a Request input's fields", async () => {
  const req = new Request("http://x.test/req", { method: "POST", body: "orig" });
  const n = await normalizeRequest(req, { method: "PUT", body: "override" });
  assert.equal(n.requestInit?.method, "PUT");
  assert.equal(await drain(n.requestInit?.body), "override");
});

test("init entries §9.1 does not model are forwarded as plain values", async () => {
  const anonOptions = { isolationKey: "k1" };
  const n = await normalizeRequest("http://x.test/", {
    method: "POST",
    cache: "no-store",
    anonOptions,
    custom: { bytes: new Uint8Array([1]), missing: undefined },
  } as RequestInit);
  assert.deepEqual(n.requestInit?.forwarded, {
    cache: "no-store",
    anonOptions: { isolationKey: "k1" },
    custom: { bytes: new Uint8Array([1]), missing: undefined },
  });
  assert.notEqual(n.requestInit?.forwarded?.anonOptions, anonOptions, "copied, not shared");
  assert.equal(n.requestInit?.method, "POST");
  assert.ok(!("method" in (n.requestInit?.forwarded ?? {})), "modeled fields are not forwarded");
});

test("an init with no forwarded entries carries none", async () => {
  const n = await normalizeRequest("http://x.test/", { method: "GET" });
  assert.equal(n.requestInit?.forwarded, undefined);
});

test("forwarded values are copied when fetch is called, before any await", async () => {
  const anonOptions = { isolationKey: "before" };
  const pending = normalizeRequest("http://x.test/", {
    method: "POST",
    body: new Blob(["buffered asynchronously"]),
    anonOptions,
  } as RequestInit);
  anonOptions.isolationKey = "after";
  const n = await pending;
  assert.deepEqual(n.requestInit?.forwarded, { anonOptions: { isolationKey: "before" } });
});

test("a forwarded value that is not plain rejects with a TypeError", async () => {
  await assert.rejects(
    normalizeRequest("http://x.test/", { anonOptions: { isolationKey: 1n } } as unknown as RequestInit),
    { name: "TypeError", message: /init\.anonOptions\.isolationKey/ },
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(
    normalizeRequest("http://x.test/", { custom: cyclic } as RequestInit),
    TypeError,
  );
});

test("Request input: only init contributes forwarded entries", async () => {
  const req = new Request("http://x.test/req", { anonOptions: { isolationKey: "lost" } } as RequestInit);
  assert.equal((await normalizeRequest(req)).requestInit?.forwarded, undefined);
  const n = await normalizeRequest(req, { anonOptions: { isolationKey: "k" } } as RequestInit);
  assert.deepEqual(n.requestInit?.forwarded, { anonOptions: { isolationKey: "k" } });
});
