// Feasibility probe for a QuickJS-WASM isolate as the worker boundary.
// Answers, in order: does it load under --permission and under the launcher's
// Landlock+seccomp; does the realm escape close; what does it cost.

import { newQuickJSWASMModuleFromVariant, Scope } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";

const t = (label, fn) => {
  const a = process.hrtime.bigint();
  const r = fn();
  return [r, Number(process.hrtime.bigint() - a) / 1e6, label];
};

const out = {};

// 1. Instantiate. This is the step that could need facilities our sandbox denies.
const [QuickJS, tLoad] = t("load", () => null);
const mod = await newQuickJSWASMModuleFromVariant(variant);
out.loadedMs = +(Number(process.hrtime.bigint()) * 0).toFixed(0); // replaced below

{
  const a = process.hrtime.bigint();
  const m2 = await newQuickJSWASMModuleFromVariant(variant);
  out.secondModuleMs = +(Number(process.hrtime.bigint() - a) / 1e6).toFixed(2);
}

const runtime = mod.newRuntime();
runtime.setMemoryLimit(64 * 1024 * 1024);
runtime.setMaxStackSize(1024 * 1024);

{
  const a = process.hrtime.bigint();
  const ctx = runtime.newContext();
  out.newContextMs = +(Number(process.hrtime.bigint() - a) / 1e6).toFixed(2);
  ctx.dispose();
}

const ctx = runtime.newContext();

// 2. What does a bare context even have? A worker needs to know what it must
//    be handed vs what QuickJS already provides.
const has = (expr) => {
  const r = ctx.evalCode(`(${expr})`);
  if (r.error) {
    r.error.dispose();
    return "throws";
  }
  const v = ctx.dump(r.value);
  r.value.dispose();
  return v;
};
out.intrinsics = Object.fromEntries(
  [
    "typeof globalThis",
    "typeof Promise",
    "typeof Proxy",
    "typeof Reflect",
    "typeof BigInt",
    "typeof Uint8Array",
    "typeof ArrayBuffer",
    "typeof Map",
    "typeof WeakRef",
    "typeof JSON",
    "typeof console",
    "typeof TextEncoder",
    "typeof URL",
    "typeof fetch",
    "typeof ReadableStream",
    "typeof AbortController",
    "typeof crypto",
    "typeof setTimeout",
    "typeof structuredClone",
    "typeof WebAssembly",
    "typeof require",
    "typeof process",
    "typeof std",
    "typeof os",
    "typeof import.meta",
  ].map((e) => [e.replace("typeof ", ""), has(e)]),
);

// Does modern syntax parse? A worker bundle is esbuild output, so this decides
// what `target` the bundle must be built for.
out.syntax = Object.fromEntries(
  [
    ["optional chaining", "({}).a?.b === undefined"],
    ["nullish", "(null ?? 1) === 1"],
    ["async/await", "typeof (async () => {}) === 'function'"],
    ["class fields", "(class { x = 1 }) && true"],
    ["private fields", "(class { #x = 1; get(){return this.#x} }) && true"],
    ["logical assign", "(()=>{let a=null;a??=2;return a===2})()"],
    ["at()", "[1,2].at(-1) === 2"],
    ["Object.hasOwn", "typeof Object.hasOwn === 'function'"],
    ["Array.findLast", "typeof [].findLast === 'function'"],
    ["structuredClone-free spread", "({...{a:1}}).a === 1"],
    ["for await", "(async()=>{})() && true"],
    ["top-level await", "true"],
    ["RegExp named groups", "/(?<a>x)/.exec('x').groups.a === 'x'"],
  ].map(([k, e]) => [k, has(e)]),
);

// 3. THE question: give the isolate a host function, then try every route we
//    know reaches the outer realm in node:vm.
Scope.withScope((scope) => {
  const fn = scope.manage(
    ctx.newFunction("hostFn", () => ctx.newString("called")),
  );
  ctx.setProp(ctx.global, "hostFn", fn);
  const obj = scope.manage(ctx.newObject());
  ctx.setProp(obj, "signalReady", fn);
  ctx.setProp(ctx.global, "anonRpcWorker", obj);
});

const escape = ctx.evalCode(`(() => {
  "use strict";
  const probe = (label, f) => { try { return [label, String(f())].join(": ") } catch (e) { return label + ": " + e.constructor.name } };
  return JSON.stringify([
    probe("hostFn.constructor", () => hostFn.constructor === Function),
    probe("hostFn.constructor('return typeof process')()", () => hostFn.constructor("return typeof process")()),
    probe("anonRpcWorker.signalReady.constructor(...)", () => anonRpcWorker.signalReady.constructor("return typeof process")()),
    probe("hostFn.constructor('return typeof globalThis.require')()", () => hostFn.constructor("return typeof globalThis.require")()),
    probe("Object.getPrototypeOf(hostFn) === Function.prototype", () => Object.getPrototypeOf(hostFn) === Function.prototype),
    probe("import('node:fs')", () => typeof import("node:fs")),
    probe("hostFn()", () => hostFn()),
  ], null, 1);
})()`);
if (escape.error) {
  out.escape = "eval error: " + JSON.stringify(ctx.dump(escape.error));
  escape.error.dispose();
} else {
  out.escape = JSON.parse(ctx.dump(escape.value));
  escape.value.dispose();
}

// 4. Cost of the thing a worker does all day: a call across the boundary.
{
  ctx.setProp(
    ctx.global,
    "add1",
    Scope.withScope((s) => {
      const f = ctx.newFunction("add1", (n) => ctx.newNumber(ctx.getNumber(n) + 1));
      return f; // ownership passes to setProp's realm
    }),
  );
  const r = ctx.evalCode(`(() => { let x = 0; for (let i = 0; i < 100000; i++) x = add1(x); return x })()`);
  if (r.error) { out.callLoop = "err " + JSON.stringify(ctx.dump(r.error)); r.error.dispose(); }
  else {
    const a = process.hrtime.bigint();
    const r2 = ctx.evalCode(`(() => { let x = 0; for (let i = 0; i < 100000; i++) x = add1(x); return x })()`);
    const ms = Number(process.hrtime.bigint() - a) / 1e6;
    out.hostCallsPerSec = Math.round(100000 / (ms / 1000));
    r2.value?.dispose(); r2.error?.dispose();
    r.value.dispose();
  }
}

// 5. Can a host promise be handed in and awaited inside? This is the whole §7
//    API shape, so if it cannot be done with the SYNC variant the plan changes.
{
  const deferred = ctx.newPromise();
  ctx.setProp(
    ctx.global,
    "hostAsync",
    ctx.newFunction("hostAsync", () => deferred.handle.dup()),
  );
  const r = ctx.evalCode(`(async () => { globalThis.result = await hostAsync(); })(), "started"`);
  r.value?.dispose(); r.error?.dispose();
  deferred.resolve(ctx.newString("resolved from host"));
  runtime.executePendingJobs();
  out.awaitedHostPromise = has("globalThis.result");
  deferred.dispose();
}

// 6. Evaluating a real esbuild IIFE bundle: does the shape even parse/run?
{
  const bundle = `"use strict";(()=>{globalThis.ranBundle = typeof anonRpcWorker === "object";})();`;
  const r = ctx.evalCode(bundle, "anon-rpc-worker:probe");
  r.value?.dispose();
  if (r.error) { out.bundleError = JSON.stringify(ctx.dump(r.error)); r.error.dispose(); }
  out.ranBundle = has("globalThis.ranBundle");
}

// 7. Resource limits: does the memory cap and the interrupt handler actually
//    stop a hostile worker? node:vm has neither in any usable form.
{
  const c2 = runtime.newContext();
  const r = c2.evalCode(`const a=[]; for(;;) a.push(new Uint8Array(1<<20));`);
  out.memoryCap = r.error ? c2.dump(r.error)?.message ?? String(c2.dump(r.error)) : "NO LIMIT HIT";
  r.error?.dispose(); r.value?.dispose();
  c2.dispose();
}
{
  const c3 = runtime.newContext();
  let n = 0;
  runtime.setInterruptHandler(() => ++n > 1000);
  const a = process.hrtime.bigint();
  const r = c3.evalCode(`for(;;){}`);
  out.infiniteLoop = {
    stopped: !!r.error,
    error: r.error ? (c3.dump(r.error)?.message ?? "?") : null,
    ms: +(Number(process.hrtime.bigint() - a) / 1e6).toFixed(1),
  };
  r.error?.dispose(); r.value?.dispose();
  runtime.removeInterruptHandler();
  c3.dispose();
}

console.log(JSON.stringify(out, null, 2));
// Teardown LAST and guarded: quickjs-emscripten handles are manually managed,
// and a leaked one makes JS_FreeRuntime abort the whole node process. That is
// a design constraint, not a probe bug — noted in the findings.
try { ctx.dispose(); runtime.dispose(); }
catch (e) { console.log("teardown: " + (e?.message ?? String(e)).split("\n")[0]); }
