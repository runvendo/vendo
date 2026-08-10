import { describe, expect, it } from "vitest";
import { isPinnedJailPackage, jailPackageUrl, JAIL_PACKAGE_CDN_ORIGIN } from "../../src/contract/jail-modules.js";

describe("preview-jail package pins", () => {
  it("accepts an exact version, with or without a scope or subpath", () => {
    expect(isPinnedJailPackage("recharts@3.9.2")).toBe(true);
    expect(isPinnedJailPackage("@tanstack/react-table@8.21.3")).toBe(true);
    expect(isPinnedJailPackage("date-fns@4.1.0/format")).toBe(true);
    expect(isPinnedJailPackage("recharts@3.9.2-beta.1")).toBe(true);
  });

  it("refuses anything that is not one exact version — a floating pin must never reach the network", () => {
    for (const pin of [
      "recharts@^3.9.2",
      "recharts@~3.9.2",
      "recharts@latest",
      "recharts@*",
      "recharts",
      "recharts@3.9.2?target=deno",
      "recharts@3.9.2/../../etc/passwd",
      "//evil.example/recharts@1.0.0",
      "https://evil.example/x@1.0.0",
    ]) {
      expect(isPinnedJailPackage(pin), pin).toBe(false);
      expect(jailPackageUrl(pin), pin).toBeNull();
    }
  });

  it("builds one URL on the one pinned origin, keeping the jail's own React", () => {
    const url = jailPackageUrl("recharts@3.9.2");
    expect(url).toBe(`${JAIL_PACKAGE_CDN_ORIGIN}/recharts@3.9.2?target=es2022&external=react,react-dom&standalone`);
    expect(new URL(url!).origin).toBe(JAIL_PACKAGE_CDN_ORIGIN);
  });

  it("carries the subpath through, so a deep import resolves to the same package", () => {
    expect(jailPackageUrl("date-fns@4.1.0/format"))
      .toBe(`${JAIL_PACKAGE_CDN_ORIGIN}/date-fns@4.1.0/format?target=es2022&external=react,react-dom&standalone`);
  });
});
