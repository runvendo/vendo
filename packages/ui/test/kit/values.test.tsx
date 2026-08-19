// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EnumBadge, Text } from "../../src/kit/values.js";

describe("EnumBadge", () => {
  it("humanizes a snake_case enum value", () => {
    render(<EnumBadge value="past_due" />);
    expect(screen.getByText("Past due")).toBeTruthy();
  });

  it("honors an explicit label + tone map", () => {
    render(<EnumBadge value="overdue" labels={{ overdue: "OVERDUE" }} tones={{ overdue: "danger" }} />);
    const badge = screen.getByText("OVERDUE");
    expect(badge.getAttribute("data-tone")).toBe("danger");
  });

  it("renders nothing for an empty value", () => {
    const { container } = render(<EnumBadge value={null} />);
    expect(container.textContent).toBe("");
  });

  // `labels`/`tones` are model-authored records, so an enum value that happens to
  // name an Object.prototype member must read as ABSENT — a bare index hands
  // React `Object.prototype.toString`, a function, as the pill's label.
  it("an enum value that names a prototype member reads as data, never a method", () => {
    const { container } = render(<EnumBadge value="toString" labels={{}} tones={{}} />);
    expect(container.textContent).toBe("To string");
    expect(screen.getByText("To string").getAttribute("data-tone")).toBe("neutral");
  });
});

describe("Text", () => {
  it("renders a heading element for the heading variant", () => {
    render(<Text text="Overview" variant="heading" />);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });

  // An identifier is compared character by character, not read as prose — and
  // the face is the HOST's code font, never one the Kit picked.
  it("renders the code variant in the host's mono face", () => {
    render(<Text text="9f2c1ab" variant="code" />);
    expect(screen.getByText("9f2c1ab").getAttribute("style")).toContain("--vendo-mono-family");
  });

  // `active`, `isPaid`, `archived` — a boolean is one of the commonest values
  // there is, and React renders one as literally nothing.
  it("shows a boolean instead of swallowing it", () => {
    expect(render(<Text text={false} />).container.textContent).toBe("false");
    expect(render(<Text text={true} />).container.textContent).toBe("true");
  });

  // VALUES IN SENTENCES, and the only road left: a screen formats its own
  // figures, so the sentence is where a formatted figure sits. With `text` the
  // only way in, a phrase and its figures would have to be concatenated into one
  // string before they got here, and nothing in it could be composed or painted
  // on its own.
  it("takes children, so a formatted figure can sit inside a sentence", () => {
    const overdue = (2500).toLocaleString("en-US", { style: "currency", currency: "USD" });
    const { container } = render(
      <Text variant="caption">
        Overdue: {overdue} on <Text variant="code">INV-4471</Text>
      </Text>,
    );
    expect(container.textContent).toBe("Overdue: $2,500.00 on INV-4471");
    // The reference is a component of its own, not flattened text — and the
    // sentence around it still carries the variant it was given.
    expect(container.querySelector('[data-variant="code"]')).toBeTruthy();
    expect(container.querySelector('[data-kit="Text"]')!.getAttribute("data-variant")).toBe("caption");
  });

  // A toned sentence painted its words red and the FIGURE stayed default: the
  // old value tier re-declared `t.text` on itself, so the overdue balance — the
  // one word in the sentence carrying the meaning — was the only word that lost
  // it. A formatted figure is a run of text in the sentence now, which is the
  // one shape the tone always reaches.
  it("paints the figure in its sentence, not only the words around it", () => {
    const { container } = render(
      <Text tone="danger">Balance: {(2500).toLocaleString("en-US", { style: "currency", currency: "USD" })}</Text>,
    );
    const sentence = container.querySelector<HTMLElement>('[data-kit="Text"]')!;
    expect(sentence.style.color).toContain("var(--vendo-color-danger");
    expect(sentence.textContent).toBe("Balance: $2,500.00");
    // The figure wears no element of its own, so the color declared here IS the
    // color it resolves to — jsdom reports the declaration, a browser paints it.
    expect(sentence.children.length).toBe(0);
  });

  it("takes a plain string child", () => {
    expect(render(<Text>Hi</Text>).container.textContent).toBe("Hi");
  });

  /** `text` wins where both are given: it is the prop every stored screen
   *  carries, and the renderer hands children to every node it paints. */
  it("keeps text winning over children", () => {
    expect(render(<Text text="From the prop">ignored</Text>).container.textContent).toBe("From the prop");
  });

  it("lands an object on the placeholder rather than throwing or spelling it out", () => {
    // `text={row.client}` where `client` is a record: as a React child that
    // throws, and through a formatter it reads "[object Object]".
    expect(render(<Text text={{ name: "Maple" } as never} />).container.textContent).toBe("—");
  });
});
