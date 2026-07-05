import { describe, it, expect } from "vitest";
import { annotationsToTier, isSpokenDecline } from "./realtime-driver";

describe("isSpokenDecline", () => {
  it("accepts bare stop words only", () => {
    for (const yes of ["Stop.", "cancel", "No!", "wait", "never mind", "don't do that."]) {
      expect(isSpokenDecline(yes)).toBe(true);
    }
  });
  it("stays conservative: sentences containing stop words do not decline", () => {
    for (const no of [
      "no worries, go ahead",
      "stop by the store view first",
      "cancel the other one instead",
      "yes",
    ]) {
      expect(isSpokenDecline(no)).toBe(false);
    }
  });
});

describe("annotationsToTier", () => {
  it("mirrors the chat policy layer's derivation", () => {
    expect(annotationsToTier({ readOnlyHint: true, destructiveHint: false })).toBe("read");
    expect(annotationsToTier({ readOnlyHint: false, destructiveHint: true })).toBe("critical");
    expect(annotationsToTier({ readOnlyHint: false, destructiveHint: false })).toBe("act");
    // Unknown/unannotated stays gated (act), never auto-allowed.
    expect(annotationsToTier({})).toBe("act");
  });
});
