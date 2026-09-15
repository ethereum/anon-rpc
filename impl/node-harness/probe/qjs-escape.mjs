// Second-round escape probe: the routes the first pass could only see the
// `typeof` of, plus the ones specific to a WASM isolate rather than a realm.
//
// Everything here runs INSIDE the QuickJS isolate and reports back as a
// string, so a "leaked" result would be visible rather than inferred.

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";

const mod = await newQuickJSWASMModuleFromVariant(variant);
const runtime = mod.newRuntime();
runtime.setMemoryLimit(64 * 1024 * 1024);
// 48KB, not the 512KB this probe originally asked for: a budget above the WASM
// stack never fires, and the "stack overflow" case below then killed this
// process instead of being caught. qjs-stack.mjs is where that was bisected.
runtime.setMaxStackSize(48 * 1024);
const ctx = runtime.newContext();

// One host function and one host object, the minimum a §7 API needs.
const hostFn = ctx.newFunction("hostFn", () => ctx.newString("called"));
ctx.setProp(ctx.global, "hostFn", hostFn);
hostFn.dispose();

// A host function that HANDS BACK a value built from host data, which is the
// shape every real capability has (config, a response body, a log echo).
const give = ctx.newFunction("give", () => {
  const o = ctx.newObject();
  const s = ctx.newString("host-built string");
  ctx.setProp(o, "s", s);
  s.dispose();
  return o;
});
ctx.setProp(ctx.global, "give", give);
give.dispose();

const run = async (name, src) => {
  const r = ctx.evalCode(src, `probe:${name}`);
  if (r.error) {
    const e = ctx.dump(r.error);
    r.error.dispose();
    return `THREW ${e?.name ?? ""}: ${e?.message ?? JSON.stringify(e)}`;
  }
  // Await it properly: resolvePromise + job pump, the same machinery the real
  // bridge uses, so a rejection is a rejection and not a dangling handle.
  const p = ctx.resolvePromise(r.value);
  r.value.dispose();
  runtime.executePendingJobs();
  const settled = await p;
  if (settled.error) {
    const e = ctx.dump(settled.error);
    settled.error.dispose();
    return `REJECTED: ${e?.message ?? JSON.stringify(e)}`;
  }
  const v = ctx.dump(settled.value);
  settled.value.dispose();
  return typeof v === "string" ? v : JSON.stringify(v);
};

const cases = {
  // Can worker code load anything? No module loader is installed, and the
  // isolate has no filesystem of its own.
  "dynamic import('node:fs')": `import("node:fs").then(m => "RESOLVED " + Object.keys(m).slice(0,3), e => { throw e })`,
  "dynamic import('./x.js')": `import("./x.js").then(() => "RESOLVED", e => { throw e })`,

  // The node:vm escape, all three doors.
  "Function ctor via host fn": `hostFn.constructor("return typeof process")()`,
  "Function ctor via host value": `give().s.constructor === String ? "String is ours" : "FOREIGN String"`,
  "indirect eval": `(() => { try { return String(eval("typeof process")) } catch (e) { return "threw " + e.name } })()`,

  // Is a host-built value a foreign object, or an isolate-native one? If any
  // host prototype crossed, the graph is shared after all.
  "host object prototype": `Object.getPrototypeOf(give()) === Object.prototype ? "ours" : "FOREIGN"`,
  "host fn prototype": `Object.getPrototypeOf(hostFn) === Function.prototype ? "ours" : "FOREIGN"`,
  "host fn is instanceof ours": `String(hostFn instanceof Function)`,

  // Anything that names the outside world.
  "scan globals": `Object.getOwnPropertyNames(globalThis).sort().join(",")`,

  // Prototype pollution: it stays inside, but confirm it cannot reach a host
  // function's behaviour (the host never calls back through isolate prototypes).
  "pollute Object.prototype": `(() => { Object.prototype.polluted = 1; return String(({}).polluted) })()`,

  // Resource exhaustion the host must survive rather than inherit.
  "stack overflow": `(function f(){ return f() })()`,
  "huge string": `(() => { let s = "x"; for (let i = 0; i < 40; i++) s += s; return s.length })()`,
  "throw non-Error": `(() => { throw { toString() { throw "nested" } } })()`,
};

const out = {};
for (const [name, src] of Object.entries(cases)) out[name] = await run(name, src);

// Does the isolate survive an OOM, or is the whole runtime poisoned? This
// decides whether a hostile worker can take the harness down with it.
const oom = await run("oom", `(() => { const a = []; for (;;) a.push(new Uint8Array(1 << 20)) })()`);
out["after OOM: still usable"] = `${oom.slice(0, 40)} -> ${await run("after", `"yes: " + (1 + 1)`)}`;

console.log(JSON.stringify(out, null, 2));
try { ctx.dispose(); runtime.dispose(); } catch (e) { console.log("teardown:", String(e?.message).split("\n")[0]); }
