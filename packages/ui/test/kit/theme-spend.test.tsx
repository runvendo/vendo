// @vitest-environment node
// The Kit has to SPEND the host's theme, not merely accept it. Measured on
// ~1,600 benchmark screens: the commonest generated screen is one Stat over one
// DataTable, and it rendered with the accent nowhere and a title the same height
// as a field label. Both were Kit defaults, so both are pinned here.
//
// Rendered to static markup rather than into jsdom: jsdom's cssstyle drops
// `var()` / `calc()` values it cannot parse, so a themed declaration is neither
// readable nor reliably present in the DOM under test — the markup is what the
// browser actually receives.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stat } from "../../src/kit/data/stat.js";
import { Text } from "../../src/kit/values.js";

describe("the Kit spends the theme it was given", () => {
  it("a default-tone Stat carries the accent on its rule", () => {
    const html = renderToStaticMarkup(<Stat label="Net worth" value={3626515} format="money" />);
    expect(html).toContain("border-left:3px solid var(--vendo-color-accent");
  });

  it("a danger-tone Stat keeps the danger rule", () => {
    const html = renderToStaticMarkup(<Stat label="Overdue" value={4200} format="money" tone="danger" />);
    expect(html).toContain("border-left:3px solid var(--vendo-color-danger");
  });

  it("a heading is sized above the body, not just weighted", () => {
    const heading = renderToStaticMarkup(<Text text="Accounts" variant="heading" />);
    const body = renderToStaticMarkup(<Text text="Accounts" />);
    expect(heading).toContain("font-size:calc(");
    expect(body).not.toContain("calc(");
  });
});
