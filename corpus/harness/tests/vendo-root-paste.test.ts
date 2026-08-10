import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { applyVendoRootPaste } from "../src/vendo-root-paste.js";

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
  "<VendoProvider>{children}</VendoProvider>",
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

// invoify's app/layout.tsx, verbatim at the manifest's pinned sha
// (93b21a22e902de0ce25c43933d5ef2d50f30c7e3): a pass-through root layout with
// NO JSX, so its destructured parameter is the file's ONLY `{children}`.
// A last-occurrence text scan pasted the mount into the parameter list and made
// the file unparseable ("Expected yield, an identifier, [ or {").
const INVOIFY_PASSTHROUGH_LAYOUT = [
  'import { ReactNode } from "react";',
  'import "@/app/globals.css";',
  "",
  "type Props = {",
  "    children: ReactNode;",
  "};",
  "",
  "// Since we have a `not-found.tsx` page on the root, a layout file",
  "// is required, even if it's just passing children through.",
  "export default function RootLayout({ children }: Props) {",
  "    return children;",
  "}",
  "",
].join("\n");

// The canonical mount from docs-site/quickstart.mdx ("The client mount") — the
// harness constructs this itself, independent of what init printed.
const WRAP = '<VendoProvider baseUrl="/api/vendo">{children}</VendoProvider>';

describe("applyVendoRootPaste", () => {
  it("pastes the canonical import + wrap into an unwrapped app router layout", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), UNWRAPPED_LAYOUT);

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toContain('import { VendoProvider } from "@vendoai/vendo/react";');
    expect(layout).toContain(WRAP);
  });

  it("wraps the JSX {children}, not a spaceless {children} destructure in the function signature", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), UNWRAPPED_LAYOUT_SPACELESS_DESTRUCTURE);

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    // Signature destructure left untouched.
    expect(layout).toContain("function RootLayout({children}: { children: ReactNode }) {");
    // JSX usage wrapped instead.
    expect(layout).toContain(`<body>${WRAP}</body>`);
  });

  it("wraps the returned children of a pass-through layout that renders no JSX (invoify)", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), INVOIFY_PASSTHROUGH_LAYOUT);

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    // The parameter destructure — the file's only literal `{children}` — is
    // left alone; the RETURNED children is what the mount wraps.
    expect(layout).toContain("export default function RootLayout({ children }: Props) {");
    expect(layout).toContain(`return ${WRAP};`);
    // And the result still parses: pasting JSX into the parameter list failed
    // host.typecheck and host.build with a parse error, not just files.expected.
    expect(ts.transpileModule(layout, {
      reportDiagnostics: true,
      fileName: "layout.tsx",
      compilerOptions: { jsx: ts.JsxEmit.Preserve },
    }).diagnostics ?? []).toEqual([]);
  });

  it("keeps a leading 'use client' directive first — pasted imports go after it", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), `"use client";\n\n${UNWRAPPED_LAYOUT}`);

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    // The directive must stay the first statement of the module — imports
    // pasted ahead of it would silently demote the layout to a server
    // component and break its hooks/browser APIs.
    expect(layout.split(/\r?\n/)[0]).toBe('"use client";');
    expect(layout.indexOf('"use client";')).toBeLessThan(layout.indexOf('import { VendoProvider }'));
    expect(layout).toContain(WRAP);
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

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout.startsWith("/* Copyright (c) Fixture Corp.")).toBe(true);
    expect(layout.indexOf('"use client";')).toBeLessThan(layout.indexOf('import { VendoProvider }'));
  });

  it("recognizes a 'use client' directive carrying a trailing comment", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(
      path.join(repoDir, "app/layout.tsx"),
      `"use client"; // needed for the theme hooks\n\n${UNWRAPPED_LAYOUT}`,
    );

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout.split(/\r?\n/)[0]).toBe('"use client"; // needed for the theme hooks');
    expect(layout.indexOf('"use client";')).toBeLessThan(layout.indexOf('import { VendoProvider }'));
  });

  it("preserves CRLF line endings when inserting imports", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), UNWRAPPED_LAYOUT.replaceAll("\n", "\r\n"));

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toContain('import { VendoProvider } from "@vendoai/vendo/react";');
    // Every newline is still CRLF — no mixed endings after the paste.
    expect(layout.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("fails when the layout has no children expression to wrap", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    const original = "export default function RootLayout() {\n  return <html><body /></html>;\n}\n";
    await writeFile(path.join(repoDir, "app/layout.tsx"), original);

    await expect(applyVendoRootPaste(repoDir, "next"))
      .rejects.toThrow(/no "\{children\}" expression/);

    // Untouched — a failed wrap must not leave a half-applied import behind.
    await expect(readFile(path.join(repoDir, "app/layout.tsx"), "utf8")).resolves.toBe(original);
  });

  it("wraps a whitespace-formatted { children } JSX expression", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(
      path.join(repoDir, "app/layout.tsx"),
      UNWRAPPED_LAYOUT.replace("<body>{children}</body>", "<body>{ children }</body>"),
    );

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: true, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toContain(`<body>${WRAP}</body>`);
  });

  it("leaves an already-wrapped layout unchanged (idempotent)", async () => {
    const repoDir = await makeTempRepo();
    await mkdir(path.join(repoDir, "app"), { recursive: true });
    await writeFile(path.join(repoDir, "app/layout.tsx"), WRAPPED_LAYOUT);

    const result = await applyVendoRootPaste(repoDir, "next");

    expect(result).toMatchObject({ applied: false, file: "app/layout.tsx" });
    const layout = await readFile(path.join(repoDir, "app/layout.tsx"), "utf8");
    expect(layout).toBe(WRAPPED_LAYOUT);
  });

  it("skips express hosts — init prints server/client wiring, not a layout paste", async () => {
    const repoDir = await makeTempRepo();
    const result = await applyVendoRootPaste(repoDir, "express");
    expect(result).toMatchObject({ applied: false, file: null });
  });

  it("skips silently when no App Router layout exists", async () => {
    const repoDir = await makeTempRepo();
    const result = await applyVendoRootPaste(repoDir, "next");
    expect(result).toMatchObject({ applied: false, file: null });
  });
});
