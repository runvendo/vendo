import { describe, expect, it } from "vitest";
import { cloudDoctor, CLOUD_UNLOCKS } from "../../src/cli/cloud/client.js";

describe("cloudDoctor", () => {
  it("reports absent + unlocks when no key is set", async () => {
    const result = await cloudDoctor({ env: {} });
    expect(result.present).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.unlocks).toEqual(CLOUD_UNLOCKS);
  });

  it("flags a malformed key locally", async () => {
    const result = await cloudDoctor({ env: { VENDO_API_KEY: "nope" } });
    expect(result.present).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("malformed");
  });

  it("accepts a well-formed key", async () => {
    const result = await cloudDoctor({ env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}` } });
    expect(result).toEqual({ present: true, ok: true, unlocks: CLOUD_UNLOCKS });
  });
});
