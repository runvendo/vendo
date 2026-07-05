import { describe, it, expect } from "vitest";
import { vendoHostPreset } from "./preset.js";

describe("vendoHostPreset", () => {
  it("externalizes React so it is not duplicated per bundle", () => {
    const c = vendoHostPreset({ entry: "x.tsx", version: "1.2.3" });
    const ext = c.build?.rollupOptions?.external as string[];
    for (const r of ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]) expect(ext).toContain(r);
  });
  it("defines process.env.NODE_ENV (no bare process in the sandbox)", () => {
    const c = vendoHostPreset({ entry: "x.tsx", version: "1.2.3" });
    expect((c.define as Record<string, unknown>)["process.env.NODE_ENV"]).toBe('"production"');
  });
  it("stamps the provided version", () => {
    const c = vendoHostPreset({ entry: "x.tsx", version: "1.2.3" });
    expect(JSON.stringify(c)).toContain("1.2.3");
  });
  it("emits a single ESM library from the entry", () => {
    const c = vendoHostPreset({ entry: "components.tsx", version: "0.0.1" });
    expect(c.build?.lib).toBeTruthy();
    expect((c.build?.lib as any).formats).toContain("es");
  });
});
