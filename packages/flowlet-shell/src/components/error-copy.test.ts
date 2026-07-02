import { describe, it, expect } from "vitest";
import { friendlyError, errorDetail } from "./error-copy";

describe("friendlyError", () => {
  it("maps provider billing text to friendly copy — raw text never passes through", () => {
    const raw =
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    const out = friendlyError(raw);
    expect(out.message).not.toMatch(/anthropic|billing|credit/i);
    expect(out.message).toMatch(/try again/i);
    expect(out.retryable).toBe(true);
  });

  it("maps rate limiting", () => {
    expect(friendlyError("429 Too Many Requests").message).toMatch(/busy/i);
  });

  it("maps network failures", () => {
    expect(friendlyError(new Error("Failed to fetch")).message).toMatch(/connection/i);
  });

  it("maps empty-prompt SDK invariants and marks them non-retryable", () => {
    const out = friendlyError("Invalid prompt: messages must not be empty");
    expect(out.retryable).toBe(false);
  });

  it("falls back to generic copy for unknown errors", () => {
    const out = friendlyError("ENOWIDGET: widget exploded");
    expect(out.message).toBe("Something went wrong. Please try again.");
    expect(out.retryable).toBe(true);
  });

  it("errorDetail preserves the raw text for debugging surfaces", () => {
    expect(errorDetail(new Error("raw detail"))).toBe("raw detail");
  });
});
