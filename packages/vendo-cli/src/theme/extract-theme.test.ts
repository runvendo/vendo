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
    expect(written.background).toBe("#FBFBFA");
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
    expect(written.background).toBe("#FBFBFA");
    expect(written.surface).toBe("#FFFFFF");
    expect(written.text).toBe("#111111");
    expect(written.mutedText).toBe("#908C85");
    expect(written.radius).toBe("14px");
    expect(written.fontFamily).toContain("Inter");
    // No accent-ish token in Maple — stays defaulted and flagged.
    expect(summary.defaulted).toEqual(["accent"]);
    expect(summary.written).toBe(true);
  });
});
