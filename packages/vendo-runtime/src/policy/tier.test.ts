import { describe, expect, it } from "vitest";
import { dangerTier, isUnverified } from "./tier";
import type { ToolDescriptor } from "../descriptor";

const desc = (annotations: ToolDescriptor["annotations"]): ToolDescriptor => ({
  name: "t", source: "caller", annotations, hasExecute: true, kind: "function",
});

describe("dangerTier", () => {
  it("read for readOnlyHint", () => {
    expect(dangerTier(desc({ readOnlyHint: true }))).toBe("read");
  });
  it("critical for destructiveHint", () => {
    expect(dangerTier(desc({ destructiveHint: true }))).toBe("critical");
  });
  it("critical wins over readOnly if both set", () => {
    expect(dangerTier(desc({ readOnlyHint: true, destructiveHint: true }))).toBe("critical");
  });
  it("act for mutating-not-dangerous and for unknown", () => {
    expect(dangerTier(desc({ readOnlyHint: false }))).toBe("act");
    expect(dangerTier(desc({}))).toBe("act");
  });
  it("unverified only when no informative hints", () => {
    expect(isUnverified(desc({}))).toBe(true);
    expect(isUnverified(desc({ openWorldHint: true }))).toBe(false);
    expect(isUnverified(desc({ readOnlyHint: true }))).toBe(false);
  });
});
