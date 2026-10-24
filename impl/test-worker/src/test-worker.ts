// The test worker: exercises the full capability surface (fetch calls, KPS,
// storage) and is what the repo's e2e drives. It is NOT the template to start
// an anon-client from — copy ../passthrough-worker for that.
//
// This is untrusted third-party code from the harness's point of view: its only
// platform is the global `anonRpcWorker` capability object (§7) plus the
// ambient `fetch` the worker environment happens to provide. It imports nothing
// at runtime — it is bundled to a standalone IIFE whose bytes are hashed (§4).
//
// Behaviour:
//   - `kps+echo://<ip>:<port>:<certhash>` URLs are routed over a real KPS stream
//     (proving the bridged transport): the request body is written, the echoed
//     bytes are read back, and returned as the response.
//   - every other URL is fulfilled by a plain `fetch` passthrough — the single
//     seam a production anon-client would replace with anonymized routing.
//   - a call counter persisted via the §11 storage capability (backed by the
//     harness, scoped to this worker's specifier address) is returned on every
//     response as `x-anon-rpc-call-count` — it survives worker restarts and
//     page reloads.

import type {
  AnonRpcWorkerApi,
  AnonFetchResponse,
  AnonRequestInit,
  ByteBody,
  HeaderList,
} from "./spec-types.js";

declare const anonRpcWorker: AnonRpcWorkerApi;

const KPS_ECHO_PREFIX = "kps+echo://";

(async () => {
  const { log } = anonRpcWorker;
  log.info("test-worker starting");
  anonRpcWorker.signalReady();

  for (;;) {
    let call;
    try {
      call = await anonRpcWorker.acceptCall();
    } catch (e) {
      log.error("acceptCall failed:", (e as Error)?.message ?? String(e));
      return;
    }
    if (call.kind !== "fetch") continue; // ignore unknown kinds (§8)
    call.respond(handleCall(call.url, call.requestInit));
  }
})();

async function handleCall(url: string, init?: AnonRequestInit): Promise<AnonFetchResponse> {
  const count = await bumpCallCount();
  const resp = await handleFetch(url, init);
  resp.headers.push(["x-anon-rpc-call-count", String(count)]);
  // §7.1: the host's init config is visible to worker code. Reported back so
  // the e2e can assert both delivery and the undefined-when-absent case.
  if (anonRpcWorker.config !== undefined) {
    resp.headers.push(["x-anon-rpc-config", JSON.stringify(anonRpcWorker.config)]);
  }
  // §9.1/§9.3: forwarded init entries reach the worker. `bytes` is described
  // rather than stringified so the e2e sees it arrived as a Uint8Array.
  if (init?.anonOptions !== undefined) {
    resp.headers.push(["x-anon-rpc-anon-options", JSON.stringify(init.anonOptions)]);
  }
  if (init?.custom !== undefined) {
    const { bytes, ...rest } = init.custom as { bytes?: unknown };
    const described = { ...rest, bytes: bytes instanceof Uint8Array ? `u8:${[...bytes].join(",")}` : typeof bytes };
    resp.headers.push(["x-anon-rpc-custom", JSON.stringify(described)]);
  }
  return resp;
}

// Demonstrates §11 storage: a counter that persists across calls, worker
// restarts, and page reloads. (Reads and writes are not atomic; concurrent
// calls could observe the same value — fine for a demo counter.)
async function bumpCallCount(): Promise<number> {
  const { storage } = anonRpcWorker;
  const prev = await storage.get("stats/call-count");
  const count = (prev ? Number(new TextDecoder().decode(prev)) : 0) + 1;
  await storage.set("stats/call-count", new TextEncoder().encode(String(count)));
  return count;
}

async function handleFetch(url: string, init?: AnonRequestInit): Promise<AnonFetchResponse> {
  if (url.startsWith(KPS_ECHO_PREFIX)) {
    return kpsEcho(url.slice(KPS_ECHO_PREFIX.length), init);
  }
  return passthrough(url, init);
}

async function kpsEcho(addr: string, init?: AnonRequestInit): Promise<AnonFetchResponse> {
  anonRpcWorker.log.debug("routing over kps to", addr);

  // An `x-kps-via: dial` request header routes through kps.dial + an explicit
  // connection (exercising that bridge path and exposing remoteAddress);
  // otherwise the kps.openStream sugar is used. Both paths are e2e-covered.
  const viaDial = init?.headers?.some(([k, v]) => k.toLowerCase() === "x-kps-via" && v === "dial");
  const headers: [string, string][] = [["content-type", "application/octet-stream"]];

  let stream;
  let closeConn: (() => Promise<void>) | undefined;
  if (viaDial) {
    const conn = await anonRpcWorker.kps.dial(addr);
    headers.push(["x-kps-remote", `${conn.remoteAddress.ip}:${conn.remoteAddress.port}`]);
    stream = await conn.openStream();
    closeConn = () => conn.close();
  } else {
    stream = await anonRpcWorker.kps.openStream(addr);
  }

  // Write the request body, then signal EOF so the echo server copies it back.
  const body = await readAll(init?.body);
  const writer = stream.writable.getWriter();
  if (body.byteLength) await writer.write(body);
  await writer.close(); // maps to closeWrite()

  const echoed = await readAll(stream.readable);
  await stream.close();
  await closeConn?.();

  return { status: 200, headers, body: echoed };
}

async function passthrough(url: string, init?: AnonRequestInit): Promise<AnonFetchResponse> {
  const resp = await fetch(url, await toFetchInit(init));
  const buf = new Uint8Array(await resp.arrayBuffer());
  const headers: HeaderList = [];
  resp.headers.forEach((v, k) => headers.push([k, v]));
  return { status: resp.status, headers, body: buf, url: resp.url };
}

async function toFetchInit(init?: AnonRequestInit): Promise<RequestInit | undefined> {
  if (!init) return undefined;
  const out: RequestInit = {};
  if (init.method) out.method = init.method;
  if (init.headers) out.headers = init.headers as [string, string][];
  if (init.body) {
    // A streaming body is buffered before handing it to fetch: Chromium
    // rejects stream bodies without `duplex: "half"`, and even with it only
    // supports upload streaming over HTTP/2 — buffering works everywhere.
    // A worker that wants true streaming uploads can pass the stream through
    // with { duplex: "half" } and accept the h2 requirement.
    out.body = init.body instanceof ReadableStream ? ((await readAll(init.body)) as BodyInit) : (init.body as BodyInit);
  }
  if (init.redirect) out.redirect = init.redirect;
  if (init.signal) out.signal = init.signal;
  return out;
}

async function readAll(body: ByteBody | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
