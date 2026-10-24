// Exercises the worker-side capability proxies over a real MessageChannel
// against a scripted "host" PortRpc, covering the acceptCall/respond wire
// contract without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PortRpc } from "../src/protocol.js";
import { makeWorkerApi } from "../src/worker/anon-rpc-worker-api.js";
import type { AnonRpcWorkerApi } from "../src/spec-types.js";

function setup(): { host: PortRpc; api: AnonRpcWorkerApi; close: () => void } {
  const ch = new MessageChannel();
  const host = new PortRpc(ch.port1 as unknown as MessagePort);
  const api = makeWorkerApi(new PortRpc(ch.port2 as unknown as MessagePort));
  return {
    host,
    api,
    close: () => {
      ch.port1.close();
      ch.port2.close();
    },
  };
}

test("config lands on the api; absent config is undefined (§7.1)", () => {
  const ch = new MessageChannel();
  const cfg = { network: "test", nested: { deep: [1, 2] } };
  const withCfg = makeWorkerApi(new PortRpc(ch.port1 as unknown as MessagePort), cfg);
  assert.deepEqual(withCfg.config, cfg);
  const without = makeWorkerApi(new PortRpc(ch.port2 as unknown as MessagePort));
  assert.equal(without.config, undefined);
  ch.port1.close();
  ch.port2.close();
});

test("signalReady reaches the host as an event", async () => {
  const { host, api, close } = setup();
  try {
    const ready = new Promise((resolve) => host.onEvent("ready", resolve));
    api.signalReady();
    await ready;
  } finally {
    close();
  }
});

test("signalFailed reaches the host with the structured reason (§7)", async () => {
  const { host, api, close } = setup();
  try {
    const failed = new Promise((resolve) => host.onEvent("failed", resolve));
    api.signalFailed({ code: "bad-config", message: "no network configured" });
    assert.deepEqual(await failed, { reason: { code: "bad-config", message: "no network configured" } });
  } finally {
    close();
  }
});

test("acceptCall delivers a fetch call; respond round-trips the response", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", () => ({
      value: { callId: 1, url: "https://t.test/", requestInit: { method: "POST" } },
    }));
    const responded = new Promise<any>((resolve) =>
      host.on("respond", (msg) => {
        resolve(msg);
        return { value: undefined };
      }),
    );

    const call = await api.acceptCall();
    assert.equal(call.kind, "fetch");
    assert.equal(call.url, "https://t.test/");
    assert.equal(call.requestInit?.method, "POST");

    call.respond({ status: 200, headers: [], body: new Uint8Array([1, 2]) });
    const msg = await responded;
    assert.equal(msg.ok, true);
    assert.equal(msg.response.status, 200);
  } finally {
    close();
  }
});

test("forwarded entries sit beside the modeled fields in requestInit (§9.1)", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", () => ({
      value: {
        callId: 1,
        url: "https://t.test/",
        requestInit: {
          method: "POST",
          // With a signal: that path rebuilds requestInit, and must keep these.
          hasSignal: true,
          forwarded: JSON.parse('{"anonOptions": {"isolationKey": "k"}, "__proto__": 1}'),
        },
      },
    }));
    const call = await api.acceptCall();
    assert.equal(call.requestInit?.method, "POST");
    assert.deepEqual(call.requestInit?.anonOptions, { isolationKey: "k" });
    assert.ok(Object.hasOwn(call.requestInit!, "__proto__"), "forwarded __proto__ stays an own key");
    assert.equal(Object.getPrototypeOf(call.requestInit), Object.prototype);
    assert.ok(!("forwarded" in call.requestInit!), "the wire envelope does not leak through");
    assert.ok(call.requestInit?.signal instanceof AbortSignal);
  } finally {
    close();
  }
});

test("a rejected respond carries name/message/code to the host (§12)", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", () => ({ value: { callId: 2, url: "u" } }));
    const responded = new Promise<any>((resolve) =>
      host.on("respond", (msg) => {
        resolve(msg);
        return { value: undefined };
      }),
    );

    const call = await api.acceptCall();
    const err = new Error("conn reset");
    err.name = "KpsError";
    (err as { code?: string }).code = "reset";
    call.respond(Promise.reject(err));

    const msg = await responded;
    assert.equal(msg.ok, false);
    assert.deepEqual(msg.error, { name: "KpsError", message: "conn reset", code: "reset" });
  } finally {
    close();
  }
});

test("respond throws on second invocation", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", () => ({ value: { callId: 3, url: "u" } }));
    host.on("respond", () => ({ value: undefined }));
    const call = await api.acceptCall();
    call.respond({ status: 200, headers: [], body: new Uint8Array(0) });
    assert.throws(() => call.respond({ status: 200, headers: [], body: new Uint8Array(0) }));
  } finally {
    close();
  }
});

test("call-abort racing ahead of delivery still aborts the call's signal", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", () => {
      // The host's abort event is posted BEFORE the acceptCall response, so it
      // arrives at the worker first — the pre-abort race.
      host.emit("call-abort", { callId: 9 });
      return { value: { callId: 9, url: "u", requestInit: { hasSignal: true } } };
    });
    const call = await api.acceptCall();
    assert.equal(call.requestInit?.signal?.aborted, true);
  } finally {
    close();
  }
});

test("call-abort after delivery aborts the live signal", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", () => ({
      value: { callId: 10, url: "u", requestInit: { hasSignal: true } },
    }));
    const call = await api.acceptCall();
    const signal = call.requestInit!.signal!;
    assert.equal(signal.aborted, false);
    const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve));
    host.emit("call-abort", { callId: 10 });
    await aborted;
  } finally {
    close();
  }
});

test("acceptCall abort that loses the delivery race hands the call back (§8)", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", async () => {
      await new Promise((r) => setTimeout(r, 30)); // deliver AFTER the abort below
      return { value: { callId: 5, url: "u" } };
    });
    const requeued = new Promise<any>((resolve) => host.onEvent("requeue-call", resolve));

    const ac = new AbortController();
    const p = api.acceptCall({ signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(p, (e: Error) => e.name === "AbortError");
    // The host's late delivery must come back for redelivery, not vanish.
    assert.deepEqual(await requeued, { callId: 5 });
  } finally {
    close();
  }
});

test("respond transfers a Uint8Array body instead of cloning it", async () => {
  const { host, api, close } = setup();
  try {
    host.on("acceptCall", () => ({ value: { callId: 6, url: "u" } }));
    const responded = new Promise<any>((resolve) =>
      host.on("respond", (msg) => {
        resolve(msg);
        return { value: undefined };
      }),
    );
    const call = await api.acceptCall();
    const body = new Uint8Array([9, 9, 9]);
    call.respond({ status: 200, headers: [], body });
    const msg = await responded;
    assert.deepEqual([...msg.response.body], [9, 9, 9]); // bytes arrived
    assert.equal(body.byteLength, 0, "source view should be detached (transferred), not cloned");
  } finally {
    close();
  }
});

test("storage proxies forward abort signals (§11 declared surface)", async () => {
  const { host, api, close } = setup();
  try {
    host.on("storage.get", (_args, { signal }) => {
      // Never resolves on its own; only the forwarded abort can end it.
      return new Promise((_res, rej) => {
        signal.addEventListener("abort", () => rej(signal.reason));
      });
    });
    const ac = new AbortController();
    const p = api.storage.get("k", { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p, (e: Error) => e.name === "AbortError");
  } finally {
    close();
  }
});

test("log calls arrive as events with level and args", async () => {
  const { host, api, close } = setup();
  try {
    const got = new Promise<any>((resolve) => host.onEvent("log", resolve));
    api.log.warn("careful", 42);
    assert.deepEqual(await got, { level: "warn", args: ["careful", 42] });
  } finally {
    close();
  }
});
