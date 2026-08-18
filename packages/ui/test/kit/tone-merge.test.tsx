// @vitest-environment jsdom
/**
 * THE ONE TONE VOCABULARY, after it grew and after Button joined it.
 *
 * Two changes, one subject. `info` is a tone of its own now: a state that is
 * neither good news nor bad — "running", "pending review" — had no word, so a
 * screen reached for `accent` and painted the brand, which reads as emphasis and
 * not as a status at all. And a Button's `variant` was a second, rival emphasis
 * vocabulary for the same idea, so `tone` is the taught word there too and
 * `variant` is the deprecated alias the renderer still maps — the point being that
 * a screen mixing the two words DEGRADES instead of dying.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../../src/kit/data/badge.js";
import { Button } from "../../src/kit/forms/button.js";
import { resolveTone, t, toneColor } from "../../src/kit/tokens.js";

const button = (node: Parameters<typeof render>[0]): HTMLElement =>
  render(node).container.querySelector<HTMLElement>('[data-kit="Button"]')!;

/** What a button PAINTS, which is the only thing a reader compares. */
const paint = (node: Parameters<typeof render>[0]) => {
  const el = button(node);
  return {
    tone: el.getAttribute("data-tone"),
    background: el.style.background,
    color: el.style.color,
    boxShadow: el.style.boxShadow,
    border: el.style.border,
    hover: el.style.getPropertyValue("--vendo-kit-button-hover"),
  };
};

describe("info is a tone, not an older spelling of neutral", () => {
  it("resolves to itself and paints a colour of its own", () => {
    expect(resolveTone("info")).toBe("info");
    // Distinct from the brand — the whole reason it exists — and from the grey it
    // used to flatten into.
    expect(toneColor("info")).not.toBe(toneColor("accent"));
    expect(toneColor("info")).not.toBe(toneColor("neutral"));
    expect(toneColor("info")).toContain("var(--vendo-color-info");
  });

  it("is a status pill a screen can actually write", () => {
    render(<Badge label="Running" tone="info" />);
    const pill = screen.getByText("Running");
    expect(pill.getAttribute("data-tone")).toBe("info");
    expect(pill.style.color).toContain("var(--vendo-color-info");
  });

  // "default" is the one spelling stored apps carry that is still an alias, and it
  // has to keep meaning what it always meant.
  it("leaves the legacy 'default' spelling on neutral", () => {
    expect(resolveTone("default")).toBe("neutral");
  });
});

describe("a Button's tone, and the variant it replaced", () => {
  it("takes a tone, and defaults to the brand action it always was", () => {
    const brand = paint(<Button label="Send" />);
    expect(brand.tone).toBe("accent");
    expect(brand.background).toContain("var(--vendo-color-accent");
    expect(brand.boxShadow).not.toBe("none");
    expect(paint(<Button label="Send" tone="accent" />)).toEqual(brand);
  });

  it("maps every deprecated variant onto the tone it always meant, pixel for pixel", () => {
    // The alias is honest or it is a repaint: each pair must be indistinguishable,
    // because these are the words hundreds of stored screens are written in.
    expect(paint(<Button label="Send" variant="primary" />)).toEqual(paint(<Button label="Send" tone="accent" />));
    expect(paint(<Button label="Cancel" variant="secondary" />)).toEqual(paint(<Button label="Cancel" tone="neutral" />));
    expect(paint(<Button label="Delete" variant="danger" />)).toEqual(paint(<Button label="Delete" tone="danger" />));
  });

  it("keeps the quiet button quiet and the destructive one filled", () => {
    const quiet = paint(<Button label="Cancel" tone="neutral" />);
    expect(quiet.background).toContain("var(--vendo-color-surface");
    expect(quiet.color).toContain("var(--vendo-color-text");
    expect(quiet.boxShadow).toBe("none");
    expect(quiet.border).toContain("var(--vendo-color-border");

    const destructive = paint(<Button label="Delete" tone="danger" />);
    expect(destructive.background).toBe(toneColor("danger"));
    expect(destructive.color).toContain("var(--vendo-color-accent-text");
    expect(destructive.boxShadow).not.toBe("none");
  });

  it("reads the tone the screen wrote when both words arrive", () => {
    expect(paint(<Button label="Delete" tone="danger" variant="secondary" />).tone).toBe("danger");
  });

  it("degrades a word from neither vocabulary instead of taking the screen down", () => {
    // Generated code passes arbitrary strings, and a button is the thing being
    // pressed: a misspelling must land on the default, never on a crash.
    expect(paint(<Button label="Send" variant={"primry" as never} />).tone).toBe("accent");
    expect(paint(<Button label="Send" tone={"sucess" as never} />).tone).toBe("accent");
    expect(paint(<Button label="Send" tone={"constructor" as never} />).tone).toBe("accent");
  });

  it("states its own hover fill, so every tone hovers without a rule of its own", () => {
    // The sheet carries the STATE and reads the value from here (kit-css.ts), which
    // is why a tone the stylesheet was never taught about still answers the pointer.
    expect(paint(<Button label="Send" tone="success" />).hover)
      .toBe(`color-mix(in srgb, ${toneColor("success")} 88%, ${t.text})`);
    expect(paint(<Button label="Cancel" tone="neutral" />).hover).toContain("--vendo-color-surface-raised");
  });
});
