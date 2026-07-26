import { describe, expect, it } from "vitest";
import {
  TAILWIND_DEFAULT_SANS,
  deriveBodyFontStack,
  layoutFontBindings,
  tailwindConfigSansStack,
} from "./font-stack.js";

const noCssVars = (): string | null => null;

// Real declarations from the corpus repos' pinned SHAs (see each test) — the
// two fontFamily fallback-stack misses from the 2026-07-25 nightly, plus the
// shapes that must NOT derive (fail-closed to the staged model pass).

describe("tailwindConfigSansStack", () => {
  it("parses skateshop's real config: var head + default-theme spread (e954d543 tailwind.config.ts:157)", () => {
    const config = `
      import { fontFamily } from "tailwindcss/defaultTheme"
      export default {
        theme: {
          extend: {
            fontFamily: {
              sans: ["var(--font-geist-sans)", ...fontFamily.sans],
              mono: ["var(--font-geist-mono)", ...fontFamily.mono],
              heading: ["var(--font-heading)", ...fontFamily.sans],
            },
          },
        },
      }
    `;
    expect(tailwindConfigSansStack(config)).toEqual(["var(--font-geist-sans)", ...TAILWIND_DEFAULT_SANS]);
  });

  it("parses inbox-zero's real config: require + defaultTheme spread (b73bdecc apps/web/tailwind.config.js:48)", () => {
    const config = `
      const { fontFamily } = require("tailwindcss/defaultTheme");
      module.exports = {
        theme: {
          extend: {
            fontFamily: {
              sans: ["var(--font-geist)", ...fontFamily.sans],
              inter: ["var(--font-inter)", ...fontFamily.sans],
              title: ["var(--font-title)", ...fontFamily.sans],
            },
          },
        },
      };
    `;
    expect(tailwindConfigSansStack(config)).toEqual(["var(--font-geist)", ...TAILWIND_DEFAULT_SANS]);
  });

  it("fails closed on teable's custom spread — its contents are unknowable here (105e0f94 tailwind.theme.js:8)", () => {
    expect(tailwindConfigSansStack(`
      module.exports = {
        fontFamily: {
          sans: ['Inter Variable', ...browserFonts.sans],
        },
      };
    `)).toBeNull();
  });

  it("keeps literal-only stacks verbatim and returns null when no sans key exists", () => {
    expect(tailwindConfigSansStack('fontFamily: { sans: ["Inter", "sans-serif"] }')).toEqual(["Inter", "sans-serif"]);
    expect(tailwindConfigSansStack('fontFamily: { mono: ["Menlo", "monospace"] }')).toBeNull();
    expect(tailwindConfigSansStack("module.exports = {}")).toBeNull();
  });
});

describe("layoutFontBindings", () => {
  it("reads geist package imports with their fixed families and variables (vercel-commerce 3761e52e app/layout.tsx)", () => {
    const layout = `
      import { GeistSans } from "geist/font/sans";
      export default function RootLayout({ children }) {
        return <html lang="en" className={GeistSans.variable}><body>{children}</body></html>;
      }
    `;
    expect(layoutFontBindings(layout)).toEqual([
      { variable: "--font-geist-sans", family: "Geist Sans", applied: true },
    ]);
  });

  it("reads next/font/google exports: name is the family, underscores become spaces (umami af1b6c6e src/app/layout.tsx)", () => {
    const layout = `
      import { Inter } from 'next/font/google';
      const inter = Inter({
        subsets: ['latin'],
        display: 'swap',
        variable: '--font-inter',
      });
      export default function ({ children }) {
        return <html lang="en" className={\`\${inter.className} \${inter.variable}\`}><body>{children}</body></html>;
      }
    `;
    expect(layoutFontBindings(layout)).toEqual([
      { variable: "--font-inter", family: "Inter", applied: true },
    ]);
  });

  it("marks imported-but-unapplied fonts and multi-word google families", () => {
    const layout = `
      import { Libre_Franklin } from "next/font/google";
      const libre = Libre_Franklin({ subsets: ["latin"] });
      export const unusedConfig = true;
    `;
    expect(layoutFontBindings(layout)).toEqual([
      { variable: null, family: "Libre Franklin", applied: false },
    ]);
  });
});

describe("deriveBodyFontStack", () => {
  it("skateshop shape: config head resolves through the layout's geist import", () => {
    const derived = deriveBodyFontStack({
      layout: 'import { GeistSans } from "geist/font/sans"\nimport { GeistMono } from "geist/font/mono"\n<body className={cn("min-h-screen bg-background font-sans antialiased", GeistSans.variable, GeistMono.variable)} />',
      tailwindConfig: 'fontFamily: { sans: ["var(--font-geist-sans)", ...fontFamily.sans] }',
      cssText: "@tailwind base;",
      resolveCssVar: noCssVars,
    });
    expect(derived?.value).toBe(
      "Geist Sans, ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji",
    );
    expect(derived?.provenance).toBe("tailwind.config fontFamily.sans");
  });

  it("vercel-commerce shape: Tailwind v4 with a single applied font gets the default tail", () => {
    const derived = deriveBodyFontStack({
      layout: 'import { GeistSans } from "geist/font/sans";\n<html lang="en" className={GeistSans.variable} />',
      tailwindConfig: null,
      cssText: '@import "tailwindcss";\n@plugin "@tailwindcss/typography";',
      resolveCssVar: noCssVars,
    });
    expect(derived?.value).toBe(
      "Geist Sans, ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji",
    );
  });

  it("umami shape: single applied next/font family with no Tailwind stays bare (no invented tail)", () => {
    const derived = deriveBodyFontStack({
      layout: "import { Inter } from 'next/font/google';\nconst inter = Inter({ variable: '--font-inter' });\n<html className={`${inter.className} ${inter.variable}`} />",
      tailwindConfig: null,
      cssText: ":root { --base-color: #fafafa; }",
      resolveCssVar: noCssVars,
    });
    expect(derived).toEqual({ value: "Inter", provenance: "(next/font) Inter" });
  });

  it("a CSS-declared variable head outranks the font-binding fallback", () => {
    const derived = deriveBodyFontStack({
      layout: null,
      tailwindConfig: 'fontFamily: { sans: ["var(--brand-font)", "sans-serif"] }',
      cssText: "",
      resolveCssVar: (name) => (name === "--brand-font" ? "Custom Grotesk" : null),
    });
    expect(derived?.value).toBe("Custom Grotesk, sans-serif");
  });

  it("fails closed: unresolvable config head, multiple applied fonts, mono-only, or nothing applied", () => {
    // Config head var with no CSS declaration and no layout binding.
    expect(deriveBodyFontStack({
      layout: null,
      tailwindConfig: 'fontFamily: { sans: ["var(--font-sans)", ...fontFamily.sans] }',
      cssText: "",
      resolveCssVar: noCssVars,
    })).toBeNull();
    // Two applied non-mono fonts — ambiguous body font.
    expect(deriveBodyFontStack({
      layout: `
        import { Inter, Lora } from "next/font/google";
        const inter = Inter({});
        const lora = Lora({});
        <body className={inter.className + lora.className} />
      `,
      tailwindConfig: null,
      cssText: "",
      resolveCssVar: noCssVars,
    })).toBeNull();
    // Only a mono font applied — never the body sans.
    expect(deriveBodyFontStack({
      layout: 'import { GeistMono } from "geist/font/mono";\n<html className={GeistMono.variable} />',
      tailwindConfig: null,
      cssText: '@import "tailwindcss";',
      resolveCssVar: noCssVars,
    })).toBeNull();
    // invoify shape (93b21a22): fonts wired via lib/fonts.ts, invisible from
    // the layout — nothing derives, the staged pass keeps the slot.
    expect(deriveBodyFontStack({
      layout: 'import { outfit } from "@/lib/fonts";\n<body className={outfit.className} />',
      tailwindConfig: null,
      cssText: "@tailwind base;",
      resolveCssVar: noCssVars,
    })).toBeNull();
  });
});
