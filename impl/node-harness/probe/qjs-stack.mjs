// A guest must not be able to kill the host with three lines of JS.
//
// QuickJS enforces its own stack limit by comparing the current frame's address
// against a budget. Compiled to WASM that budget is measured against the WASM
// stack, so a budget LARGER than the WASM stack never fires: the wasm stack is
// exhausted first, V8 raises RangeError from inside the instance, and it unwinds
// straight through the host process. This finds where the budget has to sit.
//
// Run as: node probe/qjs-stack.mjs [bytes]   (one size, in its own process)

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";

const arg = process.argv[2];
const mod = await newQuickJSWASMModuleFromVariant(variant);
const runtime = mod.newRuntime();
runtime.setMemoryLimit(64 * 1024 * 1024);
if (arg !== "default") runtime.setMaxStackSize(Number(arg));
const ctx = runtime.newContext();

// Deep recursion, and deep recursion that also allocates, since the second is
// how a guest would try to make the two limits interact.
for (const [name, src] of [
  ["plain recursion", `(function f(n){ return f(n+1) })(0)`],
  ["recursion + alloc", `(function f(n){ const pad = [n,n,n,n]; return f(n+1) + pad.length })(0)`],
  ["recursion via host-visible JSON", `(() => { const o = {}; let c = o; for (let i=0;i<1e6;i++) { c.next = {}; c = c.next } return JSON.stringify(o).length })()`],
]) {
  const r = ctx.evalCode(src, "stack-probe");
  const got = r.error ? `threw: ${ctx.dump(r.error)?.message ?? "?"}` : `returned ${ctx.dump(r.value)}`;
  r.error?.dispose();
  r.value?.dispose();
  console.log(`  ${arg.padStart(9)}  ${name.padEnd(32)} ${got}`);
}
// If we got here the host survived, which is the whole question.
console.log(`  ${arg.padStart(9)}  HOST SURVIVED`);
