import { describe, expect, it } from "vitest";
import { parseCssVars } from "./css-vars.js";

const CSS = `
@import "tailwindcss";
@theme {
  --color-bg: #FBFBFA;
  --radius-card: 14px;
}
:root { --accent: #1B1C22; }
.dark { --color-bg: #111111; }
@media (prefers-color-scheme: dark) {
  :root { --accent: #FFFFFF; }
}
body { color: var(--color-ink); }
`;

describe("parseCssVars", () => {
  it("extracts declarations with dark-scope flags", () => {
    const vars = parseCssVars(CSS, "globals.css");
    expect(vars).toContainEqual({ name: "--color-bg", value: "#FBFBFA", file: "globals.css", darkScope: false });
    expect(vars).toContainEqual({ name: "--radius-card", value: "14px", file: "globals.css", darkScope: false });
    expect(vars).toContainEqual({ name: "--accent", value: "#1B1C22", file: "globals.css", darkScope: false });
    expect(vars).toContainEqual({ name: "--color-bg", value: "#111111", file: "globals.css", darkScope: true });
    expect(vars).toContainEqual({ name: "--accent", value: "#FFFFFF", file: "globals.css", darkScope: true });
    // usage (var(--color-ink)) is not a declaration
    expect(vars.find((v) => v.name === "--color-ink")).toBeUndefined();
  });

  it("ignores comments and handles empty input", () => {
    expect(parseCssVars("/* --x: #fff; */", "a.css")).toEqual([]);
    expect(parseCssVars("", "a.css")).toEqual([]);
  });
});
