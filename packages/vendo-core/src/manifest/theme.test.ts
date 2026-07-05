import { describe, expect, it } from "vitest";
import { manifestThemeSchema } from "./theme.js";

const valid = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FFFFFF",
  surface: "#F5F7FA",
  text: "#111418",
  mutedText: "#5B6470",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  radius: 8,
  mode: "light",
};

describe("manifestThemeSchema", () => {
  it("accepts a fully resolved v1 theme", () => {
    expect(manifestThemeSchema.parse(valid)).toEqual(valid);
  });

  it("accepts px-string radius and omitted mode", () => {
    const { mode: _mode, ...rest } = valid;
    expect(() => manifestThemeSchema.parse({ ...rest, radius: "8.5px" })).not.toThrow();
  });

  it("rejects non-hex colors (no var()/url() references)", () => {
    expect(() => manifestThemeSchema.parse({ ...valid, accent: "var(--accent)" })).toThrow();
  });

  it("rejects unknown versions", () => {
    expect(() => manifestThemeSchema.parse({ ...valid, version: 2 })).toThrow();
  });

  it("rejects unknown keys (parity with additionalProperties: false)", () => {
    expect(() => manifestThemeSchema.parse({ ...valid, extraToken: "#FFFFFF" })).toThrow();
  });
});
