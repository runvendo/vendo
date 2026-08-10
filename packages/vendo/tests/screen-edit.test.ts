import { describe, expect, it } from "vitest";
import { applyEditBlocks, type EditOutcome } from "../src/screen-edit.js";

const DOC = `<App name="Spend">
  <Stat label="Total" value={sum(tx, "amount_cents")} />
  <DataTable rows={tx.data} />
</App>`;

const applied = (out: EditOutcome): string => {
  if (!out.ok) throw new Error(`expected the blocks to apply, got: ${out.note}`);
  return out.document;
};

const failed = (out: EditOutcome): string => {
  if (out.ok) throw new Error("expected the blocks to fail, and they applied");
  return out.note;
};

describe("applyEditBlocks — the two passes", () => {
  it("pass 1: an exact block that appears once is replaced", () => {
    const document = applied(applyEditBlocks(DOC, [
      { search: "  <DataTable rows={tx.data} />", replace: "  <DataTable rows={tx.data} dense />" },
    ]));
    expect(document).toBe(DOC.replace("rows={tx.data} />", "rows={tx.data} dense />"));
  });

  it("pass 2: trailing whitespace is forgiven on both sides", () => {
    const document = applied(applyEditBlocks(DOC, [
      { search: "  <DataTable rows={tx.data} />   \n", replace: "  <BarChart rows={tx.data} />\n" },
    ]));
    expect(document).toBe(DOC.replace("  <DataTable rows={tx.data} />", "  <BarChart rows={tx.data} />"));
  });

  it("applies several blocks in order", () => {
    const document = applied(applyEditBlocks(DOC, [
      { search: 'name="Spend"', replace: 'name="Spending"' },
      { search: "amount_cents", replace: "total_cents" },
    ]));
    expect(document).toContain('<App name="Spending">');
    expect(document).toContain('sum(tx, "total_cents")');
  });
});

describe("applyEditBlocks — the failures that teach", () => {
  it("a block that matches nothing echoes itself, the closest lines and the rule", () => {
    const note = failed(applyEditBlocks(DOC, [
      { search: "  <DataTable rows={transactions.rows} />", replace: "x" },
    ]));
    expect(note).toContain("<DataTable rows={transactions.rows} />");
    expect(note).toContain("The closest lines in the document are:");
    expect(note).toContain("<DataTable rows={tx.data} />");
    expect(note).toContain("SEARCH must reproduce existing lines of the document exactly");
  });

  it("a block that matches more than once says how many times", () => {
    expect(failed(applyEditBlocks("a\nb\na\n", [{ search: "a", replace: "c" }]))).toContain("appears 2 times");
  });

  it("one failed block applies NONE of them — there is no half-edited document", () => {
    const out = applyEditBlocks(DOC, [
      { search: 'name="Spend"', replace: 'name="Spending"' },
      { search: "nothing like this", replace: "x" },
    ]);
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty("document");
  });

  it("no blocks at all is a failure rather than a save of the same bytes", () => {
    expect(applyEditBlocks(DOC, [])).toMatchObject({ ok: false });
  });
});
