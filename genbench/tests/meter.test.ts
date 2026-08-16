/**
 * An open-source contender has to be nameable in `--models` AND billable in the
 * same table as the rest. `usdFor` throws for a model it holds no price for, so
 * an alias shipped without its pricing row would end its own run at the first
 * result rather than at a missing row somebody could see and fix.
 */
import { describe, expect, it } from "vitest";
import { MODEL_IDS, usdFor, WAFER_MODEL_IDS, type UsageTotals } from "../src/meter.js";

const perMTok: UsageTotals = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  calls: 1,
};

describe("the Wafer contenders", () => {
  it("names each alias by the id Wafer serves it under", () => {
    expect(MODEL_IDS["glm-fast"]).toBe("glm5.2-fast");
    expect(MODEL_IDS["deepseek-flash"]).toBe("DeepSeek-V4-Flash-0731-Fast");
  });

  it("prices every one of them, so no Wafer run is ended by a missing row", () => {
    for (const id of Object.values(WAFER_MODEL_IDS)) expect(usdFor(perMTok, id)).toBeGreaterThan(0);
  });

  /** Wafer's own `GET /v1/models` quote, in dollars per million tokens. */
  it("charges what Wafer quotes", () => {
    expect(usdFor(perMTok, "glm5.2-fast")).toBeCloseTo(2.1 + 6.6, 6);
    expect(usdFor(perMTok, "DeepSeek-V4-Flash-0731-Fast")).toBeCloseTo(0.28 + 0.56, 6);
  });
});
