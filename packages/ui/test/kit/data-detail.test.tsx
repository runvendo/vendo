// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "../../src/kit/data/avatar.js";
import { CodeBlock } from "../../src/kit/data/code-block.js";
import { KeyValue } from "../../src/kit/data/key-value.js";
import { Timeline } from "../../src/kit/data/timeline.js";
import { Row } from "../../src/kit/layout.js";
import { EnumBadge, Text } from "../../src/kit/values.js";

const invoice = { number: "INV-9", amountCents: 250_000, dueDate: "2026-03-14", status: "past_due", client: { name: "Maple" }, note: null };

describe("KeyValue", () => {
  it("labels each row from its key and shows the value as it stands", () => {
    render(
      <KeyValue
        record={invoice}
        items={[{ key: "client.name" }, { key: "amountCents", label: "Amount" }, { key: "dueDate" }]}
      />,
    );
    // The label defaults to the humanized LAST path segment, as a column's does.
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByText("Maple")).toBeTruthy();
    expect(screen.getByText("Amount")).toBeTruthy();
    // Nothing here formats and nothing divides: a name that ends in "Cents" is
    // not an instruction, and the stamp prints as the record holds it. A screen
    // that wants either in words prepares it in its own code, or in a `cell`.
    expect(screen.getByText("250000")).toBeTruthy();
    expect(screen.getByText("2026-03-14")).toBeTruthy();
  });

  /** An item written as the bare KEY. `items` given `string[]` was a whole class
   *  of looped repairs on unseen worlds; a string can only mean the key, so the
   *  component reads it as one. */
  it("takes an item written as its bare key, beside a described one", () => {
    const { container } = render(
      <KeyValue record={invoice} items={["client.name", { key: "status", label: "State" }]} />,
    );
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Name", "State"]);
    expect([...container.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["Maple", "past_due"]);
  });

  it("renders a cell slot in place of the row's own text", () => {
    // KeyValue's rows prop is ONE record, so a `cell` function is called once
    // and the slot holds a single element — there is no list to match. The ÷100
    // and the currency both ran where the record was in scope.
    render(
      <KeyValue
        record={invoice}
        items={[
          {
            key: "amountCents",
            cell: (
              <Text
                text={(invoice.amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}
              />
            ),
          },
          { key: "status", cell: <EnumBadge value={invoice.status} /> },
        ]}
      />,
    );
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("Past due")).toBeTruthy();
  });

  it("shows a dash for an unrenderable value rather than 'null'", () => {
    render(<KeyValue record={invoice} items={[{ key: "note" }]} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("null")).toBeNull();
  });

  it("rules between rows only when asked, and never under the last one", () => {
    const rows = (dividers: boolean) => {
      const { container } = render(
        <KeyValue record={invoice} items={[{ key: "number" }, { key: "status" }]} dividers={dividers} />,
      );
      return [...container.querySelectorAll("dt")].map((dt) => dt.getAttribute("style") ?? "");
    };
    expect(rows(false).every((style) => !style.includes("border-bottom"))).toBe(true);
    const ruled = rows(true);
    expect(ruled[0]).toContain("border-bottom");
    expect(ruled[1]).not.toContain("border-bottom");
  });

  /** No `items` is "describe this record" — the same default a table's columns
   *  have, for the one-record shape. A detail screen that names no fields is
   *  asking for the record, not for an empty list. */
  it("describes the whole record when it is given no items at all", () => {
    render(<KeyValue record={{ number: "INV-9", status: "past_due" }} />);
    expect(screen.getByText("Number")).toBeTruthy();
    expect(screen.getByText("INV-9")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
  });
});

const events = [
  { id: "a", what: "Invoice issued", at: "2026-03-01T10:00:00Z" },
  { id: "b", what: "Reminder sent", at: "2026-03-08T10:00:00Z" },
];

describe("Timeline", () => {
  it("marks one entry per record and shows its time field as it stands", () => {
    // The Timeline formats NOTHING, like every other container: it used to parse
    // this stamp and re-print it as "Mar 1, 2026", which was the last place a Kit
    // component decided what a host value meant.
    const { container } = render(<Timeline entries={events} titleField="what" timeField="at" />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("Invoice issued")).toBeTruthy();
    expect(screen.getByText("2026-03-01T10:00:00Z")).toBeTruthy();
  });

  it("shows the day the screen prepared, and adds no clock to it", () => {
    render(<Timeline entries={[{ id: "c", what: "Rent due", due_date: "Aug 1, 2026" }]} titleField="what" timeField="due_date" />);
    expect(screen.getByText("Aug 1, 2026")).toBeTruthy();
  });

  it("shows a stamp that names no year as it stands, inventing none", () => {
    // The artifact handed `displayTime` strings — "Aug 15, 7:42 AM", already
    // written for a reader. Re-parsed, V8 fills the missing year with 2001, so
    // every entry on that timeline read "Aug 15, 2001".
    render(
      <Timeline entries={[{ id: "d", what: "Coffee", displayTime: "Aug 15, 7:42 AM" }]} titleField="what" timeField="displayTime" />,
    );
    expect(screen.getByText("Aug 15, 7:42 AM")).toBeTruthy();
    expect(screen.queryByText(/2001/)).toBeNull();
  });

  it("renders the cell slot once per entry, each against its OWN entry", () => {
    // The VM called the slot function once per entry, in `entries` order, and a
    // timeline paints in that same order — so the match is positional, unlike a
    // DataTable's, which sorts.
    render(
      <Timeline
        entries={events}
        cell={events.map((entry) => <EnumBadge value={String(entry.what)} />)}
        timeField="at"
      />,
    );
    expect(screen.getByText("Invoice issued")).toBeTruthy();
    expect(screen.getByText("Reminder sent")).toBeTruthy();
  });

  it("draws the marker slot in place of the dot", () => {
    const { container } = render(
      <Timeline entries={events} titleField="what" marker={<span data-testid="mark">•</span>} />,
    );
    expect(container.querySelectorAll('[data-testid="mark"]')).toHaveLength(2);
  });

  it("puts the timestamp after the title when aligned to the end", () => {
    const text = (align: "start" | "end") =>
      render(<Timeline entries={[events[0]!]} titleField="what" timeField="at" timeAlign={align} />)
        .container.querySelector("li > div:last-child")!.textContent!;
    expect(text("start")).toMatch(/^2026-03-01T10:00:00Z.*Invoice issued$/);
    expect(text("end")).toMatch(/^Invoice issued.*2026-03-01T10:00:00Z/);
  });

  it("fails soft on missing data with its own empty text", () => {
    render(<Timeline entries={undefined as never} emptyState="Nothing happened yet" />);
    expect(screen.getByText("Nothing happened yet")).toBeTruthy();
  });
});

describe("Avatar", () => {
  it("takes one letter from each of the first two words", () => {
    render(
      <>
        <Avatar name="Ada Lovelace" />
        <Avatar name="maple" />
        <Avatar name="  a b c  " />
      </>,
    );
    expect(screen.getByLabelText("Ada Lovelace").textContent).toBe("AL");
    expect(screen.getByLabelText("maple").textContent).toBe("M");
    expect(screen.getByLabelText("a b c").textContent).toBe("AB");
  });

  it("gives one name one color, every time, and different names different ones", () => {
    const fill = (name: string) =>
      /background:[^;]+/.exec(render(<Avatar name={name} />).container.querySelector("span")!.getAttribute("style")!)![0];
    expect(fill("Ada Lovelace")).toBe(fill("Ada Lovelace"));
    expect(fill("Ada Lovelace")).not.toBe(fill("Grace Hopper"));
  });

  it("sizes the disc and publishes that size for the stack rule", () => {
    const style = (size: "sm" | "md" | "lg") =>
      render(<Avatar name="Ada" size={size} />).container.querySelector("span")!.getAttribute("style")!;
    expect(style("sm")).toContain("width: 24px");
    expect(style("lg")).toContain("width: 44px");
    expect(style("md")).toContain("--vendo-kit-avatar-size: 32px");
  });

  it("ships the sibling rule that stacks avatars inside a Row", () => {
    render(
      <Row>
        <Avatar name="Ada Lovelace" />
        <Avatar name="Grace Hopper" />
      </Row>,
    );
    // A sibling relation is not something an inline style can say, so the rule
    // is a hoisted stylesheet — and one of it, however many avatars ask.
    const css = document.documentElement.innerHTML;
    expect(css).toContain('[data-kit="Row"] > [data-kit="Avatar"] + [data-kit="Avatar"]');
    expect(css.split("margin-inline-start").length - 1).toBe(1);
  });
});

describe("CodeBlock", () => {
  it("shows the payload verbatim in a monospaced pre", () => {
    const payload = '{\n  "id": "evt_1"\n}';
    const { container } = render(<CodeBlock code={payload} language="json" />);
    const code = container.querySelector("code")!;
    expect(code.textContent).toBe(payload);
    expect(code.getAttribute("style")).toContain("--vendo-mono-family");
    expect(container.querySelector('[data-kit="CodeBlock"]')!.getAttribute("data-language")).toBe("json");
    expect(screen.getByText("json")).toBeTruthy();
  });

  it("drops the chip when no language is named", () => {
    const { container } = render(<CodeBlock code="ok" />);
    expect(container.querySelector("span")).toBeNull();
  });

  it("scrolls a long line instead of widening the panel around it", () => {
    const { container } = render(<CodeBlock code={"x".repeat(400)} />);
    const block = container.querySelector('[data-kit="CodeBlock"]') as HTMLElement;
    // The block asks for its longest line and accepts anything down to nothing:
    // a track floored at 0. jsdom does no layout, so the browser half of this
    // lives in the shot — but the floor is what the shot depends on.
    expect(block.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(container.querySelector("pre")!.style.overflowX).toBe("auto");
  });

  it("reflows a long line when asked to wrap, keeping the floor that lets it", () => {
    const { container } = render(<CodeBlock code={"x".repeat(400)} wrap />);
    const pre = container.querySelector("pre") as HTMLElement;
    expect(pre.style.whiteSpace).toBe("pre-wrap");
    // A payload is routinely ONE unbroken token, which `pre-wrap` alone leaves
    // overflowing the wrap it was asked for.
    expect(pre.style.overflowWrap).toBe("anywhere");
    // Wrapping changes what the `pre` DOES at a narrow width, never what the
    // block asks for — the track floored at 0 stays either way.
    const block = container.querySelector('[data-kit="CodeBlock"]') as HTMLElement;
    expect(block.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("caps its height rather than pushing the screen below the fold", () => {
    const { container } = render(<CodeBlock code={"line\n".repeat(400)} maxHeight={240} />);
    const pre = container.querySelector("pre") as HTMLElement;
    expect(pre.style.maxHeight).toBe("240px");
    expect(pre.style.overflowY).toBe("auto");
    // Unasked, the block grows with its payload: a cap nobody set is not one.
    expect((render(<CodeBlock code="ok" />).container.querySelector("pre") as HTMLElement).style.maxHeight).toBe("");
  });

  it("still lets a caller override the layout it defaults to", () => {
    const { container } = render(<CodeBlock code="ok" style={{ display: "block" }} />);
    expect((container.querySelector('[data-kit="CodeBlock"]') as HTMLElement).style.display).toBe("block");
  });
});
