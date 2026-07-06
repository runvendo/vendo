import { describe, expect, it } from "vitest";
import { parseNextFontVars, parseNextLayoutVars } from "./next-fonts.js";

describe("parseNextFontVars", () => {
  it("maps next/font/google variables to their font family", () => {
    const source = `
import { Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google"
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" })
const splineMono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline-mono" })
`;
    const vars = parseNextFontVars(source, "src/app/layout.tsx");
    expect(vars).toEqual([
      { name: "--font-hanken", value: "Hanken Grotesk", file: "src/app/layout.tsx", darkScope: false, synthetic: true },
      { name: "--font-spline-mono", value: "Spline Sans Mono", file: "src/app/layout.tsx", darkScope: false, synthetic: true },
    ]);
  });

  it("resolves aliased imports to the exported family name", () => {
    const source = `
import { Inter as BodyFont } from "next/font/google"
const body = BodyFont({ subsets: ["latin"], variable: "--font-body" })
`;
    expect(parseNextFontVars(source, "layout.tsx")).toEqual([
      { name: "--font-body", value: "Inter", file: "layout.tsx", darkScope: false, synthetic: true },
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
      { name: "--font-inter", value: "Inter", file: "layout.tsx", darkScope: false, synthetic: true },
    ]);
  });

  it("recovers Geist package runtime font variables", () => {
    const source = `
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
`;
    expect(parseNextFontVars(source, "layout.tsx")).toEqual([
      { name: "--font-geist-sans", value: "Geist Sans", file: "layout.tsx", darkScope: false, synthetic: true },
      { name: "--font-geist-mono", value: "Geist Mono", file: "layout.tsx", darkScope: false, synthetic: true },
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

  it("recovers next/font/google className usage as the page font", () => {
    const source = `
import { Outfit } from "next/font/google"
const outfit = Outfit({ subsets: ["latin"] })
export default function LocaleLayout({ children }) {
  return <body className={outfit.className}>{children}</body>
}
`;
    expect(parseNextFontVars(source, "app/[locale]/layout.tsx")).toEqual([
      { name: "--font-family", value: "Outfit, sans-serif", file: "app/[locale]/layout.tsx", darkScope: false },
    ]);
  });

  it("recovers exported next/font/google className fonts from font modules", () => {
    const source = `
import { Outfit, Dancing_Script } from "next/font/google"
export const outfit = Outfit({ subsets: ["latin"], display: "swap" })
export const dancingScript = Dancing_Script({ subsets: ["latin"], variable: "--font-dancing-script" })
`;
    expect(parseNextFontVars(source, "lib/fonts.ts")).toEqual([
      { name: "--font-family", value: "Outfit, sans-serif", file: "lib/fonts.ts", darkScope: false },
      { name: "--font-dancing-script", value: "Dancing Script", file: "lib/fonts.ts", darkScope: false, synthetic: true },
    ]);
  });
});

describe("parseNextLayoutVars", () => {
  it("recovers a light Tailwind background class from layout source", () => {
    const source = `<body className={\`\${outfit.className} bg-slate-100 dark:bg-slate-800\`}>{children}</body>`;
    expect(parseNextLayoutVars(source, "app/[locale]/layout.tsx")).toEqual([
      { name: "--background", value: "#f1f5f9", file: "app/[locale]/layout.tsx", darkScope: false },
    ]);
  });
});
