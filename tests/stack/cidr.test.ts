import { expect, test } from "bun:test";
import { cidrContains, parseCidr } from "../../src/stack/cidr";

test("parseCidr reads IPv4 and IPv6 networks, and a bare address as a single host", () => {
  expect(parseCidr("10.0.0.0/8")).toEqual({ family: 4, base: 0x0a000000n, bits: 8 });
  expect(parseCidr("192.168.1.7")).toEqual({ family: 4, base: 0xc0a80107n, bits: 32 });
  expect(parseCidr("::1")).toEqual({ family: 6, base: 1n, bits: 128 });
  expect(parseCidr("::/96")).toEqual({ family: 6, base: 0n, bits: 96 });
  expect(parseCidr("fc00::/7").base).toBe(0xfcn << 120n);
  // An embedded IPv4 tail, as in ::ffff:1.2.3.4 or 64:ff9b::10.9.9.9.
  expect(parseCidr("::ffff:1.2.3.4").base).toBe((0xffffn << 32n) | 0x01020304n);
  expect(parseCidr("64:ff9b::a09:909")).toEqual(parseCidr("64:ff9b::10.9.9.9"));
  // Host bits below the prefix are cleared, as Squid and Docker treat them.
  expect(parseCidr("172.18.5.1/16")).toEqual({ family: 4, base: 0xac120000n, bits: 16 });
});

test("parseCidr refuses anything that isn't an address or a network", () => {
  for (const bad of ["", "10.0.0.0/33", "::/129", "1.2.3", "1.2.3.256", "10.0.0.0/", "/8", "fe80::1%eth0", "1::2::3", "1:2:3:4:5:6:7:8:9", "example.com", "10.0.0.0/8 ", "-1.0.0.0/8"]) {
    expect(() => parseCidr(bad)).toThrow(/not an IP address or network/);
  }
});

test("cidrContains: a network holds a network or address of the same family inside it", () => {
  expect(cidrContains("172.16.0.0/12", "172.18.0.0/16")).toBe(true);
  expect(cidrContains("172.16.0.0/12", "172.32.0.0/16")).toBe(false);
  expect(cidrContains("10.0.0.0/8", "10.0.0.0/8")).toBe(true);
  expect(cidrContains("10.0.0.0/16", "10.0.0.0/8")).toBe(false); // the wider one is not inside
  expect(cidrContains("::/96", "::")).toBe(true);
  expect(cidrContains("::/96", "::1")).toBe(true);
  expect(cidrContains("::/96", "::ffff:10.0.0.1")).toBe(false); // IPv4-mapped is outside IPv4-compatible
  expect(cidrContains("fc00::/7", "fd12:3456::/64")).toBe(true);
  // Families never mix: 10.0.0.1 is not inside an IPv6 range, nor ::ffff:10.0.0.1 inside 10.0.0.0/8.
  expect(cidrContains("::/0", "10.0.0.1")).toBe(false);
  expect(cidrContains("10.0.0.0/8", "::ffff:10.0.0.1")).toBe(false);
});
