import { describe, expect, it } from "vitest";
import { capToolOutput } from "./cap-tool-output";

const HTML_BODY = `<html><head><style>.x{color:red}</style></head><body><div><p>Order confirmed: <b>Blue Bottle</b></p><table><tr><td>Latte</td><td>$6.50</td></tr></table>${"<span>pad</span>".repeat(500)}</body></html>`;
const BASE64 = "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUg".repeat(200);

describe("capToolOutput", () => {
  it("passes small results through byte-identical and untruncated", () => {
    const input = { ok: true, data: { items: [{ a: 1 }, { a: 2 }] } };
    const out = capToolOutput(input, { maxChars: 10_000 });
    expect(out.truncated).toBe(false);
    expect(JSON.stringify(out.result)).toBe(JSON.stringify(input));
  });

  it("extracts text from HTML bodies instead of keeping markup", () => {
    const out = capToolOutput({ body: HTML_BODY }, { maxChars: 2_000 });
    const body = (out.result as { body: string }).body;
    expect(body).toContain("Order confirmed");
    expect(body).toContain("Blue Bottle");
    expect(body).not.toContain("<div>");
    expect(body).not.toContain("<style>");
    expect(out.truncated).toBe(true);
  });

  it("drops base64 blobs", () => {
    const out = capToolOutput({ img: BASE64, keep: "hello" }, { maxChars: 2_000 });
    const r = out.result as { img: string; keep: string };
    expect(r.img.length).toBeLessThan(100);
    expect(r.img).toMatch(/omitted/);
    expect(r.keep).toBe("hello");
  });

  it("caps long arrays WITHOUT fabricating marker rows (shape stability)", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, amount: i * 100 }));
    const out = capToolOutput({ data: { rows } }, { maxChars: 4_000, maxArrayItems: 20 });
    const capped = (out.result as { data: { rows: Array<{ id: number }> } }).data.rows;
    expect(capped.length).toBeLessThanOrEqual(20);
    // Every element keeps the original record shape — no marker strings/rows.
    for (const row of capped) {
      expect(typeof row).toBe("object");
      expect(typeof row.id).toBe("number");
    }
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/rows/);
  });

  it("truncates long plain strings with an in-string marker only", () => {
    const out = capToolOutput({ text: "x".repeat(50_000) }, { maxChars: 2_000 });
    const text = (out.result as { text: string }).text;
    expect(text.length).toBeLessThan(5_000);
    expect(text).toMatch(/truncated/);
  });

  it("attaches the note at the ROOT of object results only", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const out = capToolOutput({ data: { rows } }, { maxChars: 1_000, attachNote: true });
    const r = out.result as Record<string, unknown>;
    expect(typeof r._truncation).toBe("string");
    // never nested
    expect(JSON.stringify((r as { data: unknown }).data)).not.toContain("_truncation");
  });

  it("is deterministic", () => {
    const input = { body: HTML_BODY, rows: Array.from({ length: 100 }, (_, i) => ({ i })) };
    const a = capToolOutput(input, { maxChars: 1_500 });
    const b = capToolOutput(input, { maxChars: 1_500 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
