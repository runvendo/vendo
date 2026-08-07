import { describe, expect, it } from "vitest";
import {
  formatMeterExhausted,
  meterExhaustedFromError,
  parseMeterExhausted,
} from "./meter-exhausted.js";

// Usage & pricing v3 (spec §5) — the Cloud doors' one refusal shape.
const REFUSAL_BODY = {
  meter: "ai_tokens",
  used: 1_204_000,
  limit: 1_000_000,
  resets_at: "2026-08-01T00:00:00.000Z",
  reason: "allowance",
  exits: {
    upgrade_url: "https://console.vendo.run/billing",
    byo_docs_url: "https://docs.vendo.run/byo",
  },
};

describe("parseMeterExhausted", () => {
  it("parses the flat refusal body (stable code at the root)", () => {
    expect(parseMeterExhausted({ code: "meter-exhausted", ...REFUSAL_BODY })).toEqual({
      meter: "ai_tokens",
      used: 1_204_000,
      limit: 1_000_000,
      resetsAt: "2026-08-01T00:00:00.000Z",
      reason: "allowance",
      upgradeUrl: "https://console.vendo.run/billing",
      byoDocsUrl: "https://docs.vendo.run/byo",
    });
  });

  it("parses the console's enveloped twin ({ error: { code, ...fields } })", () => {
    const parsed = parseMeterExhausted({
      error: { code: "meter-exhausted", message: "meter exhausted", ...REFUSAL_BODY },
    });
    expect(parsed?.meter).toBe("ai_tokens");
    expect(parsed?.upgradeUrl).toBe("https://console.vendo.run/billing");
  });

  it("is not fooled by other 402 bodies (old quota-exhausted code, no code, non-objects)", () => {
    expect(parseMeterExhausted({ error: { code: "quota-exhausted", message: "Quota exhausted." } })).toBeUndefined();
    expect(parseMeterExhausted({ ...REFUSAL_BODY })).toBeUndefined();
    expect(parseMeterExhausted("meter-exhausted")).toBeUndefined();
    expect(parseMeterExhausted(undefined)).toBeUndefined();
  });

  it("re-serializes exit URLs so C0 controls can never reach a terminal (WHATWG percent-encoding)", () => {
    const parsed = parseMeterExhausted({
      code: "meter-exhausted",
      meter: "ai_tokens",
      exits: { upgrade_url: "https://a.com/\u001b[2Kevil", byo_docs_url: "https://docs.vendo.run/byo" },
    });
    expect(parsed?.upgradeUrl).toBe("https://a.com/%1B[2Kevil");
    expect(formatMeterExhausted(parsed!)).not.toContain("\u001b");
  });

  it("drops oversized exit URLs entirely — the format degrades to link-less exit naming", () => {
    const parsed = parseMeterExhausted({
      code: "meter-exhausted",
      meter: "ai_tokens",
      exits: { upgrade_url: `https://console.vendo.run/${"a".repeat(300)}`, byo_docs_url: "https://docs.vendo.run/byo" },
    });
    expect(parsed?.upgradeUrl).toBeUndefined();
    expect(formatMeterExhausted(parsed!)).toContain("Upgrade your plan or bring your own infrastructure (https://docs.vendo.run/byo).");
  });

  it("drops garbled fields instead of rendering them (negative counts, junk urls, non-token meter)", () => {
    const parsed = parseMeterExhausted({
      code: "meter-exhausted",
      meter: "sk-123 leaked provider internals\n",
      used: -4,
      limit: Number.NaN,
      exits: { upgrade_url: "javascript:alert(1)", byo_docs_url: 42 },
    });
    expect(parsed).toEqual({});
  });
});

describe("formatMeterExhausted", () => {
  it("renders the full refusal: meter, figures, reset date, both exits", () => {
    const parsed = parseMeterExhausted({ code: "meter-exhausted", ...REFUSAL_BODY });
    expect(formatMeterExhausted(parsed!)).toBe(
      // `ai_tokens` is a retired Cloud meter, so it renders through the raw-id
      // fallback now — the label table carries only the pool meter `usage`.
      "Vendo Cloud paused ai_tokens — the allowance for this billing period is used up "
      + "(1,204,000 of 1,000,000 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo).",
    );
  });

  it("names the spend cap when the reason says so", () => {
    expect(formatMeterExhausted({ meter: "automation_runs", reason: "spend-cap" })).toBe(
      "Vendo Cloud paused automation_runs — your spend cap is reached. "
      + "Upgrade your plan or bring your own infrastructure.",
    );
  });

  it("falls back to the raw meter id for a meter OSS does not know", () => {
    expect(formatMeterExhausted({ meter: "holo_decks" })).toContain("Vendo Cloud paused holo_decks —");
  });

  it("degrades to plain 'usage' and linkless exits on an empty refusal", () => {
    expect(formatMeterExhausted({})).toBe(
      "Vendo Cloud paused usage — the allowance for this billing period is used up. "
      + "Upgrade your plan or bring your own infrastructure.",
    );
  });
});

describe("formatMeterExhausted in dollars", () => {
  const usd = {
    meter: "usage",
    unit: "usd" as const,
    used: 49,
    limit: 49,
    resetsAt: "2026-09-04T00:00:00.000Z",
    reason: "allowance",
    upgradeUrl: "https://console.vendo.run/billing",
    byoDocsUrl: "https://docs.vendo.run/deploy/vendo-cloud",
  };

  it("renders currency and names the included dollars", () => {
    expect(formatMeterExhausted(usd)).toBe(
      "Vendo Cloud paused usage — the $49.00 included this billing period is used up " +
        "($49.00 of $49.00 used; resets 2026-09-04). " +
        "Upgrade your plan (https://console.vendo.run/billing) or bring your own " +
        "infrastructure (https://docs.vendo.run/deploy/vendo-cloud).",
    );
  });

  it("still starts with the head the thread banner matches on", () => {
    expect(formatMeterExhausted(usd)).toMatch(/^Vendo Cloud paused /);
  });

  it("names the spend cap when that is the reason", () => {
    expect(formatMeterExhausted({ ...usd, reason: "spend_cap", limit: 147 })).toContain(
      "your spend cap is reached",
    );
  });

  it("also accepts the hyphenated reason token", () => {
    expect(formatMeterExhausted({ ...usd, reason: "spend-cap" })).toContain(
      "your spend cap is reached",
    );
  });

  it("falls back to counts when the body carries no unit", () => {
    expect(
      formatMeterExhausted({ meter: "usage", used: 300, limit: 300 }),
    ).toBe(
      "Vendo Cloud paused usage — the allowance for this billing period is used up " +
        "(300 of 300 used). Upgrade your plan or bring your own infrastructure.",
    );
  });

  it("reads the unit off the wire body", () => {
    expect(
      parseMeterExhausted({
        code: "meter-exhausted",
        meter: "usage",
        unit: "usd",
        used: 5.2,
        limit: 5,
      }),
    ).toEqual({ meter: "usage", unit: "usd", used: 5.2, limit: 5 });
  });

  it("ignores a unit it does not understand", () => {
    expect(
      parseMeterExhausted({ code: "meter-exhausted", meter: "usage", unit: "quatloos" })
        .unit,
    ).toBeUndefined();
  });
});

describe("meterExhaustedFromError", () => {
  it("recognizes a provider APICallError carrying the refusal as its responseBody", () => {
    const error = Object.assign(new Error("Payment Required"), {
      statusCode: 402,
      responseBody: JSON.stringify({ code: "meter-exhausted", ...REFUSAL_BODY }),
    });
    expect(meterExhaustedFromError(error)?.meter).toBe("ai_tokens");
  });

  it("recognizes the refusal on a parsed data member", () => {
    const error = Object.assign(new Error("Payment Required"), {
      data: { error: { code: "meter-exhausted", meter: "sandbox_minutes" } },
    });
    expect(meterExhaustedFromError(error)?.meter).toBe("sandbox_minutes");
  });

  it("ignores plain transport errors and non-refusal bodies", () => {
    expect(meterExhaustedFromError(new Error("ECONNRESET"))).toBeUndefined();
    expect(meterExhaustedFromError(Object.assign(new Error("nope"), { responseBody: "not json" }))).toBeUndefined();
    expect(meterExhaustedFromError(undefined)).toBeUndefined();
  });
});
