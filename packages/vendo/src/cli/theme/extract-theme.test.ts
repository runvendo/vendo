import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyThemeDraft, extractTheme, validateSlotValue, type ThemeSummary } from "./extract-theme.js";

const cleanup: string[] = [];
const appsDir = fileURLToPath(new URL("../../../../../apps/", import.meta.url));

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-theme-"));
  cleanup.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

describe("extractTheme allowlist fast-path", () => {
  it("reads a fully conventional shadcn sheet exactly, with zero model involvement", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      "app/globals.css": `
        :root {
          --background: #fafafa;
          --foreground: oklch(0.205 0 0);
          --card: 0 0% 100%;
          --primary: hsl(262 83% 58%);
          --primary-foreground: #ffffff;
          --muted-foreground: #737373;
          --border: #dedede;
          --destructive: #b91c1c;
          --radius: 0.625rem;
          --font-sans: Inter, sans-serif;
          --font-heading: Newsreader, serif;
          --density: compact;
          --motion: reduced;
        }
        .dark { --background: #09090b; --foreground: #fafafa; }
      `,
    });

    const result = await extractTheme(root);

    expect(result.usedModel).toBe(false);
    expect(result.slots).toMatchObject({
      background: "#fafafa",
      text: "#171717",
      surface: "#ffffff",
      accent: "#7c3bed",
      accentText: "#ffffff",
      mutedText: "#737373",
      border: "#dedede",
      danger: "#b91c1c",
      radius: "10px",
      fontFamily: "Inter, sans-serif",
      headingFamily: "Newsreader, serif",
      density: "compact",
      motion: "reduced",
    });
    expect(result.matched["accent"]).toBe("--primary");
    expect(result.defaulted).toEqual(["baseSize"]);
    expect(result.hasDarkVariant).toBe(true);
    // Every slot but baseSize was read exactly — `needed` mirrors `defaulted`
    // exactly when nothing derives (accentText/headingFamily were both exact
    // reads here too).
    expect(result.needed).toEqual(["baseSize"]);
    // The context gatherer's own collected paths, repo-relative.
    expect(result.evidencePaths).toEqual(expect.arrayContaining(["app/layout.tsx", "app/globals.css"]));
  });

  it("strips quotes from font family names (quotes are optional CSS syntax, not identity)", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return children; }\n',
      "app/globals.css": ':root { --font-sans: "Outfit", sans-serif; --font-heading: \'Newsreader\', serif; }\n',
    });

    const result = await extractTheme(root);

    expect(result.slots.fontFamily).toBe("Outfit, sans-serif");
    expect(result.slots.headingFamily).toBe("Newsreader, serif");
    // The same canonicalization gates proposed values (model or human).
    expect(validateSlotValue("fontFamily", '"Outfit", sans-serif')).toBe("Outfit, sans-serif");
    expect(validateSlotValue("fontFamily", 'Geist, "Apple Color Emoji", sans-serif')).toBe("Geist, Apple Color Emoji, sans-serif");
  });

  it("accepts the Tailwind-v4 --color-* spellings, !important noise, and @import chains", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./global.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      "app/global.css": '@import "./tokens.css";\n',
      "app/tokens.css": `
        @theme {
          --color-background: #ffffff;
          --color-foreground: #111827;
          --color-primary: #2b7fff !important;
          --color-border: #e5e7eb;
        }
      `,
    });

    const result = await extractTheme(root);

    expect(result.slots).toMatchObject({
      background: "#ffffff",
      text: "#111827",
      accent: "#2b7fff",
      border: "#e5e7eb",
      // No accent-text token: derived by the larger WCAG contrast ratio.
      accentText: "#000000",
    });
    expect(result.matched["accentText"]).toBe("(contrast) accent");
    expect(result.usedModel).toBe(false);
  });

  it("derives accentText without any model involvement when every other core token is exact", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      // Everything brand-defining except --primary-foreground: accentText is
      // a derivation, never a reason to spend a model call.
      "app/globals.css": `
        :root {
          --background: #ffffff;
          --foreground: #111827;
          --card: #f9fafb;
          --primary: #1d4ed8;
          --muted-foreground: #6b7280;
          --border: #e5e7eb;
          --destructive: #b91c1c;
          --radius: 8px;
          --font-sans: Inter, sans-serif;
        }
      `,
    });

    const result = await extractTheme(root);

    expect(result.usedModel).toBe(false);
    expect(result.slots.accentText).toBe("#ffffff");
    expect(result.matched["accentText"]).toBe("(contrast) accent");
  });

  it("never claims a non-conventional token: unknown names go to defaults, reported", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      // A custom token set (Cadence-style names): nothing here is on the
      // allowlist, so with no model every slot defaults — visibly.
      "app/globals.css": ":root { --color-ink: #111111; --color-line: #ecebe8; --color-evergreen-600: #196b46; }\n",
    });

    const result = await extractTheme(root);

    expect(result.slots.accent).toBe("#2563eb");
    expect(result.defaulted).toEqual(expect.arrayContaining([
      "accent", "background", "surface", "text", "mutedText", "border", "danger", "fontFamily",
    ]));
    expect(result.usedModel).toBe(false);
  });
});

// A base fixture with exactly one exact read (--border) — every other slot
// lands in `needed`, so it exercises applyThemeDraft's merge broadly.
const CUSTOM_TOKEN_APP = {
  "package.json": "{}\n",
  "app/layout.tsx": [
    'import { Inter } from "next/font/google";',
    'import "./globals.css";',
    'const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });',
    "export default function Layout({ children }) { return <html className={inter.variable}><body>{children}</body></html>; }",
  ].join("\n"),
  "app/globals.css": `
    :root {
      --border: #ecebe8;
      --color-ink: #111111;
      --color-bg: #fbfbfa;
      --font-sans: var(--font-inter);
    }
  `,
};

describe("applyThemeDraft (merges a parsed theme-stage artifact onto an exact-only summary)", () => {
  async function baseSummary(): Promise<ThemeSummary> {
    return extractTheme(await fixture(CUSTOM_TOKEN_APP));
  }

  it("never overwrites an exact read, fills only needed slots, and drops invalid model values", async () => {
    const summary = await baseSummary();
    expect(summary.matched["border"]).toBe("--border");
    expect(summary.needed).toContain("accent");
    expect(summary.needed).not.toContain("border");

    const merged = applyThemeDraft(summary, {
      slots: {
        // Exact reads are authoritative: this must NOT override --border.
        border: "#ff0000",
        accent: "#111111",
        mutedText: "not-a-color",
      },
    });

    expect(merged.slots.border).toBe("#ecebe8");
    expect(merged.matched["border"]).toBe("--border");
    expect(merged.slots.accent).toBe("#111111");
    expect(merged.matched["accent"]).toBe("(model)");
    // Invalid value: ignored, the slot stays defaulted.
    expect(merged.defaulted).toContain("mutedText");
    expect(merged.defaulted).not.toContain("accent");
    expect(merged.usedModel).toBe(true);
  });

  it("a model-provided accentText stands over the contrast derivation", async () => {
    const summary = await baseSummary();
    const merged = applyThemeDraft(summary, {
      slots: { accent: "#111111", accentText: "#eeeeee" },
    });
    expect(merged.slots.accentText).toBe("#eeeeee");
    expect(merged.matched["accentText"]).toBe("(model)");
  });

  it("re-derives accentText by contrast when the model fills accent but not accentText", async () => {
    const summary = await baseSummary();
    const merged = applyThemeDraft(summary, { slots: { accent: "#111111" } });
    expect(merged.slots.accentText).toBe("#ffffff"); // WCAG contrast against a dark accent
    expect(merged.matched["accentText"]).toBe("(contrast) accent");
  });

  it("headingFamily inherits fontFamily when neither is exact but the model fills fontFamily", async () => {
    // Fonts wired through a separate module (invoify shape) are invisible to
    // the deterministic derivation — fontFamily genuinely stays needed here.
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": [
        'import { outfit } from "@/lib/fonts";',
        'import "./globals.css";',
        "export default function Layout({ children }) { return <html className={outfit.className}><body>{children}</body></html>; }",
      ].join("\n"),
      "app/globals.css": ":root { --border: #ecebe8; }\n",
    });
    const summary = await extractTheme(root);
    expect(summary.needed).toContain("fontFamily");
    const merged = applyThemeDraft(summary, { slots: { fontFamily: "Geist, sans-serif" } });
    expect(merged.slots.headingFamily).toBe("Geist, sans-serif");
    expect(merged.matched["headingFamily"]).toBe("(inherit) fontFamily");
  });

  it("an exact accentText is never reconsidered, even if the draft tries to fill it", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      "app/globals.css": ":root { --primary-foreground: #123456; }\n",
    });
    const summary = await extractTheme(root);
    expect(summary.matched["accentText"]).toBe("--primary-foreground");
    expect(summary.needed).not.toContain("accentText");

    const merged = applyThemeDraft(summary, { slots: { accent: "#111111", accentText: "#000000" } });
    expect(merged.slots.accentText).toBe("#123456");
    expect(merged.matched["accentText"]).toBe("--primary-foreground");
  });

  it("filters uncertainty to brand slots that were actually needed", async () => {
    const summary = await baseSummary();
    const merged = applyThemeDraft(summary, {
      slots: { accent: "#111111" },
      uncertain: [
        { slot: "accent", note: "two plausible brand colors" },
        // Moot: border was read exactly, so doubt about it is not actionable.
        { slot: "border", note: "moot — read exactly" },
        // Not a brand slot: density never triggers a question on its own.
        { slot: "density", note: "unclear from the sheet" },
        { slot: "not-a-slot", note: "ignored" },
      ],
    });
    expect(merged.uncertain).toEqual([{ slot: "accent", note: "two plausible brand colors" }]);
  });

  it("usedModel stays false when the draft contributes nothing accepted", async () => {
    const summary = await baseSummary();
    const merged = applyThemeDraft(summary, { slots: { mutedText: "not-a-color" } });
    expect(merged.usedModel).toBe(false);
    expect(merged.slots.accent).toBe(summary.slots.accent); // untouched default
  });
});

describe("extractTheme deterministic body-font-stack derivation (full source stacks, corpus evidence 2026-07-25)", () => {
  it("skateshop shape (e954d543): tailwind config var head + default spread emits the FULL source-declared stack", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "src/app/layout.tsx": [
        'import "@/styles/globals.css"',
        'import { GeistMono } from "geist/font/mono"',
        'import { GeistSans } from "geist/font/sans"',
        "export default function RootLayout({ children }) {",
        '  return <html lang="en"><body className={cn("min-h-screen bg-background font-sans antialiased", GeistSans.variable, GeistMono.variable)}>{children}</body></html>;',
        "}",
      ].join("\n"),
      "src/styles/globals.css": ":root { --background: 0 0% 100%; --radius: 0.5rem; }\n",
      "tailwind.config.ts": [
        'import { fontFamily } from "tailwindcss/defaultTheme"',
        "export default {",
        "  theme: {",
        "    extend: {",
        "      fontFamily: {",
        '        sans: ["var(--font-geist-sans)", ...fontFamily.sans],',
        '        mono: ["var(--font-geist-mono)", ...fontFamily.mono],',
        '        heading: ["var(--font-heading)", ...fontFamily.sans],',
        "      },",
        "    },",
        "  },",
        "}",
      ].join("\n"),
    });

    const result = await extractTheme(root);

    expect(result.slots.fontFamily).toBe("Geist Sans, ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji");
    expect(result.matched["fontFamily"]).toBe("tailwind.config fontFamily.sans");
    expect(result.needed).not.toContain("fontFamily");
  });

  it("vercel-commerce shape (3761e52e): Tailwind v4 + one applied geist font emits family + default tail", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": [
        'import { GeistSans } from "geist/font/sans";',
        'import "./globals.css";',
        "export default async function RootLayout({ children }) {",
        '  return <html lang="en" className={GeistSans.variable}><body>{children}</body></html>;',
        "}",
      ].join("\n"),
      "app/globals.css": '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n',
    });

    const result = await extractTheme(root);

    expect(result.slots.fontFamily).toBe("Geist Sans, ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji");
    expect(result.needed).not.toContain("fontFamily");
  });

  it("umami shape (af1b6c6e): a single next/font family without Tailwind stays short — no invented tail", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "src/app/layout.tsx": [
        "import { Inter } from 'next/font/google';",
        "import './global.css';",
        "const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });",
        "export default function ({ children }) {",
        "  return <html lang=\"en\" className={`${inter.className} ${inter.variable}`}><body>{children}</body></html>;",
        "}",
      ].join("\n"),
      "src/app/global.css": ":root { --base-color: #fafafa; }\n",
    });

    const result = await extractTheme(root);

    expect(result.slots.fontFamily).toBe("Inter, sans-serif");
    expect(result.matched["fontFamily"]).toBe("(next/font) Inter");
  });

  it("a CSS --font-sans whose refs are next/font variables resolves through the layout bindings", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": [
        'import { Outfit } from "next/font/google";',
        'import "./globals.css";',
        'const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });',
        "export default function Layout({ children }) { return <html className={outfit.variable}><body>{children}</body></html>; }",
      ].join("\n"),
      "app/globals.css": ":root { --font-sans: var(--font-outfit), sans-serif; }\n",
    });

    const result = await extractTheme(root);

    expect(result.slots.fontFamily).toBe("Outfit, sans-serif");
    expect(result.matched["fontFamily"]).toBe("--font-sans (next/font vars)");
  });

  it("counter-example: an exact short --font-sans stays short — nothing is appended or expanded", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      "app/globals.css": ":root { --font-sans: Inter, sans-serif; }\n",
    });

    const result = await extractTheme(root);

    expect(result.slots.fontFamily).toBe("Inter, sans-serif");
    expect(result.matched["fontFamily"]).toBe("--font-sans");
  });

  it("counter-example: ambiguous font evidence leaves the slot to the staged pass", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": [
        'import { Inter, Lora } from "next/font/google";',
        'import "./globals.css";',
        "const inter = Inter({});",
        "const lora = Lora({});",
        "export default function Layout({ children }) { return <html className={inter.className + lora.className}><body>{children}</body></html>; }",
      ].join("\n"),
      "app/globals.css": ":root { --border: #dedede; }\n",
    });

    const result = await extractTheme(root);

    expect(result.needed).toContain("fontFamily");
    expect(result.slots.fontFamily).toBe("system-ui, sans-serif");
  });
});

describe("extractTheme demo-app allowlist behavior (deterministic)", () => {
  it("Maple: exact reads claim only true conventional tokens — no wrong-brand exacts", async () => {
    const result = await extractTheme(join(appsDir, "demo-bank"));
    // Maple declares --color-border (allowlist) = #ECEBE8; its custom ink/bg
    // tokens are NOT claimed — they default without a model, visibly.
    expect(result.slots.border).toBe("#ecebe8");
    expect(result.matched["border"]).toBe("--color-border");
    expect(result.defaulted).toEqual(expect.arrayContaining(["accent", "background", "text", "mutedText"]));
  });

  it("Cadence: only the true conventional token is exact-claimed (--color-card), never --color-surface", async () => {
    const result = await extractTheme(join(appsDir, "demo-accounting"));
    // Cadence's --color-card #ffffff IS the shadcn card convention — a
    // correct exact read. Its --color-surface is the PAGE background, and
    // "surface" is not a shadcn name, so no exact pass may claim it: the
    // background slot stays default (visible), not silently wrong.
    expect(result.matched["surface"]).toBe("--color-card");
    expect(result.slots.surface).toBe("#ffffff");
    expect(result.defaulted).toEqual(expect.arrayContaining(["accent", "background", "text", "mutedText", "border"]));
  });
});
