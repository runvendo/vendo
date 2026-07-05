import { describe, expect, it } from "vitest";
import { parseNextFontVars } from "./next-fonts.js";

describe("parseNextFontVars", () => {
  it("maps next/font/google variables to their font family", () => {
    const source = `
import { Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google"
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" })
const splineMono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline-mono" })
`;
    const vars = parseNextFontVars(source, "src/app/layout.tsx");
    expect(vars).toEqual([
      { name: "--font-hanken", value: '"Hanken Grotesk"', file: "src/app/layout.tsx", darkScope: false, synthetic: true },
      { name: "--font-spline-mono", value: '"Spline Sans Mono"', file: "src/app/layout.tsx", darkScope: false, synthetic: true },
    ]);
  });

  it("resolves aliased imports to the exported family name", () => {
    const source = `
import { Inter as BodyFont } from "next/font/google"
const body = BodyFont({ subsets: ["latin"], variable: "--font-body" })
`;
    expect(parseNextFontVars(source, "layout.tsx")).toEqual([
      { name: "--font-body", value: '"Inter"', file: "layout.tsx", darkScope: false, synthetic: true },
    ]);
  });

  it("ignores commented-out loader calls", () => {
    const source = `
import { Inter } from "next/font/google"
// const inter = Inter({ subsets: ["latin"], variable: "--font-old" })
/* const inter = Inter({ variable: "--font-older" }) */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })
`;
    expect(parseNextFontVars(source, "layout.tsx")).toEqual([
      { name: "--font-inter", value: '"Inter"', file: "layout.tsx", darkScope: false, synthetic: true },
    ]);
  });

  it("ignores fonts without a variable and next/font/local (family unknowable)", () => {
    const noVariable = `
import { Inter } from "next/font/google"
const inter = Inter({ subsets: ["latin"] })
`;
    expect(parseNextFontVars(noVariable, "layout.tsx")).toEqual([]);
    const local = `
import localFont from "next/font/local"
const brand = localFont({ src: "./brand.woff2", variable: "--font-brand" })
`;
    expect(parseNextFontVars(local, "layout.tsx")).toEqual([]);
  });
});
