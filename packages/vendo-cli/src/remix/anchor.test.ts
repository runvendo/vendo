import ts from "typescript";
import { describe, expect, it } from "vitest";
import { hasSyntaxErrors, remixContextTodo, spliceRemixAnchor } from "./anchor.js";

/** Parse-clean assertion for a produced .tsx string. */
function reparses(code: string): boolean {
  return !hasSyntaxErrors(code, ts.ScriptKind.TSX);
}

describe("spliceRemixAnchor", () => {
  it("wraps a simple function component's returned element and inserts the import", () => {
    const src = `export function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code.startsWith('import { VendoRemix } from "@vendoai/shell";\n')).toBe(true);
    expect(r.code).toContain('<VendoRemix id="widget" label="Widget">');
    expect(r.code).toContain("<List />");
    expect(r.code).toContain("</VendoRemix>");
    expect(reparses(r.code)).toBe(true);
  });

  it("wraps an arrow component with a concise JSX body", () => {
    const src = `export const Widget = () => <List />;\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toContain('<VendoRemix id="widget" label="Widget">');
    expect(reparses(r.code)).toBe(true);
  });

  it("wraps an arrow concise body wrapped in parentheses", () => {
    const src = `export const Widget = () => (<List />);\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toContain('<VendoRemix id="widget" label="Widget">');
    expect(r.code).toContain("<List />");
    expect(reparses(r.code)).toBe(true);
  });

  it("wraps a parenthesized multi-line return element", () => {
    const src = `export function Widget() {\n  return (\n    <Card>\n      <Row />\n    </Card>\n  );\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "card", label: "Card" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toContain('<VendoRemix id="card" label="Card">');
    expect(r.code).toContain("<Row />");
    expect(reparses(r.code)).toBe(true);
  });

  it("wraps the single JSX return past an early `return null` guard", () => {
    const src = `export function Widget({ data }: { data?: number[] }) {\n  if (!data) return null;\n  return <List items={data} />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toContain('<VendoRemix id="widget" label="Widget">');
    expect(r.code).toContain("<List items={data} />");
    expect(reparses(r.code)).toBe(true);
  });

  it("handles a default-export function component", () => {
    const src = `export default function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toContain('<VendoRemix id="widget" label="Widget">');
    expect(reparses(r.code)).toBe(true);
  });

  it("skips when the component is not found", () => {
    const src = `export function Other() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not found|no.*component/i);
    expect(r.manual).toContain("VendoRemix");
  });

  it("skips on multiple JSX returns (ambiguous)", () => {
    const src = `export function Widget({ big }: { big: boolean }) {\n  if (big) {\n    return <BigList />;\n  }\n  return <SmallList />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/multiple returns/i);
  });

  it("skips a fragment root", () => {
    const src = `export function Widget() {\n  return <>\n    <A />\n    <B />\n  </>;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/fragment/i);
  });

  it("skips a conditional (ternary) root", () => {
    const src = `export function Widget({ ok }: { ok: boolean }) {\n  return ok ? <A /> : <B />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/single JSX element/i);
  });

  it("skips a mapped-list root", () => {
    const src = `export function Widget({ items }: { items: string[] }) {\n  return items.map((x) => <li key={x}>{x}</li>);\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/single JSX element/i);
  });

  it("skips a component with no JSX return", () => {
    const src = `export function Widget() {\n  return doSomething();\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no JSX return/i);
  });

  it("is idempotent: skips a file that already contains a VendoRemix anchor", () => {
    const src = `import { VendoRemix } from "@vendoai/shell";\nexport function Widget() {\n  return (\n    <VendoRemix id="widget" label="Widget">\n      <List />\n    </VendoRemix>\n  );\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already/i);
  });

  it("does NOT treat a VendoRemix mention in a comment/string as an existing anchor", () => {
    const src = `// TODO wrap in <VendoRemix> later\nexport function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
  });

  it("does not duplicate an already-present VendoRemix import", () => {
    const src = `import { VendoRemix } from "@vendoai/shell";\nexport function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const occurrences = r.code.split('import { VendoRemix } from "@vendoai/shell";').length - 1;
    expect(occurrences).toBe(1);
    expect(reparses(r.code)).toBe(true);
  });

  it('inserts the import AFTER a leading "use client" directive', () => {
    const src = `"use client";\nimport Link from "next/link";\nexport function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: "Widget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code.startsWith('"use client";\n')).toBe(true);
    const directiveEnd = r.code.indexOf('"use client";\n') + '"use client";\n'.length;
    const importPos = r.code.indexOf('import { VendoRemix } from "@vendoai/shell";');
    expect(importPos).toBe(directiveEnd);
    expect(reparses(r.code)).toBe(true);
  });

  it("rejects a label containing a double-quote (would break out of the attribute)", () => {
    const src = `export function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "widget", label: 'Say "hi"' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/label/i);
  });

  it("rejects an id with unexpected characters (defensive, even though Task 10 sanitizes)", () => {
    const src = `export function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, { componentName: "Widget", id: "Bad Id!", label: "Widget" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/id/i);
  });

  it("respects the script kind when derived from a .jsx file name", () => {
    const src = `export function Widget() {\n  return <List />;\n}\n`;
    const r = spliceRemixAnchor(src, {
      componentName: "Widget",
      id: "widget",
      label: "Widget",
      fileName: "src/Widget.jsx",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toContain('<VendoRemix id="widget" label="Widget">');
  });
});

describe("hasSyntaxErrors", () => {
  it("returns false for valid TSX and true for malformed output", () => {
    expect(hasSyntaxErrors(`const x = <div />;\n`, ts.ScriptKind.TSX)).toBe(false);
    // Unbalanced JSX — exactly what the splice gate must catch before writing.
    expect(hasSyntaxErrors(`const x = <VendoRemix><div /></VendoRemix\n`, ts.ScriptKind.TSX)).toBe(true);
    expect(hasSyntaxErrors(`function ( {\n`, ts.ScriptKind.TSX)).toBe(true);
  });
});

describe("remixContextTodo", () => {
  it("names the anchor id and points at the remix docs", () => {
    const todo = remixContextTodo("upcoming-deadlines");
    expect(todo).toContain("upcoming-deadlines");
    expect(todo).toMatch(/context/i);
  });
});
