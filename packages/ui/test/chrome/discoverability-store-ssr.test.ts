// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasSeen, markSeen } from "../../src/chrome/discoverability.js";

describe("discoverability fire-once store (SSR)", () => {
  it("is inert without a window: reads as seen, writes are no-ops", () => {
    expect(typeof window).toBe("undefined");
    expect(hasSeen("whisper")).toBe(true);
    expect(() => markSeen("whisper")).not.toThrow();
  });
});
