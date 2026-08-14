// @vitest-environment jsdom
// The two adjectives (2026-08-13) — one `tone` vocabulary and one `density`
// vocabulary shared by the whole Kit. What this suite pins is the property that
// makes them safe to hand a model: both resolve to nothing but THEME TOKENS, so
// an adjective can never invent a color or a spacing step the host did not agree
// to. It also pins the spellings stored apps already carry ("default", "info"),
// which is the only reason those words are still in the resolver.
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { Progress } from "../../src/kit/charts/progress.js";
import { Badge } from "../../src/kit/data/badge.js";
import { Callout } from "../../src/kit/feedback/callout.js";
import { Card, Grid, Row, Stack, Surface } from "../../src/kit/layout.js";
import { RowContext } from "../../src/kit/row.js";
import { toneColor } from "../../src/kit/tokens.js";
import { DateTime, EnumBadge, Money, Num, Percent, Text } from "../../src/kit/values.js";

/** Every Kit component tags its own root, so that is the handle these use. */
function kit(container: HTMLElement, name: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-kit="${name}"]`);
  expect(el, `no [data-kit="${name}"] rendered`).not.toBeNull();
  return el!;
}

const cardBorder = (tone?: string): string =>
  kit(render(<Card title="Balance" tone={tone as never} />).container, "Card").style.border;

const progressFill = (tone?: string): string => {
  const { container } = render(<Progress value={0.5} tone={tone as never} />);
  return container.querySelector<HTMLElement>('[role="progressbar"] > div')!.style.background;
};

describe("tone is a theme token, never a literal color", () => {
  it("a Card's rule carries the danger token, and neutral keeps the plain border", () => {
    expect(cardBorder("danger")).toContain("var(--vendo-color-danger");
    expect(cardBorder("neutral")).toContain("var(--vendo-color-border");
    expect(cardBorder("danger")).not.toBe(cardBorder("neutral"));
  });

  it("success and warning are tokens too — the two tones the host contract has no color for", () => {
    expect(cardBorder("success")).toContain("var(--vendo-color-success");
    expect(cardBorder("warning")).toContain("var(--vendo-color-warning");
  });

  it("a Surface takes the same vocabulary as a Card", () => {
    const { container } = render(<Surface title="Overdue" tone="danger" />);
    const surface = kit(container, "Surface");
    expect(surface.getAttribute("data-tone")).toBe("danger");
    expect(surface.style.border).toContain("var(--vendo-color-danger");
  });

  it("a toned Text paints from the palette — the red overdue figure", () => {
    const danger = kit(render(<Text text="9 days late" tone="danger" />).container, "Text").style.color;
    const neutral = kit(render(<Text text="9 days late" tone="neutral" />).container, "Text").style.color;
    expect(danger).toContain("var(--vendo-color-danger");
    expect(danger).not.toBe(neutral);
    // Neutral is not a color of its own: it leaves the variant's own color alone.
    expect(neutral).toBe(kit(render(<Text text="9 days late" />).container, "Text").style.color);
    expect(kit(render(<Text text="note" variant="caption" />).container, "Text").style.color).toContain(
      "var(--vendo-color-muted",
    );
  });

  it("a toned Progress fills from the palette, and still defaults to the accent", () => {
    expect(progressFill("danger")).toContain("var(--vendo-color-danger");
    expect(progressFill("success")).toContain("var(--vendo-color-success");
    expect(progressFill("danger")).not.toBe(progressFill("neutral"));
    expect(progressFill()).toContain("var(--vendo-color-accent");
  });

  it("the pills speak the same five words", () => {
    render(<EnumBadge value="overdue" tones={{ overdue: "danger" }} />);
    expect(screen.getByText("Overdue").style.color).toContain("var(--vendo-color-danger");
    render(<Badge label="Beta" tone="success" />);
    expect(screen.getByText("Beta").style.color).toContain("var(--vendo-color-success");
  });

  // The catalog teaches "the figure that is bad news is `danger`", i.e. exactly
  // `<Money field="amount" tone="danger"/>` — which painted nothing at all while
  // only Text and the pills read the adjective.
  it("every figure in the value tier paints from the palette", () => {
    const figures: Array<[string, ReactElement]> = [
      ["Money", <Money amount={2500} tone="danger" />],
      ["DateTime", <DateTime value="2026-03-14" tone="danger" />],
      ["Percent", <Percent value={0.42} tone="danger" />],
      ["Num", <Num value={1234} tone="danger" />],
    ];
    for (const [name, node] of figures) {
      expect(kit(render(node).container, name).style.color, name).toContain("var(--vendo-color-danger");
    }
  });

  it("an untoned figure is untouched, and neutral is not a color of its own", () => {
    const plain = kit(render(<Money amount={2500} />).container, "Money").style.color;
    expect(plain).toContain("var(--vendo-color-text");
    expect(kit(render(<Money amount={2500} tone="neutral" />).container, "Money").style.color).toBe(plain);
  });

  // The pill palette's own docblock promises every entry is a token or a mix of
  // tokens. Mixing the foreground with a literal `#000` broke that, and drove
  // both foregrounds into the background of a dark host theme.
  it("darkens the success/warning foregrounds against the TEXT token, never a literal black", () => {
    render(<EnumBadge value="paid" tones={{ paid: "success" }} />);
    const color = screen.getByText("Paid").style.color;
    expect(color).toContain("var(--vendo-color-success");
    expect(color).toContain("var(--vendo-color-text");
    expect(color).not.toContain("#000");
  });

  it("an unknown tone falls back rather than throwing — toneColor is code-land too", () => {
    expect(() => toneColor("bogus")).not.toThrow();
    expect(toneColor("bogus")).toBe(toneColor("neutral"));
    expect(toneColor(undefined)).toBe(toneColor("neutral"));
  });
});

describe("the legacy spellings stored apps carry", () => {
  it('Card tone="default" still renders, as neutral', () => {
    const { container } = render(<Card title="Balance" tone={"default" as never} />);
    const card = kit(container, "Card");
    expect(card.getAttribute("data-tone")).toBe("neutral");
    expect(card.style.border).toContain("var(--vendo-color-border");
  });

  it('an EnumBadge tone map may still say "default"', () => {
    render(<EnumBadge value="draft" tones={{ draft: "default" as never }} />);
    expect(screen.getByText("Draft").getAttribute("data-tone")).toBe("neutral");
  });

  it('Callout tone="info" stays the accented ⓘ notice, and stays the default', () => {
    const info = kit(render(<Callout tone="info" title="FYI">Body.</Callout>).container, "Callout");
    expect(info.style.borderLeft).toContain("var(--vendo-color-accent");
    expect(info.textContent).toContain("ⓘ");
    const noTone = kit(render(<Callout title="FYI">Body.</Callout>).container, "Callout");
    expect(noTone.getAttribute("style")).toBe(info.getAttribute("style"));
  });

  it('Callout also answers to the shared "neutral"', () => {
    const { container } = render(<Callout tone="neutral">Nothing urgent.</Callout>);
    expect(kit(container, "Callout").style.borderLeft).toContain("var(--vendo-color-text");
    expect(screen.getByText("Nothing urgent.")).toBeTruthy();
  });
});

describe("density is declared once and inherited", () => {
  it("a compact container re-declares the whole spacing ladder on its own element", () => {
    const { container } = render(<Stack density="compact" />);
    const stack = kit(container, "Stack");
    expect(stack.style.getPropertyValue("--vendo-density")).toBe("compact");
    expect(stack.style.getPropertyValue("--vendo-density-table-padding")).toBe("7px 10px");
    expect(stack.style.getPropertyValue("--vendo-density-card-padding")).toBe("12px");
    expect(stack.style.getPropertyValue("--vendo-density-badge-height")).toBe("20px");
  });

  it("comfortable declares the other end of the same ladder", () => {
    const { container } = render(<Stack density="comfortable" />);
    expect(kit(container, "Stack").style.getPropertyValue("--vendo-density-table-padding")).toBe("10px 12px");
  });

  it("no density declares nothing, so the host page's own scale still wins", () => {
    const { container } = render(<Stack />);
    expect(kit(container, "Stack").style.getPropertyValue("--vendo-density")).toBe("");
    expect(kit(container, "Stack").style.getPropertyValue("--vendo-density-card-padding")).toBe("");
  });

  it("a child READS the variables the container declared — the whole implementation", () => {
    const { container } = render(
      <Stack density="compact">
        <Surface title="Invoices" />
      </Stack>,
    );
    const stack = kit(container, "Stack");
    const surface = kit(container, "Surface");
    // Name-matched rather than computed: jsdom does not resolve var(), so what
    // is provable here is the seam itself — the child names the same custom
    // property the parent set, which is why nothing had to branch on density.
    expect(surface.style.padding).toContain("var(--vendo-density-card-padding");
    expect(stack.style.getPropertyValue("--vendo-density-card-padding")).toBe("12px");
    expect(surface.style.gap).toContain("var(--vendo-density-content-gap");
    expect(stack.style.getPropertyValue("--vendo-density-content-gap")).toBe("7px");
  });

  it("every container takes the adjective", () => {
    const containers: Array<[string, ReactElement]> = [
      ["Stack", <Stack density="compact" />],
      ["Row", <Row density="compact" />],
      ["Grid", <Grid density="compact" />],
      ["Surface", <Surface density="compact" />],
      ["Card", <Card density="compact" />],
    ];
    for (const [name, node] of containers) {
      const { container } = render(node);
      expect(kit(container, name).style.getPropertyValue("--vendo-density"), name).toBe("compact");
    }
  });
});

describe("Grid minChildWidth", () => {
  it("auto-fits so cells wrap instead of clipping, and wins over columns", () => {
    const { container } = render(<Grid columns={4} minChildWidth={160} />);
    expect(kit(container, "Grid").style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
    );
  });

  it("keeps the fixed count when no floor is given", () => {
    const { container } = render(<Grid columns={3} />);
    expect(kit(container, "Grid").style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
  });
});

// Badge's own suite lives in another file; its two new adjectives are here.
describe("Badge", () => {
  it("reads the row's field in a cell slot, and its own label outside one", () => {
    render(
      <RowContext.Provider value={{ plan: "Pro" }}>
        <Badge label="Beta" field="plan" />
      </RowContext.Provider>,
    );
    expect(screen.getByText("Pro")).toBeTruthy();
    render(<Badge label="Beta" field="plan" />);
    expect(screen.getByText("Beta")).toBeTruthy();
  });
});
