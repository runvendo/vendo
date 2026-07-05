import { describe, expect, it } from "vitest";
import { NORMALIZER_VERSION, normalizeBaseline, numberedLines } from "./baseline";

describe("normalizeBaseline", () => {
  it("normalizes CRLF/CR to LF before anything else", () => {
    const { text } = normalizeBaseline("a\r\nb\rc\n", undefined);
    expect(text).toBe("a\nb\nc\n");
  });

  it("rewrites `export function X` to a default export when exportName matches", () => {
    const { text } = normalizeBaseline(
      "export function DeadlineList() { return null }",
      "DeadlineList",
    );
    expect(text).toBe("export default function DeadlineList() { return null }");
  });

  it("rewrites `export async function X`", () => {
    const { text } = normalizeBaseline(
      "export async function Loader() { return null }",
      "Loader",
    );
    expect(text).toBe("export default async function Loader() { return null }");
  });

  it("rewrites `export const X = ...` by appending a default export line", () => {
    const { text } = normalizeBaseline(
      "export const Card = () => null;\n",
      "Card",
    );
    expect(text).toBe("export const Card = () => null;\nexport default Card;\n");
  });

  it("rewrites a bare `export { X }` list by appending a default export line", () => {
    const { text } = normalizeBaseline(
      "function Card() { return null }\nexport { Card };\n",
      "Card",
    );
    expect(text).toBe(
      "function Card() { return null }\nexport { Card };\nexport default Card;\n",
    );
  });

  it("is a no-op when a default export already exists", () => {
    const src = "export default function DeadlineList() { return null }";
    expect(normalizeBaseline(src, "DeadlineList").text).toBe(src);
  });

  it("is a no-op when exportName is absent", () => {
    const src = "export function Mystery() { return null }";
    expect(normalizeBaseline(src, undefined).text).toBe(src);
  });

  it("hashes the normalized text stably and stamps the normalizer version", () => {
    const a = normalizeBaseline("export function X() {}\r\n", "X");
    const b = normalizeBaseline("export function X() {}\n", "X");
    expect(a.baseHash).toBe(b.baseHash);
    expect(a.baseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.normalizerVersion).toBe(NORMALIZER_VERSION);
    expect(NORMALIZER_VERSION).toMatch(/^\d+$/);
  });
});

describe("numberedLines", () => {
  it("renders 1-based numbered lines without altering the text", () => {
    const { text } = normalizeBaseline("const a = 1;\nconst b = 2;", undefined);
    expect(numberedLines(text)).toBe("  1| const a = 1;\n  2| const b = 2;");
  });

  it("pads line numbers so columns align past 3 digits", () => {
    const text = Array.from({ length: 101 }, (_, i) => `l${i + 1}`).join("\n");
    const rendered = numberedLines(text).split("\n");
    expect(rendered[0]).toBe("  1| l1");
    expect(rendered[100]).toBe("101| l101");
  });
});
