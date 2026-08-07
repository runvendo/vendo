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

// Spaceless destructure: `{children}` appears in the function signature
// BEFORE it appears in the JSX body. A naive first-occurrence replace
// mangles the signature instead of wrapping the JSX (corpus-triage review
// finding #2).
const UNWRAPPED_LAYOUT_SPACELESS_DESTRUCTURE = [
  'import type { ReactNode } from "react";',
  'import "./globals.css";',
  "",
  "function RootLayout({children}: { children: ReactNode }) {",
  "  return (",
  '    <html lang="en">',
  "      <body>{children}</body>",
  "    </html>",
  "  );",
  "}",
  "",
  "export default RootLayout;",
  "",
].join("\n");

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

  it("wraps the JSX {children}, not a spaceless {children} destructure in the function signature", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), UNWRAPPED_LAYOUT_SPACELESS_DESTRUCTURE);

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    // Signature destructure left untouched.
    expect(layout).toContain("function RootLayout({children}: { children: ReactNode }) {");
    // JSX usage wrapped instead.
    expect(layout).toContain(
      "<body><VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot></body>",
    );
  });

  it("keeps a leading 'use client' directive first — pasted imports go after it", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), `"use client";\n\n${UNWRAPPED_LAYOUT}`);

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    // The directive must stay the first statement of the module — imports
    // pasted ahead of it would silently demote the layout to a server
    // component and break its hooks/browser APIs.
    expect(layout.split(/\r?\n/)[0]).toBe('"use client";');
    expect(layout.indexOf('"use client";')).toBeLessThan(layout.indexOf('import { VendoRoot }'));
    expect(layout).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
  });

  it("keeps a comment-prefixed 'use client' directive ahead of the pasted imports", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    const original = [
      "/* Copyright (c) Fixture Corp.",
      " * SPDX-License-Identifier: MIT */",
      "// keep this layout client-side",
      '"use client";',
      "",
      UNWRAPPED_LAYOUT,
    ].join("\n");
    await writeFile(path.join(repoDir, "app/layout.tsx"), original);

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout.startsWith("/* Copyright (c) Fixture Corp.")).toBe(true);
    expect(layout.indexOf('"use client";')).toBeLessThan(layout.indexOf('import { VendoRoot }'));
  });

  it("recognizes a 'use client' directive carrying a trailing comment", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(
      path.join(repoDir, "app/layout.tsx"),
      `"use client"; // needed for the theme hooks\n\n${UNWRAPPED_LAYOUT}`,
    );

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout.split(/\r?\n/)[0]).toBe('"use client"; // needed for the theme hooks');
    expect(layout.indexOf('"use client";')).toBeLessThan(layout.indexOf('import { VendoRoot }'));
  });

  it("preserves CRLF line endings when inserting imports", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), UNWRAPPED_LAYOUT.replaceAll("\n", "\r\n"));

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toContain('import { VendoRoot } from "@vendoai/vendo/react";');
    // Every newline is still CRLF — no mixed endings after the paste.
    expect(layout.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("fails when the layout has no children expression to wrap", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(
      path.join(repoDir, "app/layout.tsx"),
      "export default function RootLayout() {\n  return <html><body /></html>;\n}\n",
    );

    await expect(applyVendoRootPaste(repoDir, "next", INIT_STDOUT))
      .rejects.toThrow(/no "\{children\}" expression/);
  });

  it("wraps a whitespace-formatted { children } JSX expression", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(
      path.join(repoDir, "app/layout.tsx"),
      UNWRAPPED_LAYOUT.replace("<body>{children}</body>", "<body>{ children }</body>"),
    );

    const result = await applyVendoRootPaste(repoDir, "next", INIT_STDOUT);

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toContain(
      "<body><VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot></body>",
    );
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
