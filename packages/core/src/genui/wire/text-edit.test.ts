import { describe, expect, it } from "vitest";
import { compileWire } from "./compile.js";
import { printWire } from "./print.js";
import { applyTextEdits, recompileWithIdentity } from "./text-edit.js";
import { validateTree } from "../tree.js";
import type { Tree } from "../tree.js";

/** The brain edits the app the way it edits a file: the id-free print in,
 *  old/new pairs out. These tests pin the two halves of that surface — the
 *  replace itself, and the identity the recompile carries across it. */

const BASE_WIRE = `<App name="Ledger">
  <Stack>
    <Text text="Ledger" variant="heading"/>
    <Card title="one"/>
    <Card title="two"/>
  </Stack>
</App>`;

const base = () => compileWire(BASE_WIRE);

/** The model-facing form: no ids, so the model can only anchor on real text. */
const printed = () => printWire(base(), { includeIds: false });

const edit = (...edits: Array<{ old: string; new: string }>): string => {
  const result = applyTextEdits(printed(), edits);
  expect(result.issue).toBeUndefined();
  return result.text as string;
};

const idOf = (tree: Tree, title: string): string | undefined =>
  tree.nodes.find((node) => node.props?.title === title)?.id;

describe("applyTextEdits", () => {
  it("replaces the single exact match and leaves the rest byte-identical", () => {
    const result = applyTextEdits('<App><Card title="one"/></App>', [{ old: 'title="one"', new: 'title="two"' }]);
    expect(result).toEqual({ text: '<App><Card title="two"/></App>' });
  });

  it("reports no match, quoting the old string the model asked for", () => {
    const result = applyTextEdits("<App><Card/></App>", [{ old: '<Table rows={x}/>', new: "<Card/>" }]);
    expect(result.text).toBeUndefined();
    expect(result.issue).toContain('<Table rows={x}/>');
    expect(result.issue).toContain("no match");
  });

  it("reports an ambiguous old string instead of guessing which match to take", () => {
    const result = applyTextEdits("<App><Card/><Card/></App>", [{ old: "<Card/>", new: "<Text/>" }]);
    expect(result.text).toBeUndefined();
    expect(result.issue).toContain("2 matches");
    expect(result.issue).toContain("ambiguous");
    expect(result.issue).toContain("more");
  });

  it("applies edits in order, so a later edit sees the earlier result", () => {
    const result = applyTextEdits("<App><Card title=\"a\"/></App>", [
      { old: 'title="a"', new: 'title="b"' },
      { old: 'title="b"', new: 'title="c" dense' },
    ]);
    expect(result).toEqual({ text: '<App><Card title="c" dense/></App>' });
  });

  it("names the failing edit when a batch fails part way through", () => {
    const result = applyTextEdits('<App><Card title="a"/></App>', [
      { old: 'title="a"', new: 'title="b"' },
      { old: 'title="a"', new: 'title="c"' },
    ]);
    expect(result.text).toBeUndefined();
    expect(result.issue).toContain("edit 2 of 2");
  });

  it("refuses an empty old string rather than inserting at a guessed spot", () => {
    const result = applyTextEdits("<App/>", [{ old: "", new: "<Card/>" }]);
    expect(result.text).toBeUndefined();
    expect(result.issue).toContain("empty");
  });

  it("returns the source untouched for an empty edit list", () => {
    expect(applyTextEdits("<App/>", [])).toEqual({ text: "<App/>" });
  });
});

describe("recompileWithIdentity", () => {
  it("carries the previous ids of every node outside the edited span", () => {
    const previous = base();
    expect(idOf(previous.tree, "one")).toBe("card-1");
    expect(idOf(previous.tree, "two")).toBe("card-2");

    const edited = edit({ old: '<Card title="one"/>', new: '<Card title="new"/>\n    <Card title="one"/>' });

    // The control: a plain recompile re-mints by document order, so the
    // untouched cards SHIFT. This is what identity carry has to beat.
    const naive = compileWire(edited);
    expect(idOf(naive.tree, "one")).toBe("card-2");
    expect(idOf(naive.tree, "two")).toBe("card-3");

    const next = recompileWithIdentity(edited, previous.tree);
    expect(next.issues).toEqual([]);
    expect(idOf(next.tree, "one")).toBe("card-1");
    expect(idOf(next.tree, "two")).toBe("card-2");
    // The inserted element is inside the span: fresh id, no collision.
    expect(idOf(next.tree, "new")).toBe("card-3");
    // Untouched container and text node keep theirs too.
    expect(next.tree.nodes.find((node) => node.component === "Stack" && node.id !== "root")?.id).toBe("stack-1");
    expect(next.tree.nodes.find((node) => node.props?.text === "Ledger")?.id).toBe("text-1");
    expect(validateTree(next.tree).ok).toBe(true);
  });

  it("keeps a node's id when the edit only changed a prop inside its own tag", () => {
    const previous = base();
    const edited = edit({ old: 'title="one"', new: 'title="renamed"' });
    const next = recompileWithIdentity(edited, previous.tree);
    expect(idOf(next.tree, "renamed")).toBe("card-1");
    expect(idOf(next.tree, "two")).toBe("card-2");
  });

  it("keeps ids unique when an insert and a prop edit land in one region", () => {
    const previous = base();
    const edited = edit(
      { old: '<Card title="one"/>', new: '<Card title="renamed"/>' },
      {
        old: '<Text text="Ledger" variant="heading"/>',
        new: '<Text text="Ledger" variant="heading"/>\n    <Card title="new"/>',
      },
    );
    const next = recompileWithIdentity(edited, previous.tree);
    // The untouched sibling still anchors the suffix.
    expect(idOf(next.tree, "two")).toBe("card-2");
    // Two same-component siblings changed inside one region are not
    // distinguishable from the text: card-1 lands on one of them, and no id is
    // ever duplicated or re-used.
    expect(next.tree.nodes.filter((node) => node.component === "Card").map((node) => node.id))
      .toEqual(["card-1", "card-3", "card-2"]);
    expect(validateTree(next.tree).ok).toBe(true);
  });

  it("mints a fresh id for an element rewritten inside the span", () => {
    const previous = base();
    const edited = edit({ old: '<Card title="one"/>', new: "<DataTable dense/>" });
    const next = recompileWithIdentity(edited, previous.tree);
    // card-1's element is gone, so its id goes with it — no inheritance across
    // a different component.
    expect(next.tree.nodes.some((node) => node.id === "card-1")).toBe(false);
    expect(next.tree.nodes.find((node) => node.component === "DataTable")?.id).toBe("datatable-1");
    // The sibling outside the span is untouched.
    expect(idOf(next.tree, "two")).toBe("card-2");
    expect(validateTree(next.tree).ok).toBe(true);
  });

  it("is a plain recompile when the text did not change", () => {
    const previous = base();
    const next = recompileWithIdentity(printed(), previous.tree);
    expect(next.tree).toStrictEqual(previous.tree);
  });

  it("carries identity across two distant edits at once", () => {
    const previous = base();
    const edited = edit(
      { old: 'variant="heading"', new: 'variant="title"' },
      { old: 'title="two"', new: 'title="second"' },
    );
    const next = recompileWithIdentity(edited, previous.tree);
    expect(next.tree.nodes.find((node) => node.props?.text === "Ledger")?.id).toBe("text-1");
    expect(idOf(next.tree, "one")).toBe("card-1");
    expect(idOf(next.tree, "second")).toBe("card-2");
  });

/**
 * An error that only repeats the string that failed tells the model nothing it
 * did not already believe, so it retries the same edit. The present text is what
 * makes the second attempt different from the first.
 */
describe("applyTextEdits — a miss reports what the document says NOW", () => {
  const app = [
    '<App name="Invoices">',
    '  <Stat label="Total outstanding" value={sum(invoices.amount_cents)}/>',
    '  <Table rows={invoices.data}/>',
    "</App>",
  ].join("\n");

  it("quotes the closest current line when a stale old string finds no match", () => {
    const result = applyTextEdits(app, [
      { old: '<Stat label="Total" value={invoices.total}/>', new: "<Stat/>" },
    ]);
    expect(result.text).toBeUndefined();
    const issue = result.issue ?? "";
    expect(issue).toContain("found no match");
    // The whole point: the CURRENT text of that region travels with the error.
    expect(issue).toContain('label="Total outstanding"');
    expect(issue).toContain("sum(invoices.amount_cents)");
    expect(issue).toContain("Quote from THAT");
  });

  it("quotes the present text on an ambiguous match too", () => {
    const twice = '<Text text="Total"/>\n<Text text="Total"/>';
    const result = applyTextEdits(twice, [{ old: '<Text text="Total"/>', new: "<Text/>" }]);
    expect(result.text).toBeUndefined();
    expect(result.issue ?? "").toContain("2 matches");
    expect(result.issue ?? "").toContain("the app right now");
  });

  it("falls back to the document itself when nothing resembles the old string", () => {
    const result = applyTextEdits(app, [{ old: "zzzz qqqq wwww", new: "x" }]);
    expect(result.issue ?? "").toContain("The app right now is:");
    expect(result.issue ?? "").toContain('<App name="Invoices">');
  });
});
});
