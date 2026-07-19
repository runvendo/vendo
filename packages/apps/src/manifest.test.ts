import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { parseVendoManifest, vendoManifestSchema } from "./manifest.js";

describe("vendo.json manifest (execution-v2 skin contract)", () => {
  it("accepts an empty manifest", () => {
    expect(parseVendoManifest("{}")).toEqual({});
  });

  it("accepts schedules and egress", () => {
    const manifest = parseVendoManifest(JSON.stringify({
      schedules: [{ cron: "0 8 * * *", fn: "chaseInvoices" }],
      egress: ["api.stripe.com"],
    }));
    expect(manifest.schedules).toEqual([{ cron: "0 8 * * *", fn: "chaseInvoices" }]);
    expect(manifest.egress).toEqual(["api.stripe.com"]);
  });

  it("rejects non-JSON loudly", () => {
    expect(() => parseVendoManifest("not json")).toThrowError(VendoError);
    try {
      parseVendoManifest("not json");
    } catch (error) {
      expect((error as VendoError).code).toBe("validation");
    }
  });

  it("rejects unknown top-level fields (YAGNI: schedules + egress only)", () => {
    expect(() => parseVendoManifest(JSON.stringify({ storage: {} }))).toThrowError(VendoError);
  });

  it("rejects unknown schedule fields", () => {
    expect(() => parseVendoManifest(JSON.stringify({
      schedules: [{ cron: "0 8 * * *", fn: "x", timezone: "UTC" }],
    }))).toThrowError(VendoError);
  });

  it("rejects a cron expression that is not five fields", () => {
    for (const cron of ["", "0 8 * *", "0 8 * * * *", "@daily"]) {
      expect(() => parseVendoManifest(JSON.stringify({ schedules: [{ cron, fn: "x" }] })), cron)
        .toThrowError(VendoError);
    }
  });

  it("rejects a schedule fn that is not a valid fn name", () => {
    for (const fn of ["", "fn:chase", "chase invoices", "1bad", "a".repeat(65)]) {
      expect(() => parseVendoManifest(JSON.stringify({ schedules: [{ cron: "* * * * *", fn }] })), fn)
        .toThrowError(VendoError);
    }
  });

  it("rejects empty egress entries", () => {
    expect(() => parseVendoManifest(JSON.stringify({ egress: [""] }))).toThrowError(VendoError);
  });

  it("names the offending path in the error message", () => {
    try {
      parseVendoManifest(JSON.stringify({ schedules: [{ cron: "bad", fn: "ok" }] }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as VendoError).message).toContain("schedules");
    }
  });

  it("exposes the schema for later waves (broker reads schedules, egress lane reads egress)", () => {
    expect(vendoManifestSchema.safeParse({ schedules: [], egress: [] }).success).toBe(true);
  });
});
