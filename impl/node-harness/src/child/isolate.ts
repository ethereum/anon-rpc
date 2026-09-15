// The isolation boundary itself: a QuickJS interpreter compiled to WASM, with
// the worker bundle running inside it.
//
// Why this rather than the kernel. The earlier strategy in this harness ran the
// bundle in a `node:vm` context inside a Landlock-confined process, and that
// works — but `node:vm` is not a boundary (any host function reachable from the
// guest leaks the host realm through `fn.constructor`), so ALL of the isolation
// came from the kernel, which means Linux only, and the guest still ran with an
// ambient platform that had to be confined rather than absent.
//
// A QuickJS isolate inverts both:
//
//   * It is a boundary in the language. A host function installed here is a
//     QuickJS function object backed by a C callback, not a foreign JS
//     function, so `fn.constructor` is the GUEST's `Function` and compiles in
//     the GUEST's global scope. Measured in probe/qjs-escape.mjs: the three
//     doors that open in `node:vm` all return `undefined` here.
//   * The guest starts with nothing. A bare context has the ECMAScript
//     intrinsics and no console, timers, URL, fetch, streams or crypto. The
//     platform is assembled by prelude.guest.js out of pure computation, and
//     every capability is a host decision. `fetch` stops being a platform fact
//     and becomes a grant.
//
// And it is portable: no Landlock, no seccomp, no launcher binary, no
// per-platform packaging. It is the same boundary on macOS and Windows.
//
// What it costs, all measured (see README):
//   * Guest JS runs at interpreter speed, not V8 speed.
//   * Guest recursion is capped near 276 frames, because QuickJS's stack
//     budget has to stay under the WASM stack (see MAX_STACK_BYTES).
//   * Handles are manually memory-managed; a leaked one makes QuickJS abort
//     the whole process at teardown, so every path here disposes.

import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import PRELUDE from "./prelude.guest.js";

/**
 * QuickJS's stack budget, which it enforces by comparing frame addresses.
 *
 * Compiled to WASM that budget is measured against the WASM stack, which
 * emscripten fixes at 64KB when the variant is linked. A budget LARGER than
 * the WASM stack therefore never fires: the WASM stack is exhausted first, V8
 * raises `RangeError: Maximum call stack size exceeded` from inside the
 * instance, and it unwinds through whatever called in.
 *
 * QuickJS's own default is 256KB, so the default configuration lets a guest
 * kill its host with `(function f(){return f()})()`. Bisected in
 * probe/qjs-stack.mjs: 64KB is caught cleanly as a guest `stack overflow`
 * exception, 80KB is not. This sits below that with margin, because the three
 * hostile shapes probed there are not proof of every shape — notably
 * `JSON.stringify` of a deeply nested object recurses in C, and is the case
 * that fails first as the budget rises.
 *
 * The margin costs guest recursion depth: ~276 frames here, ~369 at 64KB.
 * Lifting it means building a QuickJS variant with `-sSTACK_SIZE` raised,
 * rather than tuning this number.
 */
const MAX_STACK_BYTES = 48 * 1024;

/** Guest heap cap. A guest that exceeds it gets an `out of memory` exception. */
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * How long guest code may run without yielding before it is interrupted.
 *
 * This is what makes a `for(;;){}` survivable: QuickJS calls the interrupt
 * handler periodically from inside the guest, and returning true unwinds the
 * guest with an `interrupted` exception. `node:vm` has no usable equivalent.
 */
const DEFAULT_DEADLINE_MS = 5_000;

export type IsolateCapabilities = {
  /** §7 optional bridged TCP. Absent in the guest when false. */
  socket: boolean;
  /**
   * A bridged `fetch`. Under this strategy the guest has no network of its
   * own, so `fetch` exists only if the host grants it — which is what lets a
   * worker written against the browser platform (the reference passthrough
   * worker) run unchanged while the host still sees every request.
   */
  fetch: boolean;
};

export type IsolateOptions = {
  memoryBytes?: number;
  deadlineMs?: number;
  /** Host-side implementation of a guest request. Resolves to [json, bytes]. */
  onRequest: (method: string, args: unknown, bytes?: Uint8Array) => Promise<HostReply>;
  /** Host-side handling of a fire-and-forget guest event. */
  onSend: (method: string, args: unknown, bytes?: Uint8Array) => void;
  /** Entropy for `crypto.getRandomValues`, which must answer synchronously. */
  random: (n: number) => Uint8Array;
  /** Diagnostics for failures that happen with no guest frame to throw into. */
  onInternalError: (err: unknown) => void;
};

export type HostReply = { value?: unknown; bytes?: Uint8Array };

/**
 * A copy of exactly these bytes, as a standalone ArrayBuffer.
 *
 * Always a copy, never `u.buffer`: a Uint8Array is frequently a window onto a
 * larger buffer (Node pools them), and handing the guest the backing store
 * would hand it every other byte in that pool as well.
 */
function exactBuffer(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

let modulePromise: Promise<QuickJSWASMModule> | undefined;

/** The WASM module is process-wide and reusable; instantiating costs ~4ms. */
function quickjsModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

export class Isolate {
  #runtime: QuickJSRuntime;
  #ctx: QuickJSContext;
  #opts: IsolateOptions;
  #deadlineMs: number;
  /** Wall-clock point after which the interrupt handler unwinds the guest. */
  #deadline = Infinity;
  #disposed = false;
  /** Live deferred promises, so teardown can dispose what is still pending. */
  #pending = new Set<{ dispose: () => void; alive: boolean }>();
  #onCallAbort?: QuickJSHandle;

  private constructor(runtime: QuickJSRuntime, ctx: QuickJSContext, opts: IsolateOptions) {
    this.#runtime = runtime;
    this.#ctx = ctx;
    this.#opts = opts;
    this.#deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  static async create(caps: IsolateCapabilities, config: unknown, opts: IsolateOptions): Promise<Isolate> {
    const mod = await quickjsModule();
    const runtime = mod.newRuntime();
    runtime.setMemoryLimit(opts.memoryBytes ?? DEFAULT_MEMORY_BYTES);
    runtime.setMaxStackSize(MAX_STACK_BYTES);
    const ctx = runtime.newContext();
    const iso = new Isolate(runtime, ctx, opts);
    try {
      iso.#install(caps, config);
      return iso;
    } catch (e) {
      iso.dispose();
      throw e;
    }
  }

  /* --- the four host functions ------------------------------------------ */

  #install(caps: IsolateCapabilities, config: unknown): void {
    const ctx = this.#ctx;

    // Guest code can burn CPU inside any of these, so the deadline is armed
    // around every entry into the guest, not just around evalCode.
    this.#runtime.setInterruptHandler(() => Date.now() > this.#deadline);

    const fns: QuickJSHandle[] = [];
    const install = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void) => {
      const h = ctx.newFunction(name, fn as never);
      ctx.setProp(ctx.global, name, h);
      fns.push(h);
    };

    // __host_send(method, argsJson, bytesOrNull) -> void
    install("__host_send", (mh, ah, bh) => {
      const method = ctx.getString(mh);
      const args = this.#json(ah);
      const bytes = this.#bytes(bh);
      try {
        this.#opts.onSend(method, args, bytes);
      } catch (e) {
        // A throwing send must not propagate into guest code: the guest did
        // not ask for a result and cannot handle one.
        this.#opts.onInternalError(e);
      }
    });

    // __host_request(method, argsJson, bytesOrNull) -> Promise<[json, bytes]>
    install("__host_request", (mh, ah, bh) => {
      const method = ctx.getString(mh);
      const args = this.#json(ah);
      const bytes = this.#bytes(bh);

      const deferred = ctx.newPromise();
      const entry = { dispose: () => deferred.dispose(), alive: true };
      this.#pending.add(entry);
      const finish = (fn: () => void) => {
        if (!entry.alive || this.#disposed) return;
        entry.alive = false;
        this.#pending.delete(entry);
        fn();
        deferred.dispose();
        // Resolving a promise only queues the guest's reactions; they run when
        // the job queue is drained.
        this.#pump();
      };

      this.#opts.onRequest(method, args, bytes).then(
        (reply) =>
          finish(() => {
            const arr = this.#reply(reply);
            deferred.resolve(arr);
            arr.dispose();
          }),
        (err) =>
          finish(() => {
            const e = this.#errorValue(err);
            deferred.reject(e);
            e.dispose();
          }),
      );

      // `deferred.handle` stays owned by the deferred, so hand back a dup.
      return deferred.handle.dup();
    });

    // __host_random(n) -> ArrayBuffer. Synchronous, because getRandomValues is.
    install("__host_random", (nh) => {
      const n = Math.max(0, Math.min(65536, ctx.getNumber(nh) | 0));
      return ctx.newArrayBuffer(exactBuffer(this.#opts.random(n)));
    });

    // __host_url(input, baseOrNull) -> json | null. Authority-free; delegated
    // so that guest code gets the platform's exact WHATWG behaviour.
    install("__host_url", (ih, bh) => {
      const input = ctx.getString(ih);
      const base = ctx.typeof(bh) === "string" ? ctx.getString(bh) : undefined;
      try {
        const u = base === undefined ? new URL(input) : new URL(input, base);
        return ctx.newString(
          JSON.stringify({
            href: u.href,
            protocol: u.protocol,
            username: u.username,
            password: u.password,
            host: u.host,
            hostname: u.hostname,
            port: u.port,
            pathname: u.pathname,
            search: u.search,
            hash: u.hash,
            origin: u.origin,
          }),
        );
      } catch {
        return ctx.null; // the prelude turns this into a TypeError
      }
    });

    // What the prelude reads to decide which capabilities to define.
    const capsJson = ctx.newString(JSON.stringify({ ...caps, config: config ?? undefined }));
    // Parsed inside the guest rather than built handle-by-handle: config is
    // arbitrary host-supplied JSON, and JSON.parse in the guest keeps it from
    // being a tree of handles this side has to construct and dispose.
    ctx.setProp(ctx.global, "__host_capabilities_json", capsJson);
    capsJson.dispose();
    this.#evalOrThrow(
      `globalThis.__host_capabilities = JSON.parse(__host_capabilities_json); delete globalThis.__host_capabilities_json;`,
      "anon-rpc:caps",
    );

    this.#evalOrThrow(PRELUDE, "anon-rpc:prelude");

    for (const h of fns) h.dispose();

    // Keep the abort hook the prelude exported, so an inbound abort can be
    // delivered without re-looking it up on the guest's global each time.
    const hook = ctx.getProp(ctx.global, "__onCallAbort");
    this.#onCallAbort = ctx.typeof(hook) === "function" ? hook : (hook.dispose(), undefined);
  }

  /* --- entering the guest ------------------------------------------------ */

  /** Run the hash-verified bundle. Throws only if it threw while evaluating. */
  runBundle(source: string, filename: string): void {
    this.#evalOrThrow(source, filename);
    this.#pump();
  }

  /** Deliver a host-side abort for an accepted call (§9). */
  abortCall(id: number): void {
    if (this.#disposed || !this.#onCallAbort) return;
    this.#guarded(() => {
      const arg = this.#ctx.newNumber(id);
      const r = this.#ctx.callFunction(this.#onCallAbort!, this.#ctx.undefined, arg);
      arg.dispose();
      // Either arm holds a handle, and exactly one of them exists — a leak
      // here would abort the process at teardown, so no optional chaining.
      if (r.error) r.error.dispose();
      else r.value.dispose();
    });
    this.#pump();
  }

  #evalOrThrow(code: string, filename: string): void {
    const result = this.#guarded(() => this.#ctx.evalCode(code, filename));
    if (result.error) {
      const e = this.#ctx.dump(result.error) as { name?: string; message?: string; stack?: string };
      result.error.dispose();
      const err = new Error(e?.message ?? String(e));
      err.name = e?.name ?? "Error";
      if (e?.stack) err.stack = `${err.name}: ${err.message}\n${e.stack}`;
      throw err;
    }
    result.value.dispose();
  }

  /**
   * Drain the guest's microtask queue.
   *
   * Guest promise reactions only run here, so every host resolution ends with
   * a pump. Reactions can call back into the host and queue more jobs, which
   * executePendingJobs handles; what it cannot handle is a reaction that loops
   * forever, hence the deadline.
   */
  #pump(): void {
    if (this.#disposed) return;
    const r = this.#guarded(() => this.#runtime.executePendingJobs());
    if (r.error) {
      // A rejection with no guest handler, or an interrupted reaction. There
      // is no guest frame to throw into, so it goes to the host as a failure.
      const e = this.#ctx.dump(r.error) as { message?: string };
      r.error.dispose();
      this.#opts.onInternalError(new Error(e?.message ?? "guest job failed"));
    }
  }

  /** Arm the deadline around any entry into guest code, and disarm after. */
  #guarded<T>(fn: () => T): T {
    const outer = this.#deadline;
    // Nested entries (a pump inside a pump) keep the outermost deadline, so a
    // guest cannot extend its budget by re-entering.
    this.#deadline = outer === Infinity ? Date.now() + this.#deadlineMs : outer;
    try {
      return fn();
    } finally {
      this.#deadline = outer;
    }
  }

  /* --- marshalling ------------------------------------------------------- */

  /** A guest JSON string argument as a host value. Borrowed handle: no dispose. */
  #json(h: QuickJSHandle): unknown {
    if (this.#ctx.typeof(h) !== "string") return undefined;
    const s = this.#ctx.getString(h);
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  }

  /**
   * A guest ArrayBuffer argument as host bytes.
   *
   * The returned view points into the WASM heap, which moves when the guest
   * allocates, so it is copied before the lifetime is released. Skipping the
   * copy would give the host a view that silently changes underneath it.
   */
  #bytes(h: QuickJSHandle): Uint8Array | undefined {
    if (this.#ctx.typeof(h) !== "object") return undefined;
    let lifetime;
    try {
      lifetime = this.#ctx.getArrayBuffer(h);
    } catch {
      return undefined;
    }
    try {
      return Uint8Array.prototype.slice.call(lifetime.value);
    } finally {
      lifetime.dispose();
    }
  }

  /** [json, bytes] as a guest array. Caller disposes. */
  #reply(reply: HostReply): QuickJSHandle {
    const ctx = this.#ctx;
    const arr = ctx.newArray();
    const json = reply.value === undefined ? ctx.null : ctx.newString(JSON.stringify(reply.value));
    ctx.setProp(arr, 0, json);
    json.dispose();
    const bytes = reply.bytes ? ctx.newArrayBuffer(exactBuffer(reply.bytes)) : ctx.null;
    ctx.setProp(arr, 1, bytes);
    bytes.dispose();
    return arr;
  }

  /** A host error as a guest Error. Caller disposes. */
  #errorValue(err: unknown): QuickJSHandle {
    const ctx = this.#ctx;
    const e = err as { name?: string; message?: string; code?: unknown };
    const h = ctx.newError(String(e?.message ?? err));
    if (e?.name) {
      const n = ctx.newString(e.name);
      ctx.setProp(h, "name", n);
      n.dispose();
    }
    if (typeof e?.code === "string") {
      const c = ctx.newString(e.code);
      ctx.setProp(h, "code", c);
      c.dispose();
    }
    return h;
  }

  /* --- teardown ---------------------------------------------------------- */

  /**
   * Release the isolate. Order matters: pending deferreds hold handles, and
   * QuickJS aborts the process from `JS_FreeRuntime` if anything is still
   * reachable — so a leak here is not a slow leak, it is a crash.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const p of this.#pending) {
      p.alive = false;
      try {
        p.dispose();
      } catch {
        /* already gone */
      }
    }
    this.#pending.clear();
    try {
      this.#onCallAbort?.dispose();
      this.#runtime.removeInterruptHandler();
      this.#ctx.dispose();
      this.#runtime.dispose();
    } catch (e) {
      // Reported rather than thrown: dispose runs on failure paths, and a
      // teardown complaint must not mask the failure that got us here.
      this.#opts.onInternalError(e);
    }
  }
}
