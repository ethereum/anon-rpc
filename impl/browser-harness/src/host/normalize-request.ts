// Normalizes the host's `fetch(input, init)` arguments (§5: `fetch: typeof
// fetch`) into the wire shape sent to the worker (§9.1), plus the transfer
// list and the effective abort signal.

import type { AnonRequestInit, HeaderList, PlainValue } from "../spec-types.js";
import { copyPlainValue } from "@anon-rpc/harness-core";

export type WireRequestInit = {
  method?: string;
  headers?: HeaderList;
  body?: Uint8Array | ReadableStream<Uint8Array>;
  redirect?: AnonRequestInit["redirect"];
  // The signal itself cannot cross the port; the worker reconstructs one and
  // the host drives it via "call-abort" events.
  hasSignal?: boolean;
  // §9.1 forwarded entries, already §9.4 copies. Kept apart from the fields
  // above so a host key such as "hasSignal" cannot collide with the wire's
  // own; the worker spreads them into requestInit.
  forwarded?: { [key: string]: PlainValue };
};

// The init members §9.1 models; every other key is a forwarded entry.
const MODELED = new Set(["method", "headers", "body", "redirect", "signal"]);

export type NormalizedRequest = {
  url: string;
  requestInit?: WireRequestInit;
  transfer?: Transferable[];
  signal?: AbortSignal;
};

export async function normalizeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<NormalizedRequest> {
  // Before any await: §9.1 copies forwarded values when fetch is called, so a
  // host mutating them afterwards cannot change the call.
  const forwarded = forwardedEntries(init);

  // A Request input carries method/headers/body/redirect/signal itself;
  // materialize it with any init overrides rather than reading init alone.
  if (input instanceof Request) {
    const needsDuplex = init?.body instanceof ReadableStream;
    const req = init
      ? new Request(input, { ...(needsDuplex ? { duplex: "half" } : {}), ...init } as RequestInit)
      : input;
    const headers: HeaderList = [];
    req.headers.forEach((v, k) => headers.push([k, v]));
    const requestInit: WireRequestInit = {
      method: req.method,
      headers,
      redirect: req.redirect,
      hasSignal: true, // a Request always has a signal
    };
    // Only init contributes: a Request keeps none of these entries.
    if (forwarded) requestInit.forwarded = forwarded;
    const transfer: Transferable[] = [];
    if (req.body) {
      requestInit.body = req.body;
      transfer.push(req.body as unknown as Transferable);
    }
    return { url: req.url, requestInit, transfer, signal: req.signal };
  }

  const url = typeof input === "string" ? input : input.href;
  if (!init) return { url };

  const src = init;
  const transfer: Transferable[] = [];
  let body: WireRequestInit["body"];
  // Content-Type that fetch would derive from the body type (e.g. FormData's
  // multipart boundary) — lost when we buffer to bytes unless carried along.
  let autoContentType: string | undefined;
  if (src.body != null) {
    if (src.body instanceof ReadableStream) {
      body = src.body;
      transfer.push(src.body as unknown as Transferable);
    } else if (typeof src.body === "string") {
      body = new TextEncoder().encode(src.body);
      transfer.push(body.buffer as ArrayBuffer); // freshly allocated: transfer, don't clone
    } else if (src.body instanceof Uint8Array || src.body instanceof ArrayBuffer) {
      // Caller-owned bytes: clone rather than transfer (the caller's buffer
      // must not be detached out from under it).
      body = src.body instanceof Uint8Array ? src.body : new Uint8Array(src.body);
    } else {
      // Blob/FormData/URLSearchParams…: buffer via a temp Response, keeping
      // the content type it derives (FormData is unparseable without it).
      const tmp = new Response(src.body as BodyInit);
      body = new Uint8Array(await tmp.arrayBuffer());
      autoContentType = tmp.headers.get("content-type") ?? undefined;
      transfer.push(body.buffer as ArrayBuffer);
    }
  }

  const requestInit: WireRequestInit = {};
  if (src.method) requestInit.method = src.method;
  const headers = headersToList(src.headers) ?? [];
  if (autoContentType && !headers.some(([k]) => k.toLowerCase() === "content-type")) {
    headers.push(["content-type", autoContentType]);
  }
  if (headers.length) requestInit.headers = headers;
  if (body !== undefined) requestInit.body = body;
  if (src.redirect) requestInit.redirect = src.redirect;
  if (src.signal) requestInit.hasSignal = true;
  if (forwarded) requestInit.forwarded = forwarded;

  return { url, requestInit, transfer, signal: src.signal ?? undefined };
}

/**
 * §9.1: every own enumerable string-keyed init entry §9.1 does not model,
 * copied as a plain value. One that is not plain fails the whole fetch with a
 * TypeError — dropping it would lose an option without anyone noticing.
 */
function forwardedEntries(init: RequestInit | undefined): WireRequestInit["forwarded"] {
  if (!init) return undefined;
  let out: WireRequestInit["forwarded"];
  for (const key of Object.keys(init)) {
    if (MODELED.has(key)) continue;
    out ??= {};
    Object.defineProperty(out, key, {
      value: copyPlainValue((init as Record<string, unknown>)[key], `init.${key}`),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

function headersToList(h: HeadersInit | undefined): HeaderList | undefined {
  if (!h) return undefined;
  const out: HeaderList = [];
  if (h instanceof Headers) h.forEach((v, k) => out.push([k, v]));
  else if (Array.isArray(h)) for (const [k, v] of h) out.push([k, v]);
  else for (const [k, v] of Object.entries(h)) out.push([k, String(v)]);
  return out;
}
