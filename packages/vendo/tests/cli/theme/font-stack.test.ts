import { describe, expect, it } from "vitest";
import {
  TAILWIND_DEFAULT_SANS,
  deriveBodyFontStack,
  layoutFontBindings,
  tailwindConfigSansStack,
} from "../../../src/cli/theme/font-stack.js";

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
    expect(tailwindConfigSansStack(config)).toEqual({
      declared: true,
      entries: ["var(--font-geist-sans)", ...TAILWIND_DEFAULT_SANS],
    });
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
    expect(tailwindConfigSansStack(config)).toEqual({
      declared: true,
      entries: ["var(--font-geist)", ...TAILWIND_DEFAULT_SANS],
    });
  });

  it("reports a declared-but-unreadable sans on teable's custom spread (105e0f94 tailwind.theme.js:8)", () => {
    expect(tailwindConfigSansStack(`
      module.exports = {
        fontFamily: {
          sans: ['Inter Variable', ...browserFonts.sans],
        },
      };
    `)).toEqual({ declared: true, entries: null });
  });

  it("a dotted prefix merely ENDING in fontFamily.sans is NOT the Tailwind default (checker round 2)", () => {
    // designSystem is some custom object — its fontFamily.sans could be
    // anything; only a binding proven to come from tailwindcss/defaultTheme maps.
    expect(tailwindConfigSansStack(
      'import { designSystem } from "./design-system";\nexport default { theme: { fontFamily: { sans: ["var(--font-brand)", ...designSystem.fontFamily.sans] } } }',
    )).toEqual({ declared: true, entries: null });
    // Both recognized spellings still expand — with real provenance.
    expect(tailwindConfigSansStack(
      'import { fontFamily } from "tailwindcss/defaultTheme";\nexport default { theme: { fontFamily: { sans: [...fontFamily.sans] } } }',
    )).toEqual({ declared: true, entries: [...TAILWIND_DEFAULT_SANS] });
    expect(tailwindConfigSansStack(
      'import defaultTheme from "tailwindcss/defaultTheme";\nexport default { theme: { fontFamily: { sans: [...defaultTheme.fontFamily.sans] } } }',
    )).toEqual({ declared: true, entries: [...TAILWIND_DEFAULT_SANS] });
  });

  it("a LOCAL object with the exact defaultTheme spelling must NOT expand (checker round 4: provenance, not spelling)", () => {
    expect(tailwindConfigSansStack([
      'const fontFamily = { sans: ["Comic Sans MS"] };',
      'module.exports = { theme: { fontFamily: { sans: ["var(--font-brand)", ...fontFamily.sans] } } };',
    ].join("\n"))).toEqual({ declared: true, entries: null });
    // Aliased destructured require still counts as provenance.
    expect(tailwindConfigSansStack([
      'const { fontFamily: tw } = require("tailwindcss/defaultTheme");',
      'module.exports = { theme: { fontFamily: { sans: [...tw.sans] } } };',
    ].join("\n"))).toEqual({ declared: true, entries: [...TAILWIND_DEFAULT_SANS] });
  });

  it("shadowed/unprovable provenance fails CLOSED — symbol resolution, not spelling (checker round 6)", () => {
    // A namespace import whose path SPELLS fontFamily.sans but declares from
    // a different module: never the default.
    expect(tailwindConfigSansStack([
      'import * as myTokens from "./tokens";',
      'module.exports = { theme: { fontFamily: { sans: ["Brand", ...myTokens.fontFamily.sans] } } };',
    ].join("\n"))).toEqual({ declared: true, entries: null });
    // The sans value built behind a call (whose body shadows the import) is
    // a declaration we cannot prove: fail closed, never expand.
    expect(tailwindConfigSansStack([
      'import { fontFamily } from "tailwindcss/defaultTheme";',
      "function makeFonts() {",
      '  const fontFamily = { sans: ["Comic Sans MS"] };',
      '  return { sans: ["Brand", ...fontFamily.sans] };',
      "}",
      "module.exports = { theme: { extend: { fontFamily: makeFonts() } } };",
    ].join("\n"))).toEqual({ declared: true, entries: null });
  });

  it("an UNRELATED fontFamily object elsewhere in the config file is never read (checker round 6)", () => {
    // Previously any fontFamily key anywhere matched; the config's sans is
    // now located only through the exported config object.
    expect(tailwindConfigSansStack([
      'const emailStyles = { fontFamily: { sans: ["Georgia", "serif"] } };',
      "module.exports = { theme: { extend: { colors: {} } } };",
    ].join("\n"))).toEqual({ declared: false });
    // And an unlocatable export fails closed rather than falling through.
    expect(tailwindConfigSansStack("export default createConfig();")).toEqual({ declared: true, entries: null });
  });

  it("keeps literal-only stacks verbatim and reports undeclared when no sans key exists", () => {
    expect(tailwindConfigSansStack('module.exports = { theme: { fontFamily: { sans: ["Inter", "sans-serif"] } } }')).toEqual({
      declared: true,
      entries: ["Inter", "sans-serif"],
    });
    expect(tailwindConfigSansStack('module.exports = { theme: { fontFamily: { mono: ["Menlo", "monospace"] } } }')).toEqual({ declared: false });
    expect(tailwindConfigSansStack("module.exports = {}")).toEqual({ declared: false });
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

  it("a .variable reference parked in a dead constant is NOT applied (checker round 4: JSX attachment, not substring)", () => {
    const layout = `
      import { Inter } from "next/font/google";
      const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
      const cssVars = inter.variable; // never attached to JSX
      export default function Layout({ children }) {
        return <html><body>{children}</body></html>;
      }
    `;
    expect(layoutFontBindings(layout)).toEqual([
      { variable: "--font-inter", family: "Inter", applied: false },
    ]);
    // And therefore nothing derives — the model owns the slot.
    expect(deriveBodyFontStack({
      layout,
      tailwindConfig: null,
      cssText: '@import "tailwindcss";',
      resolveCssVar: noCssVars,
    })).toBeNull();
  });

  it("a SHADOWED font binding is NOT applied — the JSX reference resolves to the local, not the font (checker round 5)", () => {
    const layout = `
      import { Inter } from "next/font/google";
      const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
      export default function Layout({ children }) {
        const inter = { variable: "brand-x" }; // shadows the font local
        return <html className={inter.variable}><body>{children}</body></html>;
      }
    `;
    expect(layoutFontBindings(layout)).toEqual([
      { variable: "--font-inter", family: "Inter", applied: false },
    ]);
    expect(deriveBodyFontStack({
      layout,
      tailwindConfig: null,
      cssText: '@import "tailwindcss";',
      resolveCssVar: noCssVars,
    })).toBeNull();
    // Shadowed geist import: same law.
    const geistLayout = `
      import { GeistSans } from "geist/font/sans";
      export default function Layout({ children }) {
        const GeistSans = { variable: "not-the-font" };
        return <html className={GeistSans.variable}><body>{children}</body></html>;
      }
    `;
    expect(layoutFontBindings(geistLayout)).toEqual([
      { variable: "--font-geist-sans", family: "Geist Sans", applied: false },
    ]);
  });

  it("a HOISTED var shadow from a dead nested block still shadows — binder ground truth (checker round 6)", () => {
    const layout = `
      import { Inter } from "next/font/google";
      const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
      export default function Layout({ children }) {
        if (Math.random() < 0) {
          var inter = { variable: "never-executes-but-hoists" };
        }
        return <html className={inter.variable}><body>{children}</body></html>;
      }
    `;
    expect(layoutFontBindings(layout)).toEqual([
      { variable: "--font-inter", family: "Inter", applied: false },
    ]);
    expect(deriveBodyFontStack({
      layout,
      tailwindConfig: null,
      cssText: '@import "tailwindcss";',
      resolveCssVar: noCssVars,
    })).toBeNull();
  });
});

describe("deriveBodyFontStack", () => {
  it("skateshop shape: config head resolves through the layout's geist import", () => {
    const derived = deriveBodyFontStack({
      layout: 'import { GeistSans } from "geist/font/sans"\nimport { GeistMono } from "geist/font/mono"\n<body className={cn("min-h-screen bg-background font-sans antialiased", GeistSans.variable, GeistMono.variable)} />',
      tailwindConfig: 'import { fontFamily } from "tailwindcss/defaultTheme";\nexport default { theme: { extend: { fontFamily: { sans: ["var(--font-geist-sans)", ...fontFamily.sans] } } } }',
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
      tailwindConfig: 'module.exports = { theme: { fontFamily: { sans: ["var(--brand-font)", "sans-serif"] } } }',
      cssText: "",
      resolveCssVar: (name) => (name === "--brand-font" ? "Custom Grotesk" : null),
    });
    expect(derived?.value).toBe("Custom Grotesk, sans-serif");
  });

  it("fails closed: unresolvable config head, multiple applied fonts, mono-only, or nothing applied", () => {
    // Config head var with no CSS declaration and no layout binding.
    expect(deriveBodyFontStack({
      layout: null,
      tailwindConfig: 'import { fontFamily } from "tailwindcss/defaultTheme";\nexport default { theme: { fontFamily: { sans: ["var(--font-sans)", ...fontFamily.sans] } } }',
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

  it("a declared sans with an unknown custom spread fails CLOSED — never the default-stack guess (checker finding 3)", () => {
    // teable shape + an applied font binding + a Tailwind marker: every
    // fall-through condition is armed, and the answer must still be null —
    // the config declares a stack we cannot read, so the model stage owns it.
    expect(deriveBodyFontStack({
      layout: 'import { GeistSans } from "geist/font/sans";\n<html className={GeistSans.variable} />',
      tailwindConfig: "const { browserFonts } = require('../shared/browser-fonts');\nmodule.exports = { fontFamily: { sans: ['Inter Variable', ...browserFonts.sans] } };",
      cssText: '@import "tailwindcss";',
      resolveCssVar: noCssVars,
    })).toBeNull();
    // Same armed fall-throughs with a custom dotted prefix that merely ends
    // in fontFamily.sans (checker round 2): still null, never the default.
    expect(deriveBodyFontStack({
      layout: 'import { GeistSans } from "geist/font/sans";\n<html className={GeistSans.variable} />',
      tailwindConfig: 'import { designSystem } from "./ds";\nexport default { theme: { fontFamily: { sans: ["var(--font-geist-sans)", ...designSystem.fontFamily.sans] } } }',
      cssText: '@import "tailwindcss";',
      resolveCssVar: noCssVars,
    })).toBeNull();
  });
});
