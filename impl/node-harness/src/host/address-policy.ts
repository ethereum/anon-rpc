// Which addresses the bridged socket capability may dial.
//
// This runs in the HOST process, outside the sandbox, which is the only reason
// it is worth writing. The same check inside the child would be a seat belt:
// `node:vm` is not a security boundary, so worker code that escapes its context
// reaches the outer realm and whatever it can reach from there. Here the worker
// cannot dial at all — it can only ask, and this decides.
//
// The default is deny-by-default against the HOST's own network: loopback,
// private ranges, link-local (which is where cloud instance metadata lives, and
// therefore the host's IAM identity — the §6 "identity of the host" clause read
// for a server). Everything globally routable is allowed, because reaching the
// internet is the worker's entire job.

export type AddressPolicy = {
  /**
   * Extra destinations to permit, as exact IPs or CIDR blocks. Needed more
   * often than it sounds: a wallet pointing its worker at a node on localhost
   * is a legitimate deployment, and so is a private-network RPC endpoint.
   */
  allow?: string[];
  /** Permit every address, including the host's own network. Off by default. */
  allowAll?: boolean;
};

export type Decision = { ok: true } | { ok: false; why: string };

/** Parse "10.0.0.0/8" or a bare address into a matcher. */
type Rule = { bytes: Uint8Array; bits: number };

function parseRule(entry: string): Rule {
  const [addr, maskPart] = entry.split("/");
  const bytes = toBytes(addr);
  if (!bytes) throw new Error(`address policy: not an IP or CIDR: ${entry}`);
  const bits = maskPart === undefined ? bytes.length * 8 : Number(maskPart);
  if (!Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8) {
    throw new Error(`address policy: bad prefix length in ${entry}`);
  }
  return { bytes, bits };
}

function matches(addr: Uint8Array, rule: Rule): boolean {
  if (addr.length !== rule.bytes.length) return false; // v4 rule never matches a v6 address
  const whole = rule.bits >> 3;
  for (let i = 0; i < whole; i++) if (addr[i] !== rule.bytes[i]) return false;
  const rest = rule.bits & 7;
  if (rest === 0) return true;
  const mask = 0xff << (8 - rest);
  return (addr[whole] & mask) === (rule.bytes[whole] & mask);
}

/**
 * Ranges that are not globally routable, or that name the host itself.
 * Denying these is what stops a worker using the harness as a proxy into the
 * network the host happens to sit on.
 */
const NON_GLOBAL = [
  "0.0.0.0/8", // "this host"
  "10.0.0.0/8", // RFC1918
  "100.64.0.0/10", // CGNAT / tailscale
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local — includes 169.254.169.254, cloud metadata
  "172.16.0.0/12", // RFC1918
  "192.0.0.0/24", // IETF protocol assignments
  "192.168.0.0/16", // RFC1918
  "198.18.0.0/15", // benchmarking
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, includes broadcast
  "::1/128", // loopback
  "::/128", // unspecified
  "fc00::/7", // unique local
  "fe80::/10", // link-local
  "ff00::/8", // multicast
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) would otherwise slip past the v4 rules
  // above, since it is matched as a 16-byte address.
  "::ffff:0.0.0.0/96",
].map(parseRule);

export class Policy {
  #allow: Rule[];
  #allowAll: boolean;

  constructor(policy: AddressPolicy = {}) {
    this.#allow = (policy.allow ?? []).map(parseRule);
    this.#allowAll = policy.allowAll ?? false;
  }

  /** `addr` must already be a resolved IP — never a hostname (see the bridge). */
  check(addr: string): Decision {
    if (this.#allowAll) return { ok: true };
    const bytes = toBytes(addr);
    if (!bytes) return { ok: false, why: `${addr} is not an IP address` };

    if (this.#allow.some((r) => matches(bytes, r))) return { ok: true };

    // An IPv4-mapped address is checked against the v4 rules too, so
    // ::ffff:127.0.0.1 cannot be used to reach loopback past a v4-only rule.
    const mapped = unmapV4(bytes);
    if (mapped && this.#allow.some((r) => matches(mapped, r))) return { ok: true };

    for (const rule of NON_GLOBAL) {
      if (matches(bytes, rule) || (mapped && matches(mapped, rule))) {
        return { ok: false, why: `${addr} is not globally routable` };
      }
    }
    return { ok: true };
  }
}

/** ::ffff:a.b.c.d → the 4-byte form, else undefined. */
function unmapV4(b: Uint8Array): Uint8Array | undefined {
  if (b.length !== 16) return undefined;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return undefined;
  if (b[10] !== 0xff || b[11] !== 0xff) return undefined;
  return b.slice(12);
}

/** Parse an IPv4 or IPv6 literal to bytes. Returns undefined if it is neither. */
export function toBytes(addr: string): Uint8Array | undefined {
  if (addr.includes(":")) return v6(addr);
  return v4(addr);
}

function v4(addr: string): Uint8Array | undefined {
  const parts = addr.split(".");
  if (parts.length !== 4) return undefined;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return undefined;
    const n = Number(parts[i]);
    if (n > 255) return undefined;
    out[i] = n;
  }
  return out;
}

function v6(addr: string): Uint8Array | undefined {
  // Strip a zone id ("fe80::1%eth0"); it does not affect which range this is in.
  const bare = addr.split("%")[0];
  const [head, tail] = bare.split("::") as [string, string | undefined];
  const parse = (s: string): number[] | undefined => {
    if (!s) return [];
    const groups: number[] = [];
    for (const g of s.split(":")) {
      // A trailing dotted quad ("::ffff:127.0.0.1") occupies two groups.
      if (g.includes(".")) {
        const four = v4(g);
        if (!four) return undefined;
        groups.push((four[0] << 8) | four[1], (four[2] << 8) | four[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const a = parse(head);
  const b = tail === undefined ? [] : parse(tail);
  if (!a || !b) return undefined;
  if (tail === undefined && a.length !== 8) return undefined;
  if (tail !== undefined && a.length + b.length > 8) return undefined;
  const groups = [...a, ...new Array(8 - a.length - b.length).fill(0), ...b];
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
}
