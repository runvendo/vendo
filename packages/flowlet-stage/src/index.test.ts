import { describe, it, expect } from "vitest";
import type { StageCapabilities } from "./index";

describe("@flowlet/stage", () => {
  it("exports StageCapabilities-compatible shape", () => {
    const caps: StageCapabilities = {
      resolveComponent: () => undefined,
      theme: {},
      getState: () => ({}),
      subscribe: () => () => {},
      dispatch: async () => ({ result: null }),
    };
    expect(typeof caps.dispatch).toBe("function");
  });
});
