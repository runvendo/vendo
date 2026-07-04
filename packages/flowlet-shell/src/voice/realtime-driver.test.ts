import { describe, it, expect } from "vitest";
import { annotationsToTier } from "./realtime-driver";

describe("annotationsToTier", () => {
  it("mirrors the chat policy layer's derivation", () => {
    expect(annotationsToTier({ readOnlyHint: true, destructiveHint: false })).toBe("read");
    expect(annotationsToTier({ readOnlyHint: false, destructiveHint: true })).toBe("critical");
    expect(annotationsToTier({ readOnlyHint: false, destructiveHint: false })).toBe("act");
    // Unknown/unannotated stays gated (act), never auto-allowed.
    expect(annotationsToTier({})).toBe("act");
  });
});
