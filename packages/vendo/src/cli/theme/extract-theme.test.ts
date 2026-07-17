import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractTheme } from "./extract-theme.js";

const cleanup: string[] = [];
const appsDir = fileURLToPath(new URL("../../../../../apps/", import.meta.url));

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("extractTheme host evidence", () => {
  it("recovers Maple-style next/font, monochrome accent, generic radius, density, and motion", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-theme-maple-"));
    cleanup.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "app", "layout.tsx"), `
      import { Inter } from "next/font/google";
      import "./globals.css";
      const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
      export default function Layout({ children }) {
        return <html className={inter.variable}><body className="bg-bg text-ink">{children}</body></html>;
      }
    `);
    await writeFile(join(root, "app", "globals.css"), `
      :root {
        --color-bg: #fbfbfa;
        --color-surface: #ffffff;
        --color-ink: #111111;
        --color-muted: #908c85;
        --color-border: #ecebe8;
        --color-neg: #b0473a;
        --radius-card: 14px;
        --font-sans: var(--font-inter);
      }
    `);
    await writeFile(join(root, "app", "page.tsx"), `
      export default function Page() { return <>
        <button className="bg-ink text-white rounded-lg h-8 text-[13px] transition-colors" />
        <button className="bg-ink text-white rounded-lg h-8 text-[13px] transition-colors" />
        <button className="bg-ink text-white rounded-lg h-8 text-[13px] transition-colors" />
        <button className="bg-ink text-white rounded-lg h-8 text-[13px] transition-colors" />
        <button className="bg-ink text-white rounded-lg h-8 text-[13px] transition-colors" />
        <button className="bg-ink text-white rounded-lg h-8 text-[13px] transition-colors" />
      </>; }
    `);

    const result = await extractTheme(root);
    expect(result.slots).toMatchObject({
      accent: "#111111",
      border: "#ecebe8",
      danger: "#b0473a",
      accentText: "#ffffff",
      radius: "8px",
      fontFamily: "Inter, sans-serif",
      headingFamily: "Inter, sans-serif",
      density: "compact",
      motion: "full",
    });
  });

  it("fails closed when source utility evidence is tied or too weak", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-theme-ambiguous-"));
    cleanup.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "app", "layout.tsx"), `
      import "./globals.css";
      export default function Layout({ children }) {
        return <html><body>{children}</body></html>;
      }
    `);
    await writeFile(join(root, "app", "globals.css"), `
      :root { --color-cedar: #266755; --color-ocean: #1d4ed8; }
    `);
    await writeFile(join(root, "app", "page.tsx"), `
      export default function Page() { return <>
        ${Array.from({ length: 6 }, () => '<button className="bg-cedar rounded-md h-8 text-sm" />').join("\n")}
        ${Array.from({ length: 6 }, () => '<button className="bg-ocean rounded-lg h-10 text-base" />').join("\n")}
      </>; }
    `);

    const result = await extractTheme(root);
    expect(result.defaulted).toEqual(expect.arrayContaining(["accent", "radius", "density", "motion"]));
    expect(result.slots).toMatchObject({
      accent: "#2563eb",
      radius: "8px",
      density: "comfortable",
      motion: "full",
    });
  });

  it("infers reduced motion from a disabling prefers-reduced-motion rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-theme-reduced-motion-"));
    cleanup.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "app", "layout.tsx"), `
      import "./globals.css";
      export default function Layout({ children }) { return <html><body>{children}</body></html>; }
    `);
    await writeFile(join(root, "app", "globals.css"), `
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.01ms !important; transition: none; }
      }
    `);

    const result = await extractTheme(root);
    expect(result.slots.motion).toBe("reduced");
    expect(result.matched.motion).toContain("prefers-reduced-motion");
    expect(result.defaulted).not.toContain("motion");
  });

  it.each([
    ["Maple", "demo-bank", {
      accent: "#111111",
      accentText: "#ffffff",
      background: "#fbfbfa",
      border: "#ecebe8",
      danger: "#b0473a",
      surface: "#ffffff",
      text: "#111111",
      mutedText: "#908c85",
      radius: "8px",
      fontFamily: "Inter, sans-serif",
      headingFamily: "Inter, sans-serif",
      baseSize: "16px",
      density: "compact",
      motion: "reduced",
    }],
    // Porcelain Ledger (2026-07-16 redesign): ink-first neutrals, green
    // demoted to data-only, Inter. Measured off the live host.
    ["Cadence", "demo-accounting", {
      accent: "#196b46",
      accentText: "#ffffff",
      background: "#fbfbfa",
      border: "#ecebe8",
      danger: "#b0473a",
      surface: "#ffffff",
      text: "#111111",
      mutedText: "#46443f",
      radius: "8px",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      headingFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      baseSize: "16px",
      density: "compact",
      motion: "full",
    }],
  ] as const)("matches measured %s host slots", async (_name, app, expected) => {
    const result = await extractTheme(join(appsDir, app));
    expect(result.slots).toEqual(expected);
  });
});
