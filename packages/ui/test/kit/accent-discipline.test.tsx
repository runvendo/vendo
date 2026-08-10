// @vitest-environment node
/**
 * The accent is scarce BY CONSTRUCTION: nothing in the Kit paints itself with
 * the host's accent unless the writer asked for the primary tone by name.
 *
 * Rendered to markup rather than into jsdom on purpose — every token is a
 * `var(--vendo-color-*, fallback)` string, which is what the browser actually
 * receives and what jsdom's CSS parser is free to discard.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Progress } from "../../src/kit/charts/progress.js";
import { Callout } from "../../src/kit/feedback/callout.js";
import { Button } from "../../src/kit/forms/button.js";
import { Form } from "../../src/kit/forms/form.js";

/** `--vendo-color-accent-text` is the FOREGROUND on a filled control (white on
 *  Maple's red danger button); only the accent hue itself counts as spending. */
const spendsAccent = (markup: string) => /--vendo-color-accent(?!-text)/.test(markup);

describe("the accent is spent only when the writer names the primary tone", () => {
  it("a Button with no variant is neutral, and variant=primary spends the accent", () => {
    expect(spendsAccent(renderToStaticMarkup(<Button label="Remind all" />))).toBe(false);
    expect(spendsAccent(renderToStaticMarkup(<Button label="Remind all" variant="primary" />))).toBe(true);
  });

  it("a danger Button spends the danger colour, never the accent", () => {
    const markup = renderToStaticMarkup(<Button label="Cancel transfer" variant="danger" />);
    expect(spendsAccent(markup)).toBe(false);
    expect(markup).toContain("--vendo-color-danger");
  });

  it("a Form's submit follows the same rule, and can be the destructive one", () => {
    expect(spendsAccent(renderToStaticMarkup(<Form submitLabel="Cancel transfer" />))).toBe(false);
    expect(spendsAccent(renderToStaticMarkup(<Form submitLabel="Add client" submitVariant="primary" />))).toBe(true);
    const destructive = renderToStaticMarkup(<Form submitLabel="Cancel transfer" submitVariant="danger" />);
    expect(spendsAccent(destructive)).toBe(false);
    expect(destructive).toContain("--vendo-color-danger");
  });

  it("a Callout on its default tone is neutral, and tone=accent still is not", () => {
    expect(spendsAccent(renderToStaticMarkup(<Callout title="Note">Only this month.</Callout>))).toBe(false);
    expect(spendsAccent(renderToStaticMarkup(<Callout tone="accent" title="Note">Highlighted.</Callout>))).toBe(true);
  });

  it("a Progress bar is neutral unless toned to the accent", () => {
    expect(spendsAccent(renderToStaticMarkup(<Progress value={0.4} label="Savings goal" />))).toBe(false);
    expect(spendsAccent(renderToStaticMarkup(<Progress value={0.4} tone="accent" />))).toBe(true);
  });
});
