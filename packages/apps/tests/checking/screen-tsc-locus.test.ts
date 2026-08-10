/**
 * A floor finding has to be ACTIONABLE, not merely true.
 *
 * `where` carries a tag NAME (`<Stat>`) and a screen routinely holds several
 * nodes of the same component, so "is missing required prop \"value\"" leaves the
 * author guessing WHICH one — and a wrong guess costs a whole
 * save → validate → re-save round. So a finding on a tag quotes that tag, and a
 * missing required prop names the type that goes in the hole.
 */
import type { JsonSchema } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { screenTscFindings } from "../../src/server/checking/screen-tsc.js";
import { screenTypings } from "../../src/server/checking/screen-typings.js";

const spendSchema: JsonSchema = {
  type: "object",
  properties: { totalCents: { type: "number" }, savedCents: { type: "number" } },
  required: ["totalCents", "savedCents"],
  additionalProperties: false,
};

const typings = screenTypings({
  catalog: [],
  queries: [{ name: "spend", tool: "maple_spend" }],
  toolOutputSchemas: { maple_spend: spendSchema },
});

const check = (screen: string) => screenTscFindings({ screen, typings });

describe("a floor finding names the tag to edit", () => {
  it("quotes the BROKEN tag when the screen holds several of the component", () => {
    const findings = check(`<App name="Spend">
  <Query id="spend" tool="maple_spend"/>
  <Stat label="Total" value={spend.totalCents} format="money"/>
  <Stat label="Saved" format="money"/>
</App>;
`);
    const missing = findings.find((finding) => finding.message.includes('missing required prop "value"'));
    expect(missing).toBeDefined();
    expect(missing?.message).toContain('<Stat label="Saved" format="money"/>');
    // The healthy sibling is not implicated.
    expect(missing?.message).not.toContain('label="Total"');
    // The type that goes in the hole — without the `{ $path } | { $state } |
    // { $expr }` boilerplate every single prop carries.
    expect(missing?.message).toMatch(/it takes (number \| string|string \| number)\)/u);
    expect(missing?.message).not.toContain("$path");
  });

  it("quotes the tag on an unknown prop too", () => {
    const findings = check(`<App name="Spend">
  <Query id="spend" tool="maple_spend"/>
  <Stat label="Saved" value={spend.savedCents} colour="red"/>
</App>;
`);
    const unknown = findings.find((finding) => finding.message.includes('unknown prop "colour"'));
    expect(unknown?.message).toContain('<Stat label="Saved" value={spend.savedCents} colour="red"/>');
  });
});
