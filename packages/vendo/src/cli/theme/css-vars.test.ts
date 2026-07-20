import { describe, expect, it } from "vitest";
import { parseCssVars } from "./css-vars.js";

describe("parseCssVars", () => {
  it("keeps a block's last declaration when it lacks a trailing semicolon", () => {
    const decls = parseCssVars(":root { --primary: #123456 }", "globals.css");
    expect(decls).toEqual([
      { name: "--primary", value: "#123456", file: "globals.css", darkScope: false },
    ]);
  });

  it("keeps the final declaration of every block in a minified sheet", () => {
    const decls = parseCssVars(":root{--a:#111;--b:#222}.dark{--c:#333}", "min.css");
    expect(decls).toEqual([
      { name: "--a", value: "#111", file: "min.css", darkScope: false },
      { name: "--b", value: "#222", file: "min.css", darkScope: false },
      { name: "--c", value: "#333", file: "min.css", darkScope: true },
    ]);
  });

  it("keeps a trailing declaration when the input ends without a closing brace", () => {
    const decls = parseCssVars(":root { --edge: #abcdef", "truncated.css");
    expect(decls).toEqual([
      { name: "--edge", value: "#abcdef", file: "truncated.css", darkScope: false },
    ]);
  });
});
