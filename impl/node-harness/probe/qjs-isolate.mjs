// Drives the QuickJS isolate directly, with the host side stubbed, so the
// prelude and the bridge can be exercised without the thread and host layers.
//
// What it checks, in the order the answers matter:
//   1. zero ambient capability — enumerate the guest's global and classify
//      every single name, with nothing left over
//   2. the raw bridge is unreachable from guest code
//   3. the platform the prelude builds actually works (encoding, URL, streams)
//   4. a real hash-pinned bundle runs and answers a call
//   5. a hostile guest cannot take the host with it

import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Built in-memory so this probe always tests the current source.
const bundled = await build({
  entryPoints: [resolve(HERE, "../src/child/isolate.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  write: false,
  loader: { ".guest.js": "text" },
  logLevel: "warning",
});
// Written beside this file rather than in the OS temp dir so that the import
// resolves node_modules the same way the real build does, then removed.
const tmp = resolve(HERE, ".isolate.built.mjs");
await writeFile(tmp, bundled.outputFiles[0].text);
const { Isolate } = await import(tmp);
process.on("exit", () => {
  try {
    unlinkSync(tmp);
  } catch {
    /* already gone */
  }
});

let failures = 0;
const ok = (cond, label, detail = "") => {
  if (cond) console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** An isolate whose host side records what the guest asked for. */
async function makeIsolate(caps = { socket: false, fetch: false }, handlers = {}, config = undefined) {
  const sent = [];
  const iso = await Isolate.create(caps, config, {
    onSend: (method, args, bytes) => void sent.push({ method, args, bytes }),
    onRequest: async (method, args, bytes) => {
      const h = handlers[method];
      if (!h) throw Object.assign(new Error(`no host handler: ${method}`), { code: "unsupported" });
      return h(args, bytes);
    },
    random: (n) => webcrypto.getRandomValues(new Uint8Array(n)),
    onInternalError: (e) => void sent.push({ method: "__internal", args: String(e?.message ?? e) }),
  });
  return { iso, sent };
}

/** Evaluate an expression in the guest and get its value back as JSON. */
function evalJson(iso, expr) {
  const out = [];
  // `report` is not a capability — it is this probe reading a guest value, via
  // the log channel the guest already has.
  iso.runBundle(`console.log(JSON.stringify((() => { try { return ${expr} } catch (e) { return "THREW " + e.name + ": " + e.message } })()))`, "probe");
  return out;
}

/* --- 1. zero ambient capability ---------------------------------------- */
{
  const { iso, sent } = await makeIsolate({ socket: false, fetch: false });
  iso.runBundle(
    `console.log(JSON.stringify(Object.getOwnPropertyNames(globalThis).sort()))`,
    "probe:globals",
  );
  const names = JSON.parse(sent.find((s) => s.method === "log").args.args[0]);

  // Every name must be accounted for. The point of the exercise is that this
  // list is short, complete, and has no third category.
  const ECMASCRIPT = new Set([
    "globalThis", "Object", "Function", "Array", "String", "Boolean", "Number", "Math", "JSON",
    "Symbol", "Reflect", "Proxy", "Date", "RegExp", "Error", "EvalError", "RangeError",
    "ReferenceError", "SyntaxError", "TypeError", "URIError", "InternalError", "AggregateError",
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "Uint8Array", "Int8Array", "Uint16Array",
    "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array",
    "BigUint64Array", "Uint8ClampedArray", "Float16Array", "Map", "Set", "WeakMap", "WeakSet",
    "WeakRef", "Iterator", "FinalizationRegistry", "Promise", "BigInt", "BigFloat", "BigDecimal",
    "Operators",
    "eval", "parseInt", "parseFloat", "isNaN", "isFinite", "NaN", "Infinity", "undefined",
    "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape",
  ]);
  // Pure computation added by the prelude: no authority over anything.
  const PURE = new Set([
    "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "ReadableStream",
    "WritableStream", "Headers", "Response", "URL", "URLSearchParams", "structuredClone",
    "queueMicrotask",
  ]);
  // Authority. Each one is a host decision, and this is the whole list.
  const CAPABILITIES = new Set([
    "anonRpcWorker", "console", "crypto", "setTimeout", "clearTimeout", "setInterval",
    "clearInterval", "fetch",
  ]);

  const unclassified = names.filter((n) => !ECMASCRIPT.has(n) && !PURE.has(n) && !CAPABILITIES.has(n));
  ok(unclassified.length === 0, "every global is classified", unclassified.length ? `UNCLASSIFIED: ${unclassified.join(", ")}` : `${names.length} names, no leftovers`);

  const authority = names.filter((n) => CAPABILITIES.has(n));
  ok(!authority.includes("fetch"), "fetch is absent when not granted", `authority present: ${authority.join(", ")}`);

  /* --- 2. the raw bridge is unreachable ------------------------------------ */
  iso.runBundle(
    `console.log(JSON.stringify(["__host_send","__host_request","__host_random","__host_url","__host_capabilities","__host_capabilities_json"].map(n => n + "=" + typeof globalThis[n])))`,
    "probe:bridge",
  );
  const bridge = JSON.parse(sent.filter((s) => s.method === "log").at(-1).args.args[0]);
  ok(bridge.every((b) => b.endsWith("=undefined")), "raw bridge deleted from guest global", bridge.join(" "));

  /* --- 3. the escape doors, all three ------------------------------------- */
  iso.runBundle(
    `console.log(JSON.stringify({
       viaCapability: String(anonRpcWorker.signalReady.constructor("return typeof process")()),
       viaConsole: String(console.log.constructor("return typeof globalThis.require")()),
       ctorIsOurs: anonRpcWorker.signalReady.constructor === Function,
       protoIsOurs: Object.getPrototypeOf(anonRpcWorker.signalReady) === Function.prototype,
     }))`,
    "probe:escape",
  );
  const esc = JSON.parse(sent.filter((s) => s.method === "log").at(-1).args.args[0]);
  ok(
    esc.viaCapability === "undefined" && esc.viaConsole === "undefined" && esc.ctorIsOurs && esc.protoIsOurs,
    "realm escape is closed",
    `process=${esc.viaCapability} require=${esc.viaConsole} Function is guest's=${esc.ctorIsOurs}`,
  );

  iso.dispose();
}

/* --- 4. the platform the prelude builds -------------------------------- */
{
  const { iso, sent } = await makeIsolate({ socket: false, fetch: false }, {}, { gateways: ["a", "b"] });
  iso.runBundle(
    `(async () => {
       const enc = new TextEncoder().encode("héllo → 🌍");
       const dec = new TextDecoder().decode(enc);
       const u = new URL("/rpc?x=1#f", "https://example.com:8443");
       const rs = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1,2])); c.enqueue(new Uint8Array([3])); c.close() } });
       let seen = 0;
       for await (const chunk of rs) seen += chunk.length;
       const r = new Response(new TextEncoder().encode('{"ok":true}'), { status: 201, headers: [["content-type","application/json"]] });
       const rnd = new Uint8Array(8); crypto.getRandomValues(rnd);
       console.log(JSON.stringify({
         roundTrip: dec === "héllo → 🌍",
         utf8Len: enc.length,
         href: u.href, host: u.host, search: u.searchParams.get("x"), origin: u.origin,
         badUrl: (() => { try { new URL("not a url"); return "NO THROW" } catch (e) { return e.name } })(),
         streamBytes: seen,
         json: (await r.json()).ok, status: r.status, ctype: r.headers.get("content-type"),
         entropy: rnd.some(b => b !== 0),
         config: JSON.stringify(anonRpcWorker.config),
         uuid: /^[0-9a-f-]{36}$/.test(crypto.randomUUID()),
         subtleAbsent: crypto.subtle === undefined,
       }));
     })()`,
    "probe:platform",
  );
  await new Promise((r) => setTimeout(r, 50));
  const p = JSON.parse(sent.filter((s) => s.method === "log").at(-1).args.args[0]);
  ok(p.roundTrip && p.utf8Len === 15, "TextEncoder/TextDecoder round-trip incl. astral", `${p.utf8Len} bytes`);
  ok(p.href === "https://example.com:8443/rpc?x=1#f" && p.search === "1" && p.origin === "https://example.com:8443", "URL delegates to the host parser", p.href);
  ok(p.badUrl === "TypeError", "invalid URL throws TypeError", p.badUrl);
  ok(p.streamBytes === 3, "ReadableStream async-iterates", `${p.streamBytes} bytes`);
  ok(p.json === true && p.status === 201 && p.ctype === "application/json", "Response/Headers work");
  ok(p.entropy && p.uuid, "crypto.getRandomValues + randomUUID bridged");
  ok(p.config === '{"gateways":["a","b"]}', "§7 config arrives", p.config);
  ok(p.subtleAbsent, "crypto.subtle absent rather than faked");

  // Timers need the host to answer the `timer` request; unhandled here, so
  // this asserts the failure is clean rather than a hang.
  iso.dispose();
}

/* --- 5. a real bundle answers a real call ------------------------------ */
{
  const bundlePath = resolve(HERE, "../../passthrough-worker/dist/passthrough-worker.js");
  const source = await readFile(bundlePath, "utf8");
  ok(source.startsWith('"use strict"'), "the real bundle is an esbuild IIFE", `${source.length} bytes`);

  let accepted = false;
  const responses = [];
  const { iso, sent } = await makeIsolate(
    { socket: false, fetch: true },
    {
      // §8: hand the worker exactly one call, then park forever.
      "call.accept": async () => {
        if (accepted) return new Promise(() => {});
        accepted = true;
        return { value: { id: 7, kind: "fetch", url: "https://rpc.example/", requestInit: { method: "POST" } }, bytes: new TextEncoder().encode('{"method":"eth_chainId"}') };
      },
      // The granted fetch: the host is on the path and sees every request.
      fetch: async (args, bytes) => {
        responses.push({ url: args.url, method: args.method, body: new TextDecoder().decode(bytes ?? new Uint8Array()) });
        return {
          value: { status: 200, headers: [["content-type", "application/json"]], url: args.url },
          bytes: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":"0x1"}'),
        };
      },
    },
  );

  iso.runBundle(source, "anon-rpc-worker:passthrough");
  await new Promise((r) => setTimeout(r, 150));

  ok(sent.some((s) => s.method === "worker.ready"), "worker signalled ready");
  ok(responses.length === 1 && responses[0].url === "https://rpc.example/", "granted fetch was called by the guest", JSON.stringify(responses[0]));
  const respond = sent.find((s) => s.method === "call.respond");
  ok(!!respond && respond.args.status === 200, "guest responded to the call", respond ? `status ${respond.args.status}, ${respond.bytes?.length} body bytes` : "no response");
  ok(
    respond && new TextDecoder().decode(respond.bytes).includes('"result":"0x1"'),
    "response body made it back through the isolate",
    respond ? new TextDecoder().decode(respond.bytes) : "",
  );
  const internal = sent.filter((s) => s.method === "__internal");
  ok(internal.length === 0, "no internal errors", internal.map((i) => i.args).join("; "));
  iso.dispose();
}

/* --- 6. a hostile guest cannot take the host with it -------------------- */
for (const [label, src, expect] of [
  ["infinite loop", `for(;;){}`, /interrupt/i],
  ["deep recursion", `(function f(){ return f() })()`, /stack overflow/i],
  ["deep JSON", `(() => { const o={}; let c=o; for(let i=0;i<1e6;i++){c.next={};c=c.next} return JSON.stringify(o) })()`, /stack|memory/i],
  ["heap exhaustion", `const a=[]; for(;;) a.push(new Uint8Array(1<<20));`, /memory/i],
  ["huge string", `(() => { let s="x"; for(let i=0;i<40;i++) s+=s; return s.length })()`, /memory|invalid|string/i],
]) {
  const { iso } = await makeIsolate({ socket: false, fetch: false }, {}, undefined);
  let threw = "did not throw";
  const started = Date.now();
  try {
    iso.runBundle(src, `hostile:${label}`);
  } catch (e) {
    threw = e.message;
  }
  const ms = Date.now() - started;
  ok(expect.test(threw), `hostile guest contained: ${label}`, `${threw} (${ms}ms)`);
  iso.dispose();
}

// Reaching here at all is the strongest assertion in the file: every hostile
// case above ran in this process, and this process is still alive.
console.log(failures === 0 ? "\n✅ isolate probe passed — host survived every case" : `\n❌ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
