import { describe, it, expect } from "vitest";
import { baseProps } from "./base-props.js";

describe("baseProps", () => {
  it("returns only allowlisted base keys with primitive values", () => {
    const p = baseProps("1.2.3");
    expect(p.flowletVersion).toBe("1.2.3");
    expect(typeof p.osPlatform).toBe("string");
    expect(typeof p.nodeVersion).toBe("string");
    expect(Object.keys(p).sort()).toEqual(["flowletVersion", "nodeVersion", "osPlatform"]);
  });
});
