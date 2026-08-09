import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The extractor with no `typescript` to resolve — the shape a JS-only Next
 * host, a strict pnpm tree, or an npx-run CLI presents. Before this, every
 * next/font derivation went dark there and the standard
 * `--font-sans: var(--font-inter)` root layout fell through to neutral
 * defaults ("No host evidence for fontFamily"), which is what the Keystone
 * stub hit. The var must resolve to the family the loader declares, and
 * everything that needs PROOF a font reaches the markup must still fail
 * closed.
 */

/** The Keystone stub verbatim (~/Desktop/keystone-init-cast/keystone-stub). */
const KEYSTONE_LAYOUT = `import type { Metadata } from "next";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });

export const metadata: Metadata = { title: "Keystone" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={\`\${inter.variable} \${fraunces.variable}\`}>
        {children}
      </body>
    </html>
  );
}
`;

const KEYSTONE_CSS = `:root {
  --background: #fbfaf7;
  --foreground: #14201c;
  --primary: #1f6f5c;
  --radius: 8px;
  --font-sans: var(--font-inter), system-ui, sans-serif;
  --font-display: Fraunces, Georgia, serif;
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}
`;

beforeEach(() => {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => { throw new Error("Cannot find module 'typescript'"); },
  }));
});

afterEach(() => {
  vi.doUnmock("node:module");
  vi.resetModules();
});

describe("layoutFontBindings without a TypeScript compiler", () => {
  it("still names each next/font variable's family", async () => {
    const { layoutFontBindings } = await import("../../../src/cli/theme/font-stack.js");
    expect(layoutFontBindings(KEYSTONE_LAYOUT)).toEqual([
      { variable: "--font-inter", family: "Inter", applied: false },
      { variable: "--font-fraunces", family: "Fraunces", applied: false },
    ]);
  });

  it("reads aliased imports, multi-word families, and geist's fixed names", async () => {
    const { layoutFontBindings } = await import("../../../src/cli/theme/font-stack.js");
    expect(layoutFontBindings(`
      import { GeistSans } from "geist/font/sans";
      import { Plus_Jakarta_Sans as Body } from "next/font/google";
      const body = Body({ subsets: ["latin"], variable: "--font-body" });
    `)).toEqual([
      { variable: "--font-geist-sans", family: "Geist Sans", applied: false },
      { variable: "--font-body", family: "Plus Jakarta Sans", applied: false },
    ]);
  });

  it("reads no font out of commented-out imports (review: text is not evidence)", async () => {
    const { layoutFontBindings } = await import("../../../src/cli/theme/font-stack.js");
    expect(layoutFontBindings(`
      // Old migration note: import { GeistSans } from "geist/font/sans";
      /* was: import { Inter } from "next/font/google";
         const inter = Inter({ variable: "--font-inter" }); */
      export default function L({ children }) { return <body>{children}</body>; }
    `)).toEqual([]);
  });

  it("reads no variable out of a loader call quoted in a string (review)", async () => {
    const { layoutFontBindings } = await import("../../../src/cli/theme/font-stack.js");
    expect(layoutFontBindings(`
      import { Inter } from "next/font/google";
      const usage = "example: Inter({ variable: '--font-example' })";
      export default function L({ children }) { return <body>{children}</body>; }
    `)).toEqual([{ variable: null, family: "Inter", applied: false }]);
  });

  it("never claims a font is applied — proof-requiring derivations stay closed", async () => {
    const { deriveBodyFontStack, layoutFontBindings } = await import("../../../src/cli/theme/font-stack.js");
    // One next/font family, applied in the markup, no --font-sans to lean on:
    // WITH a compiler this derives; without one it must not.
    const layout = `
      import { Inter } from "next/font/google";
      const inter = Inter({ subsets: ["latin"] });
      export default function L({ children }) { return <body className={inter.className}>{children}</body>; }
    `;
    expect(layoutFontBindings(layout).every((binding) => !binding.applied)).toBe(true);
    expect(deriveBodyFontStack({
      layout,
      tailwindConfig: null,
      cssText: "",
      resolveCssVar: () => null,
    })).toBeNull();
  });

  it("fails closed on a next/font/local variable — the loader declares no family", async () => {
    const { deriveBodyFontStack } = await import("../../../src/cli/theme/font-stack.js");
    expect(deriveBodyFontStack({
      layout: `
        import localFont from "next/font/local";
        const brand = localFont({ src: "./brand.woff2", variable: "--font-brand" });
      `,
      tailwindConfig: null,
      cssText: "",
      resolveCssVar: () => null,
      cssFontSans: "var(--font-brand), sans-serif",
    })).toBeNull();
  });
});

describe("extractTheme on the Keystone stub without a TypeScript compiler", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vendo-keystone-stub-"));
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "app", "layout.tsx"), KEYSTONE_LAYOUT);
    await writeFile(join(root, "app", "globals.css"), KEYSTONE_CSS);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports the real font instead of neutral defaults", async () => {
    const { extractTheme } = await import("../../../src/cli/theme/extract-theme.js");
    const summary = await extractTheme(root);
    expect(summary.slots.fontFamily).toBe("Inter, system-ui, sans-serif");
    expect(summary.matched.fontFamily).toBe("--font-sans (next/font vars)");
    expect(summary.defaulted).not.toContain("fontFamily");
  });

  it("still falls back to neutral defaults when the variable is genuinely unresolvable", async () => {
    await writeFile(join(root, "app", "globals.css"),
      KEYSTONE_CSS.replace("var(--font-inter)", "var(--font-nowhere)"));
    const { extractTheme } = await import("../../../src/cli/theme/extract-theme.js");
    const summary = await extractTheme(root);
    expect(summary.slots.fontFamily).toBe("system-ui, sans-serif");
    expect(summary.defaulted).toContain("fontFamily");
  });
});
