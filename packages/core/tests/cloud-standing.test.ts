import { describe, expect, it } from "vitest";
import { cloudStandingError } from "../src/cloud-standing.js";

// The console's own wire bodies for the two standing refusals.
const UNAUTHORIZED = { error: { code: "unauthorized", message: "Valid API key required." } };
const METER_EXHAUSTED = {
  error: { code: "meter-exhausted", message: "meter exhausted" },
  meter: "usage",
  unit: "usd",
  used: 6.2,
  limit: 5,
  resets_at: "2026-08-01T00:00:00.000Z",
  reason: "allowance",
  exits: { upgrade_url: "https://console.vendo.run/billing", byo_docs_url: "https://docs.vendo.run/byo" },
};

describe("cloudStandingError", () => {
  it("reads a revoked key (401) as cloud-required carrying the console's message", () => {
    const error = cloudStandingError(401, UNAUTHORIZED, "fallback");
    expect(error).toMatchObject({ code: "cloud-required", message: "Valid API key required." });
  });

  it("falls back to the caller's message when the body carries none", () => {
    expect(cloudStandingError(401, undefined, "fallback")).toMatchObject({
      code: "cloud-required",
      message: "fallback",
    });
    expect(cloudStandingError(402, "<html>nginx</html>", "fallback")).toMatchObject({
      code: "cloud-required",
      message: "fallback",
    });
  });

  it("renders a dry meter (402) as the crafted sentence, structured fields on detail", () => {
    expect(cloudStandingError(402, METER_EXHAUSTED, "fallback")).toMatchObject({
      code: "cloud-required",
      message: "Vendo Cloud paused usage — the $5.00 included this billing period is used up "
        + "($6.20 of $5.00 used; resets 2026-08-01). "
        + "Upgrade your plan (https://console.vendo.run/billing) "
        + "or bring your own infrastructure (https://docs.vendo.run/byo).",
      detail: {
        meter: "usage",
        unit: "usd",
        used: 6.2,
        limit: 5,
        resetsAt: "2026-08-01T00:00:00.000Z",
        reason: "allowance",
        upgradeUrl: "https://console.vendo.run/billing",
        byoDocsUrl: "https://docs.vendo.run/byo",
      },
    });
  });

  it("leaves every other status to the caller's own mapping", () => {
    for (const status of [403, 404, 500]) {
      expect(cloudStandingError(status, UNAUTHORIZED, "fallback"), String(status)).toBeUndefined();
    }
  });
});
