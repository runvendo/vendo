import { describe, it, expect } from "vitest";
import { STAGE_RUNTIME_SRC } from "./runtime";

describe("stage runtime source", () => {
  it("is parseable JS", () => {
    expect(() => new Function(STAGE_RUNTIME_SRC)).not.toThrow();
  });
  it("includes the required capabilities", () => {
    for (const marker of [
      "ui/initialize", "ui/update", "ui/action-result", "__flowletDispatch",
      "ResizeObserver", "$state", "getDerivedStateFromError", "__React",
    ]) expect(STAGE_RUNTIME_SRC).toContain(marker);
  });
});
