/**
 * IP networks in CIDR form, for two checks that must agree with Squid:
 * - the egress proxies' `to_localnet` list holds no range another covers
 *   (Squid ignores such an entry, with a warning; tests/generate/egress.test.ts);
 * - every zone network Docker creates is inside the proxies' `zone_clients`
 *   ranges, or the proxy would refuse every request from it (./up.ts).
 *
 * IPv4 and IPv6 are kept apart: an IPv4 network never contains an IPv6 one,
 * or the reverse, IPv4-mapped forms (::ffff:a.b.c.d) included.
 */

/** A network: its family, its first address as a number, and its prefix length. */
export interface Cidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

const bad = (s: string) => new Error(`${JSON.stringify(s)} is not an IP address or network`);

function ipv4(s: string, whole: string): bigint {
  const parts = s.split(".");
  if (parts.length !== 4) throw bad(whole);
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) throw bad(whole);
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function ipv6(s: string, whole: string): bigint {
  let tail: bigint[] = [];
  let text = s;
  // An embedded IPv4 tail fills the last two groups (::ffff:1.2.3.4).
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = ipv4(v4[2]!, whole);
    tail = [n >> 16n, n & 0xffffn];
    text = v4[1]!.endsWith("::") ? v4[1]! : v4[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) throw bad(whole);
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  for (const g of [...head, ...rest]) if (!/^[0-9a-f]{1,4}$/i.test(g)) throw bad(whole);
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) throw bad(whole);
  const all = [...head.map((g) => BigInt(`0x${g}`)), ...Array(8 - given).fill(0n), ...rest.map((g) => BigInt(`0x${g}`)), ...tail];
  return all.reduce((acc, g) => (acc << 16n) | g, 0n);
}

/** Parse "10.0.0.0/8", "fc00::/7" or a bare address (a single host). Host bits below the prefix are cleared. Throws on anything else. */
export function parseCidr(s: string): Cidr {
  const m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(s);
  if (!m) throw bad(s);
  const family = m[1]!.includes(":") ? 6 : 4;
  const width = family === 4 ? 32 : 128;
  const bits = m[2] === undefined ? width : Number(m[2]);
  if (bits > width) throw bad(s);
  const n = family === 4 ? ipv4(m[1]!, s) : ipv6(m[1]!, s);
  const hostMask = (1n << BigInt(width - bits)) - 1n;
  return { family, base: n & ~hostMask, bits };
}

/** Whether `outer` holds all of `inner` (both networks or addresses, as `parseCidr` reads them). Families never mix. */
export function cidrContains(outer: string | Cidr, inner: string | Cidr): boolean {
  const o = typeof outer === "string" ? parseCidr(outer) : outer;
  const i = typeof inner === "string" ? parseCidr(inner) : inner;
  if (o.family !== i.family || i.bits < o.bits) return false;
  const width = o.family === 4 ? 32 : 128;
  const shift = BigInt(width - o.bits);
  return i.base >> shift === o.base >> shift;
}
