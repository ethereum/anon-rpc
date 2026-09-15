// The guest platform. This file is SOURCE TEXT, evaluated inside the QuickJS
// isolate before the worker bundle — it never runs in Node, and `loader: text`
// in build.mjs is what keeps esbuild from trying.
//
// A bare QuickJS context has the ECMAScript intrinsics and nothing else: no
// console, no timers, no TextEncoder, no URL, no fetch, no streams (measured —
// probe/qjs-probe.mjs prints the list). So everything a worker needs to be a
// JS program has to be put here, and the interesting part is what that split
// buys:
//
//   * Everything defined in THIS file is pure computation. It encodes bytes,
//     parses strings, queues chunks. Handing it to the guest grants no
//     authority over anything, so none of it needs a policy decision.
//   * Authority arrives only through the two functions the host installs,
//     `__host_send` and `__host_request`. They are captured by the closure
//     below and then DELETED from the global object, so guest code cannot
//     reach the raw bridge — only the §7 API assembled over it.
//
// That is the property the whole strategy rests on: the guest's global object
// can be enumerated, and every name on it is either something from this file
// (no authority) or a capability the host explicitly chose to install. There
// is no third category, and no ambient platform to audit.
//
// Two host functions are SYNCHRONOUS, because the APIs they back are:
// `__host_random` (crypto.getRandomValues) and `__host_url` (the WHATWG URL
// parser). Both are authority-free — entropy and string parsing — and both are
// delegated rather than reimplemented because matching the platform's exact
// semantics matters more here than purity.

/* eslint-disable no-undef */
(function installPlatform(send, request, hostRandom, hostParseUrl, capabilities) {
  "use strict";

  // Hide the raw bridge. After this the only route out of the isolate is the
  // API built below; a test asserts the names are gone.
  delete globalThis.__host_send;
  delete globalThis.__host_request;
  delete globalThis.__host_random;
  delete globalThis.__host_url;
  delete globalThis.__host_capabilities;

  const def = (name, value) => {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };

  /* --- errors ------------------------------------------------------------ */

  // §12 error shape. The host sends `{name, message, code}`; rebuild a real
  // Error so guest `catch` blocks and `instanceof Error` behave normally.
  function reviveError(e) {
    const err = new Error((e && e.message) || "worker capability failed");
    if (e && e.name) err.name = e.name;
    if (e && e.code) err.code = e.code;
    return err;
  }

  function codedError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  /* --- the bridge -------------------------------------------------------- */

  // Structure crosses as JSON and bytes cross as an ArrayBuffer, deliberately:
  // it makes the entire host interface two functions with a
  // (string, string, ArrayBuffer?) signature. Nothing else — no host object,
  // no host function, no prototype — is ever handed in, which is what closes
  // the realm escape that `node:vm` leaves open.
  function post(method, args, bytes) {
    send(method, JSON.stringify(args === undefined ? null : args), bytes || null);
  }

  async function ask(method, args, bytes) {
    const raw = await request(method, JSON.stringify(args === undefined ? null : args), bytes || null);
    // [json, bytes] — the host always answers with both slots, either may be null.
    const value = raw[0] === null ? undefined : JSON.parse(raw[0]);
    if (value && value.__error) throw reviveError(value.__error);
    return { value, bytes: raw[1] ? new Uint8Array(raw[1]) : undefined };
  }

  const askValue = async (method, args, bytes) => (await ask(method, args, bytes)).value;

  /* --- text encoding ----------------------------------------------------- */

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input) {
      const s = String(input === undefined ? "" : input);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        // Combine a surrogate pair into one code point; a lone surrogate
        // becomes U+FFFD, which is what the platform does.
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
          if (next >= 0xdc00 && next <= 0xdfff) {
            c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
            i++;
          } else {
            c = 0xfffd;
          }
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          c = 0xfffd;
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        else
          out.push(
            0xf0 | (c >> 18),
            0x80 | ((c >> 12) & 0x3f),
            0x80 | ((c >> 6) & 0x3f),
            0x80 | (c & 0x3f),
          );
      }
      return new Uint8Array(out);
    }
    encodeInto(source, dest) {
      const bytes = this.encode(source);
      const n = Math.min(bytes.length, dest.length);
      dest.set(bytes.subarray(0, n));
      return { read: source.length, written: n };
    }
  }

  class TextDecoder {
    constructor(label, opts) {
      const enc = String(label || "utf-8").toLowerCase();
      if (enc !== "utf-8" && enc !== "utf8" && enc !== "unicode-1-1-utf-8") {
        // Better a clear error than silently mis-decoding: this platform is
        // UTF-8 only, and a worker asking for latin1 should find out.
        throw new RangeError(`TextDecoder: only utf-8 is supported here (got ${label})`);
      }
      this.fatal = !!(opts && opts.fatal);
      this.ignoreBOM = !!(opts && opts.ignoreBOM);
    }
    get encoding() {
      return "utf-8";
    }
    decode(input) {
      if (input === undefined) return "";
      const b =
        input instanceof Uint8Array
          ? input
          : input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = "";
      let i = 0;
      // Built in chunks: string += in a tight loop over a megabyte body is the
      // difference between milliseconds and seconds in QuickJS.
      let parts = [];
      while (i < b.length) {
        const c = b[i];
        let cp;
        let len;
        if (c < 0x80) {
          cp = c;
          len = 1;
        } else if ((c & 0xe0) === 0xc0) {
          cp = c & 0x1f;
          len = 2;
        } else if ((c & 0xf0) === 0xe0) {
          cp = c & 0x0f;
          len = 3;
        } else if ((c & 0xf8) === 0xf0) {
          cp = c & 0x07;
          len = 4;
        } else {
          cp = 0xfffd;
          len = 1;
        }
        if (len > 1) {
          if (i + len > b.length) {
            cp = 0xfffd;
            len = b.length - i;
          } else {
            let ok = true;
            for (let k = 1; k < len; k++) {
              if ((b[i + k] & 0xc0) !== 0x80) {
                ok = false;
                break;
              }
              cp = (cp << 6) | (b[i + k] & 0x3f);
            }
            if (!ok) {
              cp = 0xfffd;
              len = 1;
            }
          }
        }
        if (cp === 0xfffd && this.fatal) throw new TypeError("TextDecoder: invalid UTF-8");
        if (cp > 0xffff) {
          cp -= 0x10000;
          parts.push(String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)));
        } else {
          parts.push(String.fromCharCode(cp));
        }
        i += len;
        if (parts.length >= 4096) {
          out += parts.join("");
          parts = [];
        }
      }
      out += parts.join("");
      if (!this.ignoreBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
      return out;
    }
  }

  /* --- abort ------------------------------------------------------------- */

  // A small EventTarget-shaped AbortSignal. Workers use `signal.aborted`,
  // `addEventListener("abort")` and `throwIfAborted`; the full EventTarget
  // contract (capture, once, bubbling) is not part of that.
  class AbortSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      Object.defineProperty(this, "_listeners", { value: [], enumerable: false });
    }
    addEventListener(type, fn) {
      if (type === "abort" && typeof fn === "function") this._listeners.push(fn);
    }
    removeEventListener(type, fn) {
      if (type !== "abort") return;
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason;
    }
    static abort(reason) {
      const c = new AbortController();
      c.abort(reason);
      return c.signal;
    }
    static timeout(ms) {
      const c = new AbortController();
      setTimeout(() => c.abort(codedError("timeout", "The operation was aborted due to timeout")), ms);
      return c.signal;
    }
  }

  class AbortController {
    constructor() {
      Object.defineProperty(this, "signal", { value: new AbortSignal(), enumerable: true });
    }
    abort(reason) {
      const s = this.signal;
      if (s.aborted) return;
      s.aborted = true;
      if (reason === undefined) {
        const e = new Error("The operation was aborted.");
        e.name = "AbortError";
        reason = e;
      }
      s.reason = reason;
      const evt = { type: "abort", target: s };
      if (typeof s.onabort === "function") s.onabort.call(s, evt);
      for (const fn of s._listeners.slice()) {
        try {
          fn.call(s, evt);
        } catch {
          // An abort listener that throws must not stop the others, and there
          // is nobody to report it to inside the isolate.
        }
      }
    }
  }

  /* --- timers ------------------------------------------------------------ */

  // The isolate has no clock of its own to wait on, so a timer is a host
  // request that resolves late. `Date.now()` works without help (QuickJS reads
  // it through its own host binding), so only the *waiting* needs bridging.
  let nextTimer = 1;
  const liveTimers = new Set();

  function setTimeout_(fn, ms, ...args) {
    if (typeof fn !== "function") throw new TypeError("setTimeout: callback is not a function");
    const id = nextTimer++;
    liveTimers.add(id);
    askValue("timer", { id, ms: Math.max(0, Number(ms) || 0) }).then(
      () => {
        if (!liveTimers.delete(id)) return; // cleared while pending
        fn(...args);
      },
      () => void liveTimers.delete(id),
    );
    return id;
  }

  function clearTimeout_(id) {
    if (liveTimers.delete(id)) post("timer.cancel", { id });
  }

  // setInterval is setTimeout that re-arms, so that a cleared interval stops
  // re-arming rather than accumulating host timers.
  function setInterval_(fn, ms, ...args) {
    const id = nextTimer++;
    liveTimers.add(id);
    const tick = () => {
      if (!liveTimers.has(id)) return;
      askValue("timer", { id, ms: Math.max(0, Number(ms) || 0) }).then(() => {
        if (!liveTimers.has(id)) return;
        try {
          fn(...args);
        } finally {
          tick();
        }
      }, noop);
    };
    tick();
    return id;
  }

  const noop = () => {};

  /* --- streams ----------------------------------------------------------- */

  // A pull-based ReadableStream: enough for §9 bodies and the socket
  // capability. Deliberately NOT the full standard — no tee, no pipeThrough,
  // no BYOB — because those are not what crosses an anon-rpc boundary, and a
  // half-correct full implementation is worse than a correct small one.
  class ReadableStream {
    constructor(source = {}, _strategy) {
      const self = this;
      Object.defineProperty(this, "_s", {
        enumerable: false,
        value: {
          source,
          queue: [],
          closed: false,
          errored: undefined,
          locked: false,
          pullPending: false,
          waiters: [],
        },
      });
      const controller = {
        enqueue(chunk) {
          const s = self._s;
          if (s.closed) throw new TypeError("stream is closed");
          s.queue.push(chunk);
          s.waiters.shift()?.();
        },
        close() {
          const s = self._s;
          s.closed = true;
          while (s.waiters.length) s.waiters.shift()();
        },
        error(e) {
          const s = self._s;
          s.errored = e;
          while (s.waiters.length) s.waiters.shift()();
        },
        get desiredSize() {
          return Math.max(0, 1 - self._s.queue.length);
        },
      };
      Object.defineProperty(this, "_controller", { value: controller, enumerable: false });
      if (typeof source.start === "function") {
        try {
          Promise.resolve(source.start(controller)).catch((e) => controller.error(e));
        } catch (e) {
          controller.error(e);
        }
      }
    }

    get locked() {
      return this._s.locked;
    }

    getReader() {
      const s = this._s;
      if (s.locked) throw new TypeError("ReadableStream is already locked");
      s.locked = true;
      const stream = this;
      return {
        async read() {
          for (;;) {
            if (s.errored !== undefined) throw s.errored;
            if (s.queue.length) return { value: s.queue.shift(), done: false };
            if (s.closed) return { value: undefined, done: true };
            // Ask the source for more, then park until something arrives.
            if (typeof s.source.pull === "function" && !s.pullPending) {
              s.pullPending = true;
              try {
                await s.source.pull(stream._controller);
              } catch (e) {
                s.errored = e;
              } finally {
                s.pullPending = false;
              }
              continue;
            }
            await new Promise((res) => s.waiters.push(res));
          }
        },
        async cancel(reason) {
          s.closed = true;
          s.queue.length = 0;
          if (typeof s.source.cancel === "function") await s.source.cancel(reason);
        },
        releaseLock() {
          s.locked = false;
        },
        get closed() {
          return Promise.resolve();
        },
      };
    }

    async cancel(reason) {
      const r = this.getReader();
      await r.cancel(reason);
      r.releaseLock();
    }

    // `for await (const chunk of stream)` is how most worker code reads one.
    [Symbol.asyncIterator]() {
      const reader = this.getReader();
      return {
        async next() {
          const r = await reader.read();
          if (r.done) reader.releaseLock();
          return r;
        },
        async return() {
          await reader.cancel();
          reader.releaseLock();
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
  }

  class WritableStream {
    constructor(sink = {}, _strategy) {
      Object.defineProperty(this, "_sink", { value: sink, enumerable: false });
      Object.defineProperty(this, "_state", { value: { locked: false }, enumerable: false });
    }
    get locked() {
      return this._state.locked;
    }
    getWriter() {
      if (this._state.locked) throw new TypeError("WritableStream is already locked");
      this._state.locked = true;
      const sink = this._sink;
      const state = this._state;
      const controller = { error: noop, signal: new AbortController().signal };
      return {
        async write(chunk) {
          if (typeof sink.write === "function") await sink.write(chunk, controller);
        },
        async close() {
          if (typeof sink.close === "function") await sink.close();
        },
        async abort(reason) {
          if (typeof sink.abort === "function") await sink.abort(reason);
        },
        releaseLock() {
          state.locked = false;
        },
        get desiredSize() {
          return 1;
        },
        get ready() {
          return Promise.resolve();
        },
        get closed() {
          return Promise.resolve();
        },
      };
    }
  }

  /** Drain any §9 byte body to a single Uint8Array. */
  async function readAllBody(body) {
    if (body === undefined || body === null) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (typeof body.getReader !== "function") {
      throw new TypeError("body is neither bytes nor a ReadableStream");
    }
    const chunks = [];
    let total = 0;
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const u = value instanceof Uint8Array ? value : new Uint8Array(value);
        chunks.push(u);
        total += u.length;
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /* --- headers / response ------------------------------------------------ */

  class Headers {
    constructor(init) {
      Object.defineProperty(this, "_h", { value: [], enumerable: false });
      if (!init) return;
      if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v);
      else if (typeof init.forEach === "function") init.forEach((v, k) => this.append(k, v));
      else for (const k of Object.keys(init)) this.append(k, init[k]);
    }
    append(k, v) {
      this._h.push([String(k).toLowerCase(), String(v)]);
    }
    set(k, v) {
      this.delete(k);
      this.append(k, v);
    }
    get(k) {
      const key = String(k).toLowerCase();
      const hits = this._h.filter((e) => e[0] === key).map((e) => e[1]);
      return hits.length ? hits.join(", ") : null;
    }
    has(k) {
      const key = String(k).toLowerCase();
      return this._h.some((e) => e[0] === key);
    }
    delete(k) {
      const key = String(k).toLowerCase();
      for (let i = this._h.length - 1; i >= 0; i--) if (this._h[i][0] === key) this._h.splice(i, 1);
    }
    forEach(fn, thisArg) {
      for (const [k, v] of this._h.slice()) fn.call(thisArg, v, k, this);
    }
    *entries() {
      for (const e of this._h.slice()) yield [e[0], e[1]];
    }
    *keys() {
      for (const e of this._h.slice()) yield e[0];
    }
    *values() {
      for (const e of this._h.slice()) yield e[1];
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toList() {
      return this._h.slice();
    }
  }

  // The response shape a granted `fetch` answers with. Not the full Fetch
  // Response (no clone, no formData) — the methods a worker uses on an RPC
  // response, plus the §9 fields.
  class Response {
    constructor(body, init = {}) {
      Object.defineProperty(this, "_body", { value: body, enumerable: false, writable: true });
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText || "";
      this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
      this.url = init.url || "";
      this.redirected = !!init.redirected;
      this.bodyUsed = false;
    }
    get ok() {
      return this.status >= 200 && this.status < 300;
    }
    get body() {
      const bytes = this._body;
      if (bytes === null || bytes === undefined) return null;
      let sent = false;
      return new ReadableStream({
        pull(c) {
          if (sent) return c.close();
          sent = true;
          c.enqueue(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        },
      });
    }
    async arrayBuffer() {
      this.bodyUsed = true;
      const b = await readAllBody(this._body);
      // A copy, so that the caller cannot reach past byteLength into a pooled
      // buffer the host handed us.
      return b.slice().buffer;
    }
    async bytes() {
      this.bodyUsed = true;
      return (await readAllBody(this._body)).slice();
    }
    async text() {
      this.bodyUsed = true;
      return new TextDecoder().decode(await readAllBody(this._body));
    }
    async json() {
      return JSON.parse(await this.text());
    }
  }

  /* --- URL --------------------------------------------------------------- */

  // Delegated to the host's WHATWG parser rather than reimplemented: URL
  // parsing is authority-free (it is string manipulation), and a worker that
  // builds an RPC endpoint from configuration needs the platform's exact
  // behaviour, punycode and all, not an approximation of it.
  class URL {
    constructor(input, base) {
      const parsed = hostParseUrl(String(input), base === undefined ? null : String(base));
      if (!parsed) throw new TypeError(`Invalid URL: ${String(input)}`);
      const p = JSON.parse(parsed);
      this.href = p.href;
      this.protocol = p.protocol;
      this.username = p.username;
      this.password = p.password;
      this.host = p.host;
      this.hostname = p.hostname;
      this.port = p.port;
      this.pathname = p.pathname;
      this.hash = p.hash;
      this.origin = p.origin;
      Object.defineProperty(this, "searchParams", {
        value: new URLSearchParams(p.search),
        enumerable: true,
      });
      this.search = p.search;
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
  }

  class URLSearchParams {
    constructor(init) {
      Object.defineProperty(this, "_p", { value: [], enumerable: false });
      if (!init) return;
      if (typeof init === "string") {
        for (const pair of init.replace(/^\?/, "").split("&")) {
          if (!pair) continue;
          const i = pair.indexOf("=");
          const k = i < 0 ? pair : pair.slice(0, i);
          const v = i < 0 ? "" : pair.slice(i + 1);
          this._p.push([dec(k), dec(v)]);
        }
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) this._p.push([String(k), String(v)]);
      } else {
        for (const k of Object.keys(init)) this._p.push([k, String(init[k])]);
      }
    }
    append(k, v) {
      this._p.push([String(k), String(v)]);
    }
    set(k, v) {
      this.delete(k);
      this.append(k, v);
    }
    get(k) {
      const hit = this._p.find((e) => e[0] === String(k));
      return hit ? hit[1] : null;
    }
    getAll(k) {
      return this._p.filter((e) => e[0] === String(k)).map((e) => e[1]);
    }
    has(k) {
      return this._p.some((e) => e[0] === String(k));
    }
    delete(k) {
      for (let i = this._p.length - 1; i >= 0; i--) if (this._p[i][0] === String(k)) this._p.splice(i, 1);
    }
    forEach(fn, thisArg) {
      for (const [k, v] of this._p.slice()) fn.call(thisArg, v, k, this);
    }
    *entries() {
      for (const e of this._p.slice()) yield [e[0], e[1]];
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this._p.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
    }
  }

  const dec = (s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, "+");

  /* --- crypto ------------------------------------------------------------ */

  // Entropy is authority-free but cannot be manufactured inside the isolate,
  // so it is bridged — synchronously, because getRandomValues is synchronous
  // and an anonymizing client needs it for nonces and key material.
  const cryptoObj = {
    getRandomValues(view) {
      if (!ArrayBuffer.isView(view)) throw new TypeError("getRandomValues: not a TypedArray");
      const bytes = new Uint8Array(hostRandom(view.byteLength));
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
      return view;
    },
    randomUUID() {
      const b = new Uint8Array(hostRandom(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
    // Deliberately absent rather than faked: SubtleCrypto is a large surface
    // and a worker needs to feature-detect it, not get a stub that lies. A
    // future version bridges it; see README.
    subtle: undefined,
  };

  /* --- console → §13 log ------------------------------------------------- */

  // §13 says logs are diagnostic and untrusted. Arguments are flattened to
  // strings HERE so that nothing structured — and nothing with a getter or a
  // toJSON that runs guest code on the host's thread — crosses the boundary.
  const fmt = (v, depth = 0) => {
    if (typeof v === "string") return v;
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
    if (typeof v !== "object") return String(v);
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (depth > 2) return "[...]";
    try {
      if (Array.isArray(v)) return `[${v.slice(0, 50).map((x) => fmt(x, depth + 1)).join(", ")}]`;
      if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
      const keys = Object.keys(v).slice(0, 30);
      return `{${keys.map((k) => `${k}: ${fmt(v[k], depth + 1)}`).join(", ")}}`;
    } catch {
      return "[unprintable]";
    }
  };

  const logAt = (level) => (...args) => post("log", { level, args: args.map((a) => fmt(a)) });
  const consoleObj = {
    log: logAt("info"),
    info: logAt("info"),
    debug: logAt("debug"),
    warn: logAt("warn"),
    error: logAt("error"),
    trace: logAt("debug"),
  };

  /* --- §7 capability API -------------------------------------------------- */

  function unsupported(what) {
    throw codedError("unsupported", `${what} is not implemented by the Node harness yet`);
  }

  // §10/§11 are REQUIRED capabilities this harness has not implemented, so
  // they are PRESENT and throw `unsupported` (§12) rather than missing: a
  // worker may assume a spec-mandated capability exists and deserves a
  // documented error, not a TypeError. Genuinely optional capabilities take
  // the opposite convention — `socket` below is absent when not granted, so
  // `if (anonRpcWorker.socket)` answers truthfully.
  const kps = {
    dial: () => unsupported("anonRpcWorker.kps.dial"),
    openStream: () => unsupported("anonRpcWorker.kps.openStream"),
  };
  const storage = {
    get: () => unsupported("anonRpcWorker.storage.get"),
    set: () => unsupported("anonRpcWorker.storage.set"),
    delete: () => unsupported("anonRpcWorker.storage.delete"),
    has: () => unsupported("anonRpcWorker.storage.has"),
    list: () => unsupported("anonRpcWorker.storage.list"),
    clear: () => unsupported("anonRpcWorker.storage.clear"),
  };

  /**
   * The bridged TCP capability. The isolate has no sockets — it has no syscalls
   * at all — so this is not a restriction of an ambient ability, it is the only
   * network that exists in here. The host resolves the name, applies its
   * address policy to the RESOLVED address, dials, and owns the descriptor.
   *
   * Chunks are pulled one request at a time, which is what makes the host's
   * socket buffer the backpressure: nothing is read from the peer until guest
   * code asks for the next chunk.
   */
  function makeSocket() {
    return {
      async connect(host, port, opts) {
        const signal = opts && opts.signal;
        const { value } = await ask("socket.connect", { host, port });
        const id = value.id;

        let readDone = false;
        const readable = new ReadableStream({
          async pull(c) {
            if (readDone) return c.close();
            const r = await ask("socket.read", { id });
            if (r.value && r.value.done) {
              readDone = true;
              return c.close();
            }
            if (r.bytes && r.bytes.length) c.enqueue(r.bytes);
          },
          cancel() {
            post("socket.close", { id });
          },
        });

        const writable = new WritableStream({
          async write(chunk) {
            const u = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            // The ArrayBuffer is what crosses, so send an exact-length copy
            // rather than a view's whole backing store.
            await ask("socket.write", { id }, u.slice().buffer);
          },
          close() {
            post("socket.end", { id });
          },
          abort() {
            post("socket.close", { id });
          },
        });

        if (signal) {
          signal.addEventListener("abort", () => post("socket.close", { id }));
        }

        return {
          readable,
          writable,
          remoteAddress: value.remoteAddress,
          closeWrite: async () => void post("socket.end", { id }),
          close: async () => void post("socket.close", { id }),
          closed: askValue("socket.closed", { id }),
        };
      },
    };
  }

  /**
   * A granted `fetch`. Under this isolation strategy `fetch` is a CAPABILITY,
   * not a platform fact: a bare isolate has none, and the host installs this
   * only when it chose to. That is the substantive difference from the browser
   * harness and from the vm-based one, where `fetch` was ambient and the best
   * we could do was confine what it reached.
   *
   * Requests and responses are buffered. Streaming them means a chunk protocol
   * like the socket capability's, which §9 allows but does not require.
   */
  function makeFetch() {
    return async function fetch(input, init) {
      const url = typeof input === "string" ? input : String(input && input.url ? input.url : input);
      const i = init || {};
      const headers =
        i.headers instanceof Headers
          ? i.headers.toList()
          : Array.isArray(i.headers)
            ? i.headers.map(([k, v]) => [String(k).toLowerCase(), String(v)])
            : i.headers
              ? Object.keys(i.headers).map((k) => [k.toLowerCase(), String(i.headers[k])])
              : [];
      const body = i.body === undefined || i.body === null ? undefined : await readAllBody(i.body);

      if (i.signal && i.signal.aborted) throw i.signal.reason;

      const r = await ask(
        "fetch",
        { url, method: i.method || "GET", headers, redirect: i.redirect },
        body && body.length ? body.slice().buffer : null,
      );
      return new Response(r.bytes || new Uint8Array(0), {
        status: r.value.status,
        statusText: r.value.statusText,
        headers: new Headers(r.value.headers),
        url: r.value.url,
      });
    };
  }

  let failed = false;
  let readied = false;
  let nextInboundSeq = 1;
  const inFlight = new Map();

  const anonRpcWorker = {
    config: capabilities.config,
    kps,
    storage,
    log: {
      debug: (...a) => post("log", { level: "debug", args: a.map((x) => fmt(x)) }),
      info: (...a) => post("log", { level: "info", args: a.map((x) => fmt(x)) }),
      warn: (...a) => post("log", { level: "warn", args: a.map((x) => fmt(x)) }),
      error: (...a) => post("log", { level: "error", args: a.map((x) => fmt(x)) }),
    },

    signalReady() {
      if (failed || readied) return; // §7: failure is final
      readied = true;
      post("worker.ready");
    },

    signalFailed(reason) {
      if (failed) return;
      failed = true;
      post("worker.failed", reason ? { code: reason.code, message: reason.message } : null);
    },

    async acceptCall(opts) {
      const signal = opts && opts.signal;
      const seq = nextInboundSeq++;
      if (signal) {
        if (signal.aborted) throw signal.reason;
        signal.addEventListener("abort", () => post("call.accept.abort", { seq }));
      }
      // `ask`, not `askValue`: an inbound request BODY arrives in the bytes
      // slot alongside the JSON, and dropping it silently turns every POST
      // into an empty one.
      const reply = await ask("call.accept", { seq });
      const accepted = reply.value;

      // The host cannot send an AbortSignal — nothing but JSON and bytes
      // crosses — so it sends an abort EVENT and the signal is synthesised on
      // this side, which is what §9 requires the worker to receive.
      const ac = new AbortController();
      inFlight.set(accepted.id, ac);

      const requestInit = Object.assign({}, accepted.requestInit || {}, { signal: ac.signal });
      if (reply.bytes && reply.bytes.length) requestInit.body = reply.bytes;

      return {
        kind: "fetch",
        url: accepted.url,
        requestInit,
        respond(response) {
          // §8: respond takes a value or a promise and the worker need not
          // await it, so the settling is handled here.
          Promise.resolve(response).then(
            async (r) => {
              inFlight.delete(accepted.id);
              try {
                const bytes = await readAllBody(r && r.body);
                post(
                  "call.respond",
                  {
                    id: accepted.id,
                    status: r.status,
                    headers: r.headers instanceof Headers ? r.headers.toList() : r.headers || [],
                    url: r.url,
                  },
                  bytes.length ? bytes.slice().buffer : null,
                );
              } catch (e) {
                post("call.fail", { id: accepted.id, error: errToWire(e) });
              }
            },
            (e) => {
              inFlight.delete(accepted.id);
              post("call.fail", { id: accepted.id, error: errToWire(e) });
            },
          );
        },
      };
    },
  };

  function errToWire(e) {
    if (e instanceof Error) {
      return { name: e.name, message: e.message, code: typeof e.code === "string" ? e.code : undefined };
    }
    return { name: "Error", message: String(e) };
  }

  // The host's abort for an accepted call becomes a real signal in here.
  globalThis.__onCallAbort = (id) => {
    const ac = inFlight.get(id);
    if (ac) {
      ac.abort();
      inFlight.delete(id);
    }
  };

  if (capabilities.socket) anonRpcWorker.socket = makeSocket();

  /* --- install ------------------------------------------------------------ */

  def("TextEncoder", TextEncoder);
  def("TextDecoder", TextDecoder);
  def("AbortController", AbortController);
  def("AbortSignal", AbortSignal);
  def("ReadableStream", ReadableStream);
  def("WritableStream", WritableStream);
  def("Headers", Headers);
  def("Response", Response);
  def("URL", URL);
  def("URLSearchParams", URLSearchParams);
  def("crypto", cryptoObj);
  def("console", consoleObj);
  def("setTimeout", setTimeout_);
  def("clearTimeout", clearTimeout_);
  def("setInterval", setInterval_);
  def("clearInterval", clearTimeout_);
  def("queueMicrotask", (fn) => void Promise.resolve().then(fn));
  def("structuredClone", (v) => deepClone(v, new Map()));
  if (capabilities.fetch) def("fetch", makeFetch());
  def("anonRpcWorker", anonRpcWorker);

  function deepClone(v, seen) {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return seen.get(v);
    let out;
    if (v instanceof Uint8Array) out = v.slice();
    else if (v instanceof ArrayBuffer) out = v.slice(0);
    else if (v instanceof Date) out = new Date(v.getTime());
    else if (Array.isArray(v)) {
      out = [];
      seen.set(v, out);
      for (const x of v) out.push(deepClone(x, seen));
      return out;
    } else if (v instanceof Map) {
      out = new Map();
      seen.set(v, out);
      for (const [k, x] of v) out.set(deepClone(k, seen), deepClone(x, seen));
      return out;
    } else if (v instanceof Set) {
      out = new Set();
      seen.set(v, out);
      for (const x of v) out.add(deepClone(x, seen));
      return out;
    } else {
      out = {};
      seen.set(v, out);
      for (const k of Object.keys(v)) out[k] = deepClone(v[k], seen);
      return out;
    }
    seen.set(v, out);
    return out;
  }
})(
  globalThis.__host_send,
  globalThis.__host_request,
  globalThis.__host_random,
  globalThis.__host_url,
  globalThis.__host_capabilities,
);
