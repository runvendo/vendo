import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyVendoRootPaste } from "./vendo-root-paste.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRepo(): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "vendo-corpus-paste-"));
  tempRoots.push(repoDir);
  return repoDir;
}

const UNWRAPPED_LAYOUT = [
  'import type { ReactNode } from "react";',
  'import "./globals.css";',
  "",
  "export default function RootLayout({ children }: { children: ReactNode }) {",
  "  return (",
  '    <html lang="en">',
  "      <body>{children}</body>",
  "    </html>",
  "  );",
  "}",
  "",
].join("\n");

const WRAPPED_LAYOUT = UNWRAPPED_LAYOUT.replace(
  "{children}",
  "<VendoRoot>{children}</VendoRoot>",
);

// The exact shape `vendo init` prints today (init.ts's vendoRootPasteLines +
// the "Last steps are yours:" preamble output.log wraps it in) — the harness
// paste helper reads THIS, it does not regenerate its own copy of it.
const INIT_STDOUT = [
  "some other init noise",
  "",
  "Last steps are yours:",
  "  In app/layout.tsx:",
  '    import { VendoRoot } from "@vendoai/vendo/react";',
  '    import theme from "../vendo/theme";',
  '    import type { VendoTheme } from "@vendoai/vendo";',
  "    … then wrap: <VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>",
  "",
  "Then start your dev server — the agent is live in your app.",
].join("\n");

describe("applyVendoRootPaste", () => {
  it("pastes the printed import + wrap into an unwrapped app router layout", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), UNWRAPPED_LAYOUT);

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toContain('import { VendoRoot } from "@vendoai/vendo/react";');
    expect(layout).toContain('import theme from "../vendo/theme";');
    expect(layout).toContain('import type { VendoTheme } from "@vendoai/vendo";');
    expect(layout).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
  });

  it("fails when vendo init's stdout did not print the paste instructions", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), UNWRAPPED_LAYOUT);

    await expect(applyVendoRootPaste(repoDir, "next", "vendo init finished with no summary"))
      .rejects.toThrow(/Last steps are yours/);

    // Untouched — the failed assertion must not half-apply the paste.
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toBe(UNWRAPPED_LAYOUT);
  });

  it("leaves an already-wrapped layout unchanged (idempotent)", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), WRAPPED_LAYOUT);

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: false, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toBe(WRAPPED_LAYOUT);
  });

  it("skips express hosts — init prints server/client wiring, not a layout paste", async () => {
    const repoDir = await makeTempRepo();
    const result = await applyVendoRootPaste(repoDir, "express", "anything");
    expect(result).toMatchObject({ applied: false, file: null });
  });

  it("skips silently when no App Router layout exists", async () => {
    const repoDir = await makeTempRepo();
    const result = await applyVendoRootPaste(repoDir, "next", "anything");
    expect(result).toMatchObject({ applied: false, file: null });
  });
});
