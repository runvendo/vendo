import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTheme } from "./extract-theme.js";
import { detectTarget } from "../detect.js";

const fixtures = path.join(fileURLToPath(new URL(".", import.meta.url)), "../../test/fixtures/theme");

/** Stage a fixture app (globals.css + layout.tsx snapshots of a demo app) in a temp dir. */
async function stageFixtureApp(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `theme-${name}-`));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^4.0.0" } }),
  );
  await mkdir(path.join(dir, "src/app"), { recursive: true });
  await copyFile(path.join(fixtures, name, "globals.css"), path.join(dir, "src/app/globals.css"));
  await copyFile(path.join(fixtures, name, "layout.tsx"), path.join(dir, "src/app/layout.tsx"));
  return dir;
}

describe("extractTheme", () => {
  it("writes a valid theme.json from a v4 css app", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/globals.css"),
      "@theme { --color-bg: #FBFBFA; --color-surface: #FFFFFF; --color-ink: #111111; --color-muted: #908C85; --radius-card: 14px; }",
    );
    const info = await detectTarget(dir);
    const summary = await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.background).toBe("#fbfbfa");
    expect(written.version).toBe(1);
    expect(summary.written).toBe(true);
    expect(summary.defaulted).toContain("accent");
  });

  it("lets an explicit CSS declaration of a next/font variable win over the synthesized value", async () => {
    const dir = await stageFixtureApp("maple");
    await writeFile(
      path.join(dir, "src/app/globals.css"),
      '@theme { --color-bg: #FBFBFA; --font-inter: "Custom Corp Sans", sans-serif; --font-sans: var(--font-inter); }',
    );
    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.fontFamily).toBe('"Custom Corp Sans", sans-serif');
  });

  it("recovers next/font vars declared in a conventional fonts.ts module", async () => {
    const dir = await stageFixtureApp("maple");
    await writeFile(path.join(dir, "src/app/layout.tsx"), "export default function RootLayout() { return null }\n");
    await mkdir(path.join(dir, "src/app/ui"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/ui/fonts.ts"),
      'import { Inter } from "next/font/google"\nexport const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })\n',
    );
    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.fontFamily).toContain("Inter");
  });

  it("follows explicit package CSS imports and lets later local CSS override them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-imports-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "node_modules/@acme/theme"), { recursive: true });
    await writeFile(path.join(dir, "node_modules/@acme/theme/package.json"), JSON.stringify({ name: "@acme/theme" }));
    await writeFile(
      path.join(dir, "node_modules/@acme/theme/styles.css"),
      `:root {
        --gray-50: oklch(0.985 0 0);
        --gray-500: oklch(0.556 0 0);
        --gray-900: oklch(0.205 0 0);
        --primary: var(--gray-900);
        --surface-base: #fff;
        --surface-raised: var(--gray-50);
        --text-primary: var(--gray-900);
        --text-muted: var(--gray-500);
        --radius-default: 0.375rem;
      }`,
    );
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/layout.tsx"),
      `import { Inter } from "next/font/google";
import "@acme/theme/styles.css";
import "./globals.css";
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
export default function RootLayout({ children }) { return <html className={inter.variable}><body>{children}</body></html>; }
`,
    );
    await writeFile(path.join(dir, "src/app/globals.css"), `:root { --primary: oklch(62.3% 0.214 259.815); --font-family: var(--font-inter), sans-serif; }`);

    const info = await detectTarget(dir);
    const summary = await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written).toMatchObject({
      background: "#fafafa",
      surface: "#ffffff",
      accent: "#2b7fff",
      text: "#171717",
      mutedText: "#737373",
      radius: "6px",
      fontFamily: "Inter, sans-serif",
    });
    expect(summary.defaulted).toEqual([]);
  });

  it("follows CSS @import chains outside the app directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-css-import-chain-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "packages/theme"), { recursive: true });
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(
      path.join(dir, "packages/theme/tokens.css"),
      `:root {
        --background: hsla(220, 14%, 94%, 1);
        --card: #fff;
        --primary: #111827;
        --foreground: #3c3e44;
        --muted-foreground: #9ca3b0;
        --radius: 0.25rem;
      }`,
    );
    await writeFile(path.join(dir, "src/app/globals.css"), `@import "../../packages/theme/tokens.css";`);
    await writeFile(path.join(dir, "src/app/layout.tsx"), `import "./globals.css"; export default function RootLayout({ children }) { return <body>{children}</body>; }`);

    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written).toMatchObject({
      background: "#eeeff2",
      surface: "#ffffff",
      accent: "#111827",
      text: "#3c3e44",
      mutedText: "#9ca3b0",
      radius: "4px",
    });
  });

  it("prefers entry-reachable CSS over unrelated app CSS files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-entry-css-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "app"), { recursive: true });
    await mkdir(path.join(dir, "modules/ui"), { recursive: true });
    await writeFile(
      path.join(dir, "modules/ui/globals.css"),
      `@theme {
        --color-brand: #00e6ca;
        --color-primary: #0f172a;
        --color-secondary: #f1f5f9;
        --background: #ffffff;
        --radius: 0.5rem;
      }`,
    );
    await writeFile(
      path.join(dir, "app/layout.tsx"),
      `import "../modules/ui/globals.css"; export default function RootLayout({ children }) { return <body>{children}</body>; }`,
    );
    await writeFile(
      path.join(dir, "app/unrelated.css"),
      `:root { --foreground: #7f1d1d; --muted-foreground: #fee2e2; --primary: #7f1d1d; }`,
    );

    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written).toMatchObject({
      accent: "#00e6ca",
      surface: "#f1f5f9",
      text: "#0f172a",
      mutedText: "#64748b",
    });
  });

  it("keeps nested route layouts from overriding root layout theme inference", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-root-layout-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "app/nested"), { recursive: true });
    await mkdir(path.join(dir, "modules/ui"), { recursive: true });
    await writeFile(
      path.join(dir, "modules/ui/globals.css"),
      `@theme {
        --color-brand: #00e6ca;
        --color-primary: #0f172a;
        --color-secondary: #f1f5f9;
        --color-error-foreground: #7f1d1d;
        --color-error-background-muted: #fee2e2;
      }`,
    );
    await writeFile(
      path.join(dir, "app/layout.tsx"),
      `import "../modules/ui/globals.css"; export default function RootLayout({ children }) { return <body>{children}</body>; }`,
    );
    await writeFile(
      path.join(dir, "app/nested/layout.tsx"),
      `export default function NestedLayout({ children }) { return <main className="bg-slate-50 text-slate-700">{children}</main>; }`,
    );

    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written).toMatchObject({
      background: "#FFFFFF",
      surface: "#f1f5f9",
      text: "#0f172a",
      mutedText: "#64748b",
    });
  });

  it("resolves self-referential CSS font vars through inline next/font styles", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-inline-font-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "app"), { recursive: true });
    await writeFile(
      path.join(dir, "app/globals.css"),
      `:root {
        --background: #ffffff;
        --font-sans: var(--font-sans);
      }`,
    );
    await writeFile(
      path.join(dir, "app/layout.tsx"),
      `import { Inter } from "next/font/google";
import "./globals.css";
const interFont = Inter({ subsets: ["latin"], variable: "--font-sans" });
export default function RootLayout({ children }) {
  return <html><head><style>{\`:root { --font-sans: \${interFont.style.fontFamily.replace(/\\'/g, "")}, system-ui; }\`}</style></head><body>{children}</body></html>;
}
`,
    );

    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.fontFamily).toBe("Inter, system-ui, sans-serif");
  });

  it("falls back to nested layouts when the root layout is only a passthrough", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-passthrough-layout-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "app/[locale]"), { recursive: true });
    await writeFile(
      path.join(dir, "app/globals.css"),
      `:root {
        --background: 0 0% 100%;
        --foreground: 222.2 84% 4.9%;
        --card: 0 0% 100%;
        --primary: 222.2 47.4% 11.2%;
        --muted-foreground: 215.4 16.3% 46.9%;
      }`,
    );
    await writeFile(path.join(dir, "app/layout.tsx"), `import "./globals.css"; export default function RootLayout({ children }) { return children; }`);
    await writeFile(
      path.join(dir, "app/[locale]/layout.tsx"),
      `export default function LocaleLayout({ children }) { return <html><body className="bg-slate-100">{children}</body></html>; }`,
    );

    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.background).toBe("#f1f5f9");
  });

  it("loads Tailwind TypeScript configs and resolves font vars through next/font", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-tw-ts-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^3.4.0" } }));
    await writeFile(
      path.join(dir, "tailwind.config.ts"),
      `const fontFamily = { sans: ["ui-sans-serif", "system-ui", "sans-serif"] };
export default {
  theme: { extend: {
    colors: {
      background: "hsl(var(--background))",
      foreground: "hsl(var(--foreground))",
      primary: { DEFAULT: "hsl(var(--primary))" },
      muted: { foreground: "hsl(var(--muted-foreground))" },
      card: { DEFAULT: "hsl(var(--card))" },
    },
    borderRadius: { lg: "var(--radius)" },
    fontFamily: { sans: ["var(--font-sans)", ...fontFamily.sans] },
  } },
};`,
    );
    await mkdir(path.join(dir, "app"), { recursive: true });
    await writeFile(
      path.join(dir, "app/layout.tsx"),
      `import { Inter as FontSans } from "next/font/google";
const fontSans = FontSans({ subsets: ["latin"], variable: "--font-sans" });
export default function RootLayout({ children }) { return <html className={fontSans.variable}><body>{children}</body></html>; }
`,
    );
    await writeFile(
      path.join(dir, "app/globals.css"),
      `:root {
        --background: 0 0% 100%;
        --foreground: 222.2 47.4% 11.2%;
        --card: 0 0% 100%;
        --primary: 222.2 47.4% 11.2%;
        --muted-foreground: 215.4 16.3% 46.9%;
        --radius: 0.5rem;
      }`,
    );

    const info = await detectTarget(dir);
    const summary = await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written).toMatchObject({
      accent: "#0f172a",
      text: "#0f172a",
      mutedText: "#64748b",
      radius: "8px",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    });
    expect(summary.defaulted).toEqual([]);
  });

  it("collects Geist package font vars referenced by Tailwind configs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-geist-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^3.4.0" } }));
    await writeFile(
      path.join(dir, "tailwind.config.ts"),
      `const fontFamily = { sans: ["ui-sans-serif", "system-ui", "sans-serif"] };
export default {
  theme: { extend: { fontFamily: { sans: ["var(--font-geist-sans)", ...fontFamily.sans] } } },
};`,
    );
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/layout.tsx"),
      `import { GeistSans } from "geist/font/sans";
export default function RootLayout({ children }) { return <body className={GeistSans.variable}>{children}</body>; }
`,
    );
    await writeFile(path.join(dir, "src/app/globals.css"), `:root { --background: 0 0% 100%; }`);

    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.fontFamily).toBe("Geist Sans, ui-sans-serif, system-ui, sans-serif");
  });

  it("recovers Next layout className font and Tailwind page background", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-next-layout-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0", tailwindcss: "^3.4.0" } }));
    await writeFile(path.join(dir, "tailwind.config.js"), `module.exports = { theme: { extend: {} } };`);
    await mkdir(path.join(dir, "app/[locale]"), { recursive: true });
    await writeFile(
      path.join(dir, "app/[locale]/layout.tsx"),
      `import { Outfit } from "next/font/google";
const outfit = Outfit({ subsets: ["latin"] });
export default function LocaleLayout({ children }) {
  return <body className={\`\${outfit.className} bg-slate-100 dark:bg-slate-800\`}>{children}</body>;
}
`,
    );
    await writeFile(
      path.join(dir, "app/globals.css"),
      `:root {
        --background: 0 0% 100%;
        --foreground: 222.2 84% 4.9%;
        --card: 0 0% 100%;
        --primary: 222.2 47.4% 11.2%;
        --muted-foreground: 215.4 16.3% 46.9%;
        --radius: 0.5rem;
      }`,
    );

    const info = await detectTarget(dir);
    await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.background).toBe("#f1f5f9");
    expect(written.fontFamily).toBe("Outfit, sans-serif");
  });

  it("extracts Cadence (demo-accounting) tokens: surface background, scale accent, next/font family", async () => {
    const dir = await stageFixtureApp("cadence");
    const info = await detectTarget(dir);
    const summary = await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    // Page background is --color-surface, NOT the --color-status-missing-bg badge tint.
    expect(written.background).toBe("#f7f5f1");
    expect(written.surface).toBe("#ffffff");
    expect(written.text).toBe("#221e19");
    // Single evergreen scale family -> mid step.
    expect(written.accent).toBe("#34816a");
    // --font-sans -> var(--font-hanken) resolved through the next/font wiring.
    expect(written.fontFamily).toContain("Hanken Grotesk");
    expect(written.fontFamily).not.toContain("var(");
    // Genuinely absent tokens stay defaulted and flagged (fail-closed).
    expect(summary.defaulted).toContain("mutedText");
    expect(summary.defaulted).toContain("radius");
    expect(summary.written).toBe(true);
  });

  it("extracts Maple (demo-bank) tokens at least as well as before (regression baseline)", async () => {
    const dir = await stageFixtureApp("maple");
    const info = await detectTarget(dir);
    const summary = await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(written.background).toBe("#fbfbfa");
    expect(written.surface).toBe("#ffffff");
    expect(written.text).toBe("#111111");
    expect(written.mutedText).toBe("#908c85");
    expect(written.radius).toBe("14px");
    expect(written.fontFamily).toContain("Inter");
    // No accent-ish token in Maple — stays defaulted and flagged.
    expect(summary.defaulted).toEqual(["accent"]);
    expect(summary.written).toBe(true);
  });
});
