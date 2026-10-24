// §4.1–4.2 — fetching a worker bundle over KPS.
//
// A kps resolver string ("kps:<addr>/<path>") locates a bundle on a KPS
// server. The exchange is one GET in HTTP/1.1 syntax on one KPS stream:
// request written then closeWrite(), response read to EOF. The request
// builder and response parser are pure (unit-tested in node); only
// fetchBundleOverKps touches the WebRTC client, via dynamic import so this
// module stays loadable outside a browser.

import type { ResolverKind } from "@anon-rpc/harness-core";

const enc = new TextEncoder();
const CRLF = "\r\n";

/** Parse "kps:<addr>/<path>". Returns undefined when not a kps entry at all. */
export function parseKpsResolver(entry: string): { addr: string; path: string } | undefined {
  if (!entry.startsWith("kps:")) return undefined;
  const rest = entry.slice("kps:".length);
  // Split at the FIRST "/": certhashes (base64url) and bracketed IPv6 hosts
  // never contain one, so this is unambiguous (§4.1). Deliberately not a URL
  // parser — the address form is not a valid URL authority.
  const slash = rest.indexOf("/");
  if (slash <= 0) throw new Error("malformed kps resolver: missing /path");
  const addr = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (addr.split(":").length < 3) throw new Error("malformed kps resolver: bad address");
  return { addr, path };
}

/** The single-exchange GET request (§4.2). Host = certhash of the dialed address. */
export function buildKpsHttpRequest(
  path: string,
  certhash: string,
  acceptEncodings: string[] = [],
): Uint8Array {
  const accept = acceptEncodings.length
    ? `Accept-Encoding: ${acceptEncodings.join(", ")}${CRLF}`
    : "";
  return enc.encode(`GET ${path} HTTP/1.1${CRLF}Host: ${certhash}${CRLF}${accept}${CRLF}`);
}

// HTTP content codings, in advertisement order, mapped to the format names a
// DecompressionStream might know them by (environments differ on br/zstd
// naming, and most don't ship them yet — probing covers whatever exists).
const CODING_FORMATS: [coding: string, formats: string[]][] = [
  ["zstd", ["zstd"]],
  ["br", ["br", "brotli"]],
  ["gzip", ["gzip"]],
  ["deflate", ["deflate"]], // HTTP "deflate" is the zlib format, as is the API's
];

type DecompressionStreamCtor = new (format: string) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

function decompressionCtor(): DecompressionStreamCtor | undefined {
  return (globalThis as { DecompressionStream?: DecompressionStreamCtor }).DecompressionStream;
}

/** The environment's format name for an HTTP coding, or undefined if undecodable. */
function decompressionFormatFor(coding: string): string | undefined {
  const DS = decompressionCtor();
  if (!DS) return undefined;
  for (const format of CODING_FORMATS.find(([c]) => c === coding)?.[1] ?? []) {
    try {
      new DS(format);
      return format;
    } catch {
      // format unknown to this environment: try the next name / give up
    }
  }
  return undefined;
}

/**
 * §4.2: the content codings this environment can decode with its ambient
 * facilities — what the request advertises. MUST NOT list anything
 * undecodable, so each coding is probed by constructing a decompressor.
 */
export function ambientCodings(): string[] {
  return CODING_FORMATS.map(([c]) => c).filter((c) => decompressionFormatFor(c) !== undefined);
}

/**
 * Decode a Content-Encoding'd body, enforcing the cap on the DECODED bytes
 * (§4.2: a small compressed body must not expand past the cap).
 */
export async function decodeBody(
  coding: string,
  body: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  const DS = decompressionCtor();
  const format = decompressionFormatFor(coding);
  if (!DS || format === undefined) throw new Error(`undecodable Content-Encoding: ${coding}`);
  const decoded = new Blob([body as unknown as BlobPart])
    .stream()
    .pipeThrough(new DS(format));
  const reader = decoded.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`decoded body exceeds the ${maxBytes}-byte bundle cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export type KpsHttpResponse = {
  status: number;
  headers: [name: string, value: string][];
  body: Uint8Array;
};

/**
 * Parse a complete (EOF-delimited) response. Strict per §4.2: a violation
 * throws — the exchange is abandoned, never leniently recovered.
 */
export function parseKpsHttpResponse(bytes: Uint8Array): KpsHttpResponse {
  const sep = findHeaderEnd(bytes);
  if (sep < 0) throw new Error("no header terminator in response");
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, sep));
  const lines = head.split(CRLF);
  const m = /^HTTP\/1\.1 (\d{3})(?: |$)/.exec(lines[0]);
  if (!m) throw new Error(`malformed status line: ${JSON.stringify(lines[0].slice(0, 80))}`);
  const status = Number(m[1]);
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`malformed header line: ${JSON.stringify(line.slice(0, 80))}`);
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // §4.2: bodies are EOF-delimited; Transfer-Encoding in either direction
    // is forbidden and MUST abandon the exchange.
    if (name === "transfer-encoding") throw new Error("forbidden Transfer-Encoding in response");
    headers.push([name, value]);
  }
  return { status, headers, body: bytes.subarray(sep + 4) };
}

function findHeaderEnd(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

/**
 * One GET exchange on one KPS stream (§4.2): write request, closeWrite, read
 * to EOF (capped), parse, require 200. The kps.openStream sugar gives the
 * stream a hidden dedicated connection that is torn down with it.
 */
export async function fetchBundleOverKps(
  addr: string,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const { openStream } = await import("@kpstreams/webrtc-client");
  const stream = await openStream(addr);
  try {
    const certhash = addr.slice(addr.lastIndexOf(":") + 1);
    // §4.2: advertise the codings this environment can decode.
    const advertised = ambientCodings();
    const writer = stream.writable.getWriter();
    await writer.write(buildKpsHttpRequest(path, certhash, advertised));
    await writer.close(); // closeWrite: request is EOF-terminated

    // Read the whole EOF-delimited response, capped (headers + body; the
    // body cap proper is enforced after parsing).
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const headroom = 64 * 1024; // header block allowance on top of the body cap
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes + headroom) {
        await reader.cancel().catch(() => {});
        throw new Error(`response exceeds the ${maxBytes}-byte bundle cap`);
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.byteLength;
    }

    const resp = parseKpsHttpResponse(all);
    // §4.2: any status other than 200 fails this resolver; redirects are
    // never followed (alternative locations are additional resolver entries).
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);

    // §4.2: a response may use exactly one coding the request advertised;
    // anything else (unadvertised coding, or a list) fails this resolver.
    // The cap is enforced on the DECODED bytes.
    const coding = resp.headers.find(([n]) => n === "content-encoding")?.[1].toLowerCase();
    if (coding && coding !== "identity") {
      if (!advertised.includes(coding)) {
        throw new Error(`unadvertised Content-Encoding: ${coding}`);
      }
      return decodeBody(coding, resp.body, maxBytes);
    }
    if (resp.body.byteLength > maxBytes) {
      throw new Error(`body exceeds the ${maxBytes}-byte bundle cap`);
    }
    return resp.body;
  } finally {
    await stream.close().catch(() => {});
  }
}

/** `kps:` entries, for harness-core's §4 fetch: this harness has the transport. */
export const kpsResolverKind: ResolverKind = {
  matches: (url) => url.startsWith("kps:"),
  fetch: (url, maxBytes) => {
    const { addr, path } = parseKpsResolver(url)!;
    return fetchBundleOverKps(addr, path, maxBytes);
  },
};
