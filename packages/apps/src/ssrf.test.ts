import { describe, expect, it } from "vitest";
import { checkEgressUrl, isBlockedAddress } from "./ssrf.js";

describe("isBlockedAddress", () => {
  it("blocks IPv4 loopback, private, link-local, CGNAT, and multicast ranges", () => {
    for (const ip of [
      "127.0.0.1", "127.1.2.3",
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4 addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.255.255"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback, unspecified, link-local, ULA, and multicast", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("unwraps IPv4-mapped IPv6 and classifies the inner address", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows a public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("fails closed on anything unparseable", () => {
    for (const junk of ["not-an-ip", "", "999.999.999.999", "12.34"]) {
      expect(isBlockedAddress(junk), junk).toBe(true);
    }
  });
});

describe("checkEgressUrl", () => {
  const resolve = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

  it("passes a public host and returns its addresses", async () => {
    const check = await checkEgressUrl("https://api.stripe.com/v1", { resolve: resolve({ "api.stripe.com": ["8.8.8.8"] }) });
    expect(check.ok).toBe(true);
  });

  it("rejects non-http(s) schemes", async () => {
    const check = await checkEgressUrl("file:///etc/passwd", { resolve: resolve({}) });
    expect(check).toMatchObject({ ok: false });
  });

  it("rejects embedded userinfo", async () => {
    const check = await checkEgressUrl("https://user:pass@api.stripe.com/", { resolve: resolve({ "api.stripe.com": ["8.8.8.8"] }) });
    expect(check).toMatchObject({ ok: false, reason: "userinfo-forbidden" });
  });

  it("rejects a host that resolves to a private address (rebind defense)", async () => {
    const check = await checkEgressUrl("https://api.stripe.com/", { resolve: resolve({ "api.stripe.com": ["127.0.0.1"] }) });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("blocked-address");
  });

  it("rejects when ANY resolved address is private", async () => {
    const check = await checkEgressUrl("https://api.stripe.com/", { resolve: resolve({ "api.stripe.com": ["8.8.8.8", "10.0.0.1"] }) });
    expect(check).toMatchObject({ ok: false });
  });

  it("validates an IP-literal host without resolving", async () => {
    expect(await checkEgressUrl("http://169.254.169.254/latest/meta-data/")).toMatchObject({ ok: false });
    expect(await checkEgressUrl("http://[::1]/")).toMatchObject({ ok: false });
  });

  it("fails closed when DNS is unavailable", async () => {
    const check = await checkEgressUrl("https://api.stripe.com/", {
      resolve: async () => { throw new Error("no dns"); },
    });
    expect(check).toMatchObject({ ok: false, reason: "dns-unavailable" });
  });
});
