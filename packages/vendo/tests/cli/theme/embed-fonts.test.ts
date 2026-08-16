import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { embedHostFonts } from "../../../src/cli/theme/embed-fonts.js";
import type { VendoTheme } from "@vendoai/apps/contract";
import { extractTheme, toVendoTheme, type ThemeSlotValues } from "../../../src/cli/theme/extract-theme.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-fonts-"));
  cleanup.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

/** The theme DOCUMENT the faces are resolved from — built through the real
 *  `toVendoTheme`, so these read families off exactly the shape sync persists
 *  rather than a hand-made stand-in. */
function theme(overrides: Partial<ThemeSlotValues>): VendoTheme {
  return toVendoTheme({
    accent: "#111111", accentText: "#ffffff", background: "#ffffff", border: "#e2e8f0",
    danger: "#dc2626", surface: "#f8fafc", text: "#0f172a", mutedText: "#64748b",
    radius: "8px", fontFamily: "system-ui, sans-serif", headingFamily: "system-ui, sans-serif",
    baseSize: "16px", density: "comfortable", motion: "full",
    ...overrides,
  });
}

/** Verbatim shape of a Next 16 / Turbopack `next build` of examples/demo-bank
 *  (`.next/static/chunks/<hash>.css`): a relative `../media/` URL, a per-build
 *  hash in the filename, and subsets distinguished ONLY by unicode-range —
 *  with the latin block minified to the wildcard `U+??`. */
const NEXT_FONT_CSS = `@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(../media/2c55a0e60120577a-s.0-dom-5bn10r2.woff2)format("woff2");unicode-range:U+460-52F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F}
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(../media/ad66f9afd8947f86-s.3lvt2whj97whp.woff2)format("woff2");unicode-range:U+1F??}
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(../media/83afe278b6a6bb3c-s.p.2bn3s6zvc0dyp.woff2)format("woff2");unicode-range:U+??,U+131,U+152-153,U+2BB-2BC,U+2000-206F,U+20AC,U+2122,U+FEFF,U+FFFD}`;

const LATIN_BYTES = Buffer.from("wOF2-latin-inter", "utf8");
const GREEK_BYTES = Buffer.from("wOF2-greek-inter", "utf8");
const CYRILLIC_BYTES = Buffer.from("wOF2-cyrillic-inter", "utf8");

async function demoBankLike(): Promise<string> {
  return fixture({
    ".next/static/chunks/2lqiqndktcdfa.css": NEXT_FONT_CSS,
    ".next/static/media/83afe278b6a6bb3c-s.p.2bn3s6zvc0dyp.woff2": LATIN_BYTES,
    ".next/static/media/ad66f9afd8947f86-s.3lvt2whj97whp.woff2": GREEK_BYTES,
    ".next/static/media/2c55a0e60120577a-s.0-dom-5bn10r2.woff2": CYRILLIC_BYTES,
  });
}

describe("embedHostFonts", () => {
  it("takes Inter from the next/font build output rather than Google, latin cut only", async () => {
    const root = await demoBankLike();
    const embedded = await embedHostFonts(root, theme({ fontFamily: "Inter, sans-serif", headingFamily: "Inter, sans-serif" }));

    // The build output PROVES what the host serves; the network is only ever
    // the fallback for a family named but never shipped.
    expect(embedded.fonts).toEqual([
      { family: "Inter", weight: "100 900", style: "normal", source: "next/font" },
    ]);
    // Greek and cyrillic are separate files the source already split out, so
    // choosing latin costs nothing and drops them.
    expect(embedded.bytes).toBe(LATIN_BYTES.length);
    expect(embedded.css).not.toContain(GREEK_BYTES.toString("base64"));
    expect(embedded.notes).toEqual(["Inter: 1 face(s) from next/font"]);
  });

  it("round-trips the file: the emitted @font-face decodes back to the bytes on disk", async () => {
    const root = await demoBankLike();
    const { css } = await embedHostFonts(root, theme({ fontFamily: "Inter" }));

    const face = /@font-face \{([^}]*)\}/.exec(css);
    expect(face).not.toBeNull();
    expect(face![1]).toContain("font-family: 'Inter';");
    expect(face![1]).toContain("font-weight: 100 900;");
    // The unicode-range rides along, so a browser still scopes the face to the
    // subset the bytes actually cover.
    expect(face![1]).toContain("unicode-range: U+??,");

    const base64 = /url\(data:font\/woff2;base64,([^)]+)\)/.exec(css)?.[1];
    expect(Buffer.from(base64!, "base64")).toEqual(LATIN_BYTES);
  });

  it("reads a face the host ships itself from public/, and reports a family it cannot place", async () => {
    const root = await fixture({
      "src/app/globals.css": "@font-face { font-family: 'Maple Sans'; font-weight: 500; src: url('/fonts/maple.woff2') format('woff2'); }",
      "public/fonts/maple.woff2": Buffer.from("wOF2-maple", "utf8"),
    });
    const embedded = await embedHostFonts(root, theme({
      fontFamily: "Maple Sans, sans-serif",
      headingFamily: "Nothing Ships This, sans-serif",
    }));

    expect(embedded.fonts).toEqual([
      { family: "Maple Sans", weight: "500", style: "normal", source: "public" },
    ]);
    expect(embedded.notes).toContain("Nothing Ships This: no font file found");
  });

  it("asks for nothing when the theme names only generic stacks", async () => {
    const root = await fixture({ "package.json": "{}" });
    expect(await embedHostFonts(root, theme({ fontFamily: "system-ui, sans-serif", headingFamily: "ui-serif" })))
      .toEqual({ css: "", fonts: [], bytes: 0, notes: [] });
  });
});

describe("mono extraction", () => {
  // The shape examples/ai-sdk-agent and examples/mastra-agent both ship. Before
  // this, deriveBodyFontStack found the mono binding, filtered it out of the
  // sans candidates and dropped it — the host's real code font was never learned.
  const GEIST_LAYOUT = `
    import { Geist, Geist_Mono } from "next/font/google";
    const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
    const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
    export default function RootLayout({ children }) {
      return <html lang="en"><body className={\`\${geistSans.variable} \${geistMono.variable}\`}>{children}</body></html>;
    }
  `;
  const GEIST_CSS = `@import "tailwindcss";
    @theme inline {
      --font-sans: var(--font-geist-sans);
      --font-mono: var(--font-geist-mono);
    }`;

  it("keeps the mono family the body derivation filters out", async () => {
    const root = await fixture({ "app/layout.tsx": GEIST_LAYOUT, "app/globals.css": GEIST_CSS });
    const summary = await extractTheme(root);

    expect(summary.slots.fontFamily).toBe("Geist, sans-serif");
    expect(summary.slots.monoFamily).toBe("Geist Mono, monospace");
    expect(summary.matched["monoFamily"]).toBe("--font-mono (next/font vars)");
    // Not a slot: it has no default, so a host without a code font must not
    // report one as defaulted or spend a model call on it.
    expect(summary.defaulted).not.toContain("monoFamily");
    expect(summary.needed).not.toContain("monoFamily");
    expect(toVendoTheme(summary.slots).typography.monoFamily).toBe("Geist Mono, monospace");
  });

  it("leaves monoFamily unset when the host ships no code font", async () => {
    const root = await fixture({
      "app/layout.tsx": `
        import { Inter } from "next/font/google";
        const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
        export default function ({ children }) { return <html className={inter.variable}>{children}</html>; }
      `,
      "app/globals.css": '@import "tailwindcss";\n@theme inline { --font-sans: var(--font-inter); }',
    });
    const summary = await extractTheme(root);

    expect(summary.slots.monoFamily).toBeUndefined();
    expect(toVendoTheme(summary.slots).typography.monoFamily).toBeUndefined();
  });
});
