import { describe, expect, it } from "vitest";
import { isPinnedPackage } from "../../src/contract/inclient-modules.js";

describe("captured package pins", () => {
  it("accepts an exact version, with or without a scope or subpath", () => {
    expect(isPinnedPackage("recharts@3.9.2")).toBe(true);
    expect(isPinnedPackage("@tanstack/react-table@8.21.3")).toBe(true);
    expect(isPinnedPackage("date-fns@4.1.0/format")).toBe(true);
    expect(isPinnedPackage("recharts@3.9.2-beta.1")).toBe(true);
  });

  it("refuses anything that is not one exact version", () => {
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
      expect(isPinnedPackage(pin), pin).toBe(false);
    }
  });
});
