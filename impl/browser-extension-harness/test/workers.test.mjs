// The two host-side modes, driven without a browser: `chrome` is a fake whose
// port the test answers as the offscreen document would, and PageWorker's
// browser harness is a stand-in that records what it was handed. Each test
// pins a review finding on the integration, which the protocol tests alone
// would not catch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = await build({
  stdin: {
    contents: `
      export { OffscreenWorker } from "../src/background/OffscreenWorker.ts";
      export { PageWorker } from "../src/page/PageWorker.ts";
      export { calls } from "@anon-rpc/browser-harness";
    `,
    resolveDir: HERE,
    loader: "ts",
  },
  alias: { "@anon-rpc/browser-harness": resolve(HERE, "fake-browser-harness.mjs") },
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
  logLevel: "warning",
});
const tmp = resolve(HERE, ".workers.built.mjs");
await writeFile(tmp, out.outputFiles[0].text);
process.on("exit", () => rmSync(tmp, { force: true }));

/* --- a fake extension context -------------------------------------------- */

const ports = [];
function fakePort() {
  const listeners = [];
  const port = {
    name: "anon-rpc.worker",
    sent: [],
    postMessage: (m) => port.sent.push(JSON.parse(JSON.stringify(m))),
    disconnect() {},
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener() {} },
    /** Deliver a message as the offscreen document would. */
    deliver: (m) => setTimeout(() => listeners.forEach((fn) => fn(JSON.parse(JSON.stringify(m)))), 0),
    /** Resolve with the next sent message matching `pred`. */
    async next(pred) {
      for (let i = 0; i < 200; i++) {
        const hit = port.sent.find(pred);
        if (hit) {
          port.sent.splice(port.sent.indexOf(hit), 1);
          return hit;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("expected message never sent");
    },
  };
  return port;
}
globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://test/${p.replace(/^\//, "")}`,
    connect: () => {
      const p = fakePort();
      ports.push(p);
      return p;
    },
    onConnect: { addListener() {} },
  },
};
// assertAssetPresent fetches the packaged pages; they are "there".
globalThis.fetch = async () => ({ ok: true });

const { OffscreenWorker, PageWorker, calls } = await import(tmp);
const provider = { request: async () => "0x" };

async function offscreenWorker() {
  const before = ports.length;
  const w = new OffscreenWorker({ address: "0x00", preExisting: { rpcProvider: provider }, offscreenUrl: false });
  for (let i = 0; ports.length === before && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
  return { w, port: ports[ports.length - 1] };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

/* --- the findings ---------------------------------------------------------- */

test("Firefox mode copies forwarded options when fetch is called (§9.1)", async () => {
  const w = new PageWorker({ address: "0x00", preExisting: { rpcProvider: provider } });
  for (const whenReady of [false, true]) {
    if (whenReady) await w.ready;
    calls.length = 0;
    const init = { anonOptions: { isolationKey: "account-A" } };
    const pending = w.fetch("https://rpc.test/", init);
    init.anonOptions.isolationKey = "account-B"; // an options object reused for the next account
    await pending;
    assert.equal(calls[0].anonOptions.isolationKey, "account-A", whenReady ? "after ready" : "while booting");
  }
});

test("Firefox mode rejects a non-plain option immediately, without reaching the harness", async () => {
  const w = new PageWorker({ address: "0x00", preExisting: { rpcProvider: provider } });
  calls.length = 0;
  await assert.rejects(w.fetch("https://rpc.test/", { anonOptions: { isolationKey: 1n } }), TypeError);
  assert.equal(calls.length, 0);
});

test("a rejected streaming upload cancels and releases the caller's stream", async () => {
  const { w, port } = await offscreenWorker();
  let cancelled;
  const body = new ReadableStream({
    pull: (c) => c.enqueue(new Uint8Array([1])),
    cancel: (reason) => void (cancelled = reason ?? "(no reason)"),
  });
  const pending = w.fetch("https://rpc.test/", { method: "POST", body, duplex: "half" });
  const fetchMsg = await port.next((m) => m.t === "fetch");
  assert.equal(fetchMsg.bodyStream, true);
  port.deliver({ t: "response", callId: fetchMsg.callId, ok: false, error: { name: "Error", message: "worker said no" } });
  await assert.rejects(pending, /worker said no/);
  await tick();
  assert.ok(cancelled, "the upload's source was cancelled");
  w.close();
});

test("a streamed response removes its abort listener once the body is done", async () => {
  const { w, port } = await offscreenWorker();
  const ac = new AbortController();
  let listeners = 0;
  const add = ac.signal.addEventListener.bind(ac.signal);
  const remove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = (...a) => (listeners++, add(...a));
  ac.signal.removeEventListener = (...a) => (listeners--, remove(...a));

  for (let i = 0; i < 3; i++) {
    const pending = w.fetch("https://rpc.test/", { signal: ac.signal });
    const { callId } = await port.next((m) => m.t === "fetch");
    port.deliver({ t: "response", callId, ok: true, status: 200, headers: [], hasBody: true });
    const res = await pending;
    const text = res.text();
    await port.next((m) => m.t === "body.pull" && m.callId === callId);
    port.deliver({ t: "body.chunk", ch: "response", callId, data: btoa("hi") });
    await port.next((m) => m.t === "body.pull" && m.callId === callId);
    port.deliver({ t: "body.end", ch: "response", callId });
    assert.equal(await text, "hi");
  }
  assert.equal(listeners, 0, "every call's abort listener was removed");

  // And a later abort sends nothing for calls that are already complete.
  port.sent.length = 0;
  ac.abort();
  await tick();
  assert.deepEqual(port.sent.filter((m) => m.t === "abort"), []);
  w.close();
});
