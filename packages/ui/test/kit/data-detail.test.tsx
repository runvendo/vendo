// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "../../src/kit/data/avatar.js";
import { CodeBlock } from "../../src/kit/data/code-block.js";
import { KeyValue } from "../../src/kit/data/key-value.js";
import { Timeline } from "../../src/kit/data/timeline.js";
import { Row } from "../../src/kit/layout.js";
import { EnumBadge, Money } from "../../src/kit/values.js";

const invoice = { number: "INV-9", amountCents: 250_000, dueDate: "2026-03-14", status: "past_due", client: { name: "Maple" }, note: null };

describe("KeyValue", () => {
  it("labels each row from its key and formats the value", () => {
    render(
      <KeyValue
        record={invoice}
        items={[{ key: "client.name" }, { key: "amountCents", label: "Amount" }, { key: "dueDate", format: "date" }]}
      />,
    );
    // The label defaults to the humanized LAST path segment, as a column's does.
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByText("Maple")).toBeTruthy();
    expect(screen.getByText("Amount")).toBeTruthy();
    expect(screen.getByText("250000")).toBeTruthy();
    expect(screen.getByText(/Mar 14, 2026/)).toBeTruthy();
  });

  it("renders a slot's components against the record, not against a prop", () => {
    // The seam the cell slot exists for: the component names its FIELD and the
    // value arrives off RowContext, published by KeyValue.
    render(
      <KeyValue
        record={invoice}
        items={[
          { key: "amountCents", cell: <Money field="amountCents" /> },
          { key: "status", cell: <EnumBadge field="status" /> },
        ]}
      />,
    );
    expect(screen.getByText("$250,000.00")).toBeTruthy();
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
});

const events = [
  { id: "a", what: "Invoice issued", at: "2026-03-01T10:00:00Z" },
  { id: "b", what: "Reminder sent", at: "2026-03-08T10:00:00Z" },
];

describe("Timeline", () => {
  it("marks one entry per record and formats its timestamp", () => {
    const { container } = render(<Timeline entries={events} titleField="what" timeField="at" />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("Invoice issued")).toBeTruthy();
    expect(screen.getByText(/Mar 1, 2026/)).toBeTruthy();
  });

  it("renders the cell slot once per entry, each reading its OWN record", () => {
    // One element, two entries, two different values — the whole reason a slot
    // binds by field name instead of by prop.
    render(<Timeline entries={events} cell={<EnumBadge field="what" />} timeField="at" />);
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
    expect(text("start")).toMatch(/^Mar 1, 2026.*Invoice issued$/);
    expect(text("end")).toMatch(/^Invoice issued.*Mar 1, 2026/);
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
});
