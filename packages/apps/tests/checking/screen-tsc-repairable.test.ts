/**
 * A refusal has to be REPAIRABLE, not merely correct.
 *
 * Three information gaps the author cannot close from its own document, and so
 * three ways the same finding comes back a second time:
 *
 * 1. WHICH element. `<Stat>` is not an address on a screen with four of them.
 * 2. A missing prop the document plainly WRITES — the wire compiler dropped the
 *    attribute (`wire/attributes.ts`), and this check reads the compiled tree, so
 *    the sentence contradicts the file unless it names the drop.
 * 3. WHICH names are in scope — "only the queries it declares" is the rule; the
 *    declared list is the repair.
 */
import type {
  JsonSchema,
} from "@vendoai/core";
import type {
  NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { screenTypings } from "../../src/server/checking/screen-typings.js";
import { screenTscFindings } from "../../src/server/checking/screen-tsc.js";

const invoicesSchema: JsonSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: { type: "object", properties: { amount_cents: { type: "number" } }, additionalProperties: false } },
    total_cents: { type: "number" },
  },
  required: ["data", "total_cents"],
  additionalProperties: false,
};

const netWorthSchema: JsonSchema = {
  type: "object",
  properties: { valueCents: { type: "number" }, series: { type: "array", items: { type: "number" } } },
  required: ["valueCents", "series"],
  additionalProperties: false,
};

const catalog: NormalizedCatalog = [{ name: "MapleNetWorthCard", description: "Net worth", propsJsonSchema: netWorthSchema }];

const typings = screenTypings({
  catalog,
  queries: [{ name: "invoices", tool: "maple_invoices_list" }],
  toolOutputSchemas: { maple_invoices_list: invoicesSchema },
});

const check = (screen: string) => screenTscFindings({ screen, typings });

describe("a refusal the author can act on", () => {
  it("says WHICH element when the document holds more than one with that tag", () => {
    const findings = check('<App name="x">'
      + "<MapleNetWorthCard series={[1]}/>"
      + "<MapleNetWorthCard valueCents={2} series={[2]}/>"
      + "<MapleNetWorthCard series={[3]}/>"
      + "</App>;");
    const loci = findings.map((finding) => finding.where);
    expect(loci).toContain("<MapleNetWorthCard> (#1 of 3)");
    expect(loci).toContain("<MapleNetWorthCard> (#3 of 3)");
    // The one that is fine is not named at all.
    expect(loci).not.toContain("<MapleNetWorthCard> (#2 of 3)");
  });

  it("leaves an unambiguous locus alone — no coordinates where there is nothing to disambiguate", () => {
    const findings = check('<App name="x"><MapleNetWorthCard series={[1]}/></App>;');
    expect(findings.map((finding) => finding.where)).toContain("<MapleNetWorthCard>");
    expect(findings.every((finding) => !(finding.where ?? "").includes("#"))).toBe(true);
  });

  it("carries the position onto a prop-level locus too", () => {
    const findings = check('<App name="x">'
      + "<MapleNetWorthCard valueCents={1} series={[1]}/>"
      + "<MapleNetWorthCard valueCents={invoices.data} series={[2]}/>"
      + "</App>;");
    expect(findings.map((finding) => finding.where)).toContain('<MapleNetWorthCard> prop "valueCents" (#2 of 2)');
  });

  it("names the dropped attribute, so a document that DOES write the prop is not told to write it again", () => {
    const findings = check('<App name="x"><MapleNetWorthCard series={[1]}/></App>;');
    const message = findings.map((finding) => finding.message).join(" ");
    expect(message).toContain('is missing required prop "valueCents"');
    expect(message).toContain("DROPPED");
    expect(message).toContain('valueCents="text" or valueCents={expression}');
  });

  it("names the queries the document declares when it reads a name that is not one of them", () => {
    const findings = check('<App name="x">'
      + '<Query id="invoices" tool="maple_invoices_list"/>'
      + "<Stat label=\"a\" value={invoces.total_cents}/>"
      + "</App>;");
    const message = findings.map((finding) => finding.message).join(" ");
    expect(message).toContain('reads unknown name "invoces"');
    expect(message).toContain("This document declares: invoices");
  });

  it("says the document declares NO queries rather than listing an empty set", () => {
    const findings = check('<App name="x"><Stat label="a" value={nope}/></App>;');
    const message = findings.map((finding) => finding.message).join(" ");
    expect(message).toContain('reads unknown name "nope"');
    expect(message).toContain("declares no queries at all");
  });
});
