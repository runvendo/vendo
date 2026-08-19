/**
 * The AI reviewer (generation pipeline rebuild, Task 6): one strict
 * `report_findings` call per finished app, its answer parsed into findings —
 * and every way that call can go wrong parsed into no findings at all, because
 * the reviewer must never be what kills a generated app.
 */
import {
  VENDO_APP_FORMAT,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  type AppDocument,
  type NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createCheckingLayer, judgmentRules } from "../../src/server/checking/layer.js";
import { reviewerCheck } from "../../src/server/checking/reviewer.js";
import { REVIEWER_SYSTEM } from "../../src/server/checking/reviewer-prompt.js";
import { inlineSourceFile } from "../../src/server/persistence/app-source.js";
import type { Check, CheckInput } from "../../src/server/checking/types.js";
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../../src/server/testing/scripted-model.js";

const tools: HostToolInfo[] = [{
  name: "host_listInvoices",
  description: "Open invoices",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
}];

const catalog: NormalizedCatalog = [];

const deps = (model: FloorDependencies["model"]): FloorDependencies =>
  ({ model, catalog, tools });

/** The app the reviewer judges: its `app.tsx`, spelled exactly as the row spells
 *  it. The reviewer reads the STORED screen and nothing else. */
const documentFrom = (source: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_reviewer_test",
  name: "Invoices",
  ui: "tree",
  source: { [SCREEN_FILE]: inlineSourceFile(source) },
});

/**
 * `reviewerCheck` is declared as the `Check` UNION, and only the fact half has
 * `run` (the judgment half is a rule string). The reviewer is always the fact
 * half; narrow once here so no case below needs a cast — and so this stops
 * compiling the day that stops being true.
 */
const factReviewerCheck = (...args: Parameters<typeof reviewerCheck>): Extract<Check, { run: unknown }> => {
  const check = reviewerCheck(...args);
  if (!("run" in check)) throw new Error("reviewerCheck is no longer a fact check");
  return check;
};

const inputFor = (source: string, request = "show me my invoices"): CheckInput =>
  ({ document: documentFrom(source), request });

const invoicesApp = `import { DataTable, Stack, Text, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("host_listInvoices");
  return (
    <Stack gap={12}>
      <Text text="Total: $12,480" variant="heading" />
      <DataTable rows={invoices.data} columns={[{ key: "client" }]} />
    </Stack>
  );
}
`;

const samples = {
  invoices: { data: [{ id: "inv_1", client: "Northwind", amountCents: 990_00 }] },
};

const reported = (findings: unknown): { tool: string; input: unknown } =>
  ({ tool: "report_findings", input: { findings } });

/** The connectives and verbs a remedy shows up as in English, plus the phrase the
 *  reviewer's prompt AND its tool schema both used to ask for outright ("what is
 *  wrong AND the real alternative"). Read against both, because they ride in one
 *  call and a model handed two charters picks one. */
const ADVISORY = /\binstead\b|\brather\b|\bshould\b|\bought\b|\bsuggest|\brecommend|\bconsider\b|the real alternative/iu;

describe("a finding is a fact, and a fact only", () => {
  /**
   * A FINDING IS AN ORDER, NOT A NOTE. It travels verbatim under "Fix each of
   * these, then write the file again" (`generation/validate-gate.ts`
   * `repairInstruction`) to a builder that cannot see the reviewer's reasoning, so
   * a word of advice in it is a word that gets carried out. Run
   * 2026-08-18T15-25-05, case team-permissions: the reviewer advised "answer
   * honestly rather than substituted" and the repair deleted a wired
   * `update_team_role` select. So the section that tells the reviewer what a
   * message IS gets read for the words advice arrives in, rather than trusted.
   */
  const FORMAT_HEADING = "Each finding has three fields";

  it("asks the findings format for evidence, and never for a remedy", () => {
    const at = REVIEWER_SYSTEM.indexOf(FORMAT_HEADING);
    expect(at, `the reviewer's prompt no longer has a "${FORMAT_HEADING}" section`).toBeGreaterThan(-1);
    const format = REVIEWER_SYSTEM.slice(at);

    // The charter itself, so this can never pass by the section going missing.
    expect(format).toContain("every word of it checkable");
    expect(format).toContain("no remedy, no redesign");
    expect(format).not.toMatch(ADVISORY);
  });

  it("keeps the checks it talked itself out of off the list", () => {
    // In that same run, 31% of blocks and 16% of warns were the reviewer flagging
    // something, checking its own arithmetic, concluding there was no issue — and
    // reporting it anyway; another 18% of warns asked the reader to "verify" or
    // "confirm". Both reach the repair round as an order to change a screen that
    // was right, so the prompt names them and this pins that it does.
    expect(REVIEWER_SYSTEM).toContain("EMIT ONLY WHAT YOU VERIFIED");
    expect(REVIEWER_SYSTEM).toMatch(/talks itself back out[\s\S]*?hedges/u);
  });
});

describe("a finding has to be worth the repair round it buys", () => {
  /**
   * TRUE IS NOT THE BAR. Every finding buys a ~20-second repair round the person
   * sits and waits through, and a reviewer reporting every true thing it could see
   * moved the median 15s — so a label it would have phrased differently cost real
   * seconds to reword. The bar is what a person USING the screen loses by it.
   */
  it("bars everything a person using the screen would not lose anything to", () => {
    expect(REVIEWER_SYSTEM).toContain("MISLED OR BLOCKED");
    // The bar sentence itself, which is the whole ruling in one line.
    expect(REVIEWER_SYSTEM).toContain(
      "If the screen would ship fine without the fix, it is not a finding",
    );
    // What clears it, in the reviewer's own terms…
    expect(REVIEWER_SYSTEM).toContain("a control that does not work");
    expect(REVIEWER_SYSTEM).toContain("anything the ask named by name that nothing here delivers");
    expect(REVIEWER_SYSTEM).toContain("a displayed value breaking a rule this product's owner stated");
    // …and what does not, named so a model cannot rule its own taste material.
    expect(REVIEWER_SYSTEM).toMatch(/a label's phrasing[\s\S]*?polish suggestion/u);
  });

  it("keeps the severity split the bar sits on top of", () => {
    // The bar decides WHETHER to report; the split decides how loud. A bar that
    // ate either half would be a rewrite of the verdict, not a filter on it.
    expect(REVIEWER_SYSTEM).toMatch(/Severity: "block" ONLY for what the person cannot detect themselves/u);
    expect(REVIEWER_SYSTEM).toContain('"warn" for everything else');
  });
});

describe("the ask's own nouns are walked one by one", () => {
  /**
   * THE BIGGEST CLUSTER THERE IS. Run 2026-08-18T21-39-10 failed 11 cases on one
   * shape: a screen better than its predecessor in every other way that quietly
   * dropped a noun the ask named — a field on a team form, an owner's name beside a
   * row, the person's own reason echoed back. The walk it was given listed
   * DELIVERABLES (a reminder, a schedule, a column), so a noun smaller than one fell
   * between the rule and the bar and nothing reported it.
   */
  const RULE_FIVE = "5. WORK QUIETLY DROPPED.";

  it("walks the ask's named ELEMENTS, down to a field, a name and an echo", () => {
    const at = REVIEWER_SYSTEM.indexOf(RULE_FIVE);
    expect(at, "the reviewer's prompt no longer has a dropped-work rule").toBeGreaterThan(-1);
    const rule = REVIEWER_SYSTEM.slice(at, REVIEWER_SYSTEM.indexOf("Severity:", at));

    expect(rule).toContain("WALK THE ASK'S NAMED ELEMENTS ONE BY ONE");
    // The three the run lost, in the reviewer's own terms.
    expect(rule).toContain("a field it says a form takes");
    expect(rule).toContain("a person or a team it says the screen shows");
    expect(rule).toContain("a word of their own it says to echo back");
    // Still a fact and never a remedy, exactly like every other rule.
    expect(rule).toContain("quote the ask's own words for it");
    expect(rule).not.toMatch(ADVISORY);
  });

  it("rules an ask-named element material by definition, so the bar cannot eat the walk", () => {
    // THE TWO PULL AGAINST EACH OTHER. The bar (15de735a1) exists to silence an
    // eager reviewer, and a missing team field is small enough to read as a nit —
    // so the walk says outright that the person asking for it IS the materiality,
    // and the bar's own list carries it.
    expect(REVIEWER_SYSTEM).toContain("AN ELEMENT THE ASK NAMED IS MATERIAL BY DEFINITION");
    // …and the bar's own list of what clears it says the same thing, in the same
    // grain: not a deliverable alone, but a field, a name, an echo.
    expect(REVIEWER_SYSTEM).toContain(
      "anything the ask named by name that nothing here delivers — a deliverable, a field, a name, a word of theirs echoed back",
    );
    // …and the other direction, in the same sentence: what the bar turns away is
    // the reviewer's own taste, and nothing the person named.
    expect(REVIEWER_SYSTEM).toMatch(/a label's phrasing[\s\S]*?polish suggestion/u);
    expect(REVIEWER_SYSTEM).toContain("YOUR idea rather than something the person asked for by name");
  });
});

describe("host and pack judgment rules reach the reviewer (F2)", () => {
  const CITE_TOTALS = "Every total on screen has to say which report it came from.";
  const NO_UNATTENDED = "Scheduled work must never move money, message a person, or delete anything.";

  it("appends each rule to the rubric as its own line, never concatenated", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples, [CITE_TOTALS, NO_UNATTENDED]).run(inputFor(invoicesApp));

    const system = String(calls[0]?.prompt?.[0]?.content ?? JSON.stringify(calls[0]?.prompt));
    expect(system).toContain(CITE_TOTALS);
    expect(system).toContain(NO_UNATTENDED);
    // Separate lines: a joined blob reads as one garbled rule.
    expect(system).toContain(`- ${CITE_TOTALS}\n- ${NO_UNATTENDED}`);
  });

  it("keeps the taste ban from swallowing them: an owner's rule is a rule, not taste", async () => {
    // The rubric can carry a rule about a font, a colour or a date format — the
    // three things the taste ban names. Without the exemption the reviewer reads
    // its own last line and stays quiet about the rule it was just handed.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples, [CITE_TOTALS]).run(inputFor(invoicesApp));

    const system = String(calls[0]?.prompt?.[0]?.content ?? "");
    expect(system).toContain("never report matters of taste");
    expect(system).toContain("A rule this product's owner set is never taste");
  });

  it("says nothing about extra rules when no pack contributed one", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples, []).run(inputFor(invoicesApp));

    const system = String(calls[0]?.prompt?.[0]?.content ?? "");
    expect(system).not.toMatch(/ALSO REJECT/);
  });

  it("changes the verdict: the SAME app blocks only when the rule is in the prompt", async () => {
    // A reader that applies the rule it was given. Same app, same data — the
    // only difference is whether the rubric carried the rule, so a finding here
    // is the rule doing work rather than a scripted constant.
    const readerApplying = (rule: string) => scriptedLanguageModel((call) => {
      const system = String(call.prompt?.[0]?.content ?? "");
      return system.includes(rule)
        ? reported([{ severity: "block", where: '<Text> labeled "Total: $12,480"', message: "the total does not say which report it came from" }])
        : reported([]);
    });

    const withRule = await factReviewerCheck(deps(readerApplying(CITE_TOTALS)), samples, [CITE_TOTALS])
      .run(inputFor(invoicesApp));
    const withoutRule = await factReviewerCheck(deps(readerApplying(CITE_TOTALS)), samples, [])
      .run(inputFor(invoicesApp));

    expect(withRule).toEqual([{
      severity: "block",
      where: '<Text> labeled "Total: $12,480"',
      message: "the total does not say which report it came from",
    }]);
    expect(withoutRule).toEqual([]);
  });

  it("carries the rules a pack contributed through the composed floor, end to end", async () => {
    // The real wiring: judgment checks go in as `Pack.checks`, the floor hands
    // the reviewer exactly the rules it derived, and nothing runs them as code.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });
    const packChecks = [
      { name: "cite-totals", kind: "judgment" as const, rule: CITE_TOTALS },
      { name: "unattended-irreversibility", kind: "judgment" as const, rule: NO_UNATTENDED },
    ];
    const layer = createCheckingLayer({
      checks: [reviewerCheck(deps(model), samples, judgmentRules(packChecks)), ...packChecks],
    });

    await layer.run(inputFor(invoicesApp));

    expect(layer.rubric).toEqual([CITE_TOTALS, NO_UNATTENDED]);
    const system = String(calls[0]?.prompt?.[0]?.content ?? "");
    expect(system).toContain(CITE_TOTALS);
    expect(system).toContain(NO_UNATTENDED);
  });
});

describe("a house rule is not a lesser finding", () => {
  it("names a broken house rule in the severity the reviewer picks from", async () => {
    // A TOOL DESCRIPTION IS PROMPT, and this one rode next to a rubric that told the
    // reviewer to warn about a broken convention while the description offered two
    // named sins and a leftovers bin. The bin now names it.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

    const tool = calls[0]?.tools?.[0] as { inputSchema?: { properties: { findings: { items: {
      properties: { severity: { description: string } };
    } } } } };
    const severity = tool.inputSchema?.properties.findings.items.properties.severity.description ?? "";
    expect(severity).toContain("a broken house rule included");
    // The split itself is untouched: a house rule buys a repair, never a refusal.
    expect(severity).toMatch(/^block for dishonesty and invented data/u);
    expect(REVIEWER_SYSTEM).toContain("every rule of this product's own that the screen breaks");
  });

  it("lets the host's own rules decide whether a screen owes a confirmation", () => {
    // The carve-out ("a screen is never wrong for having no confirmation step of its
    // own") was written against a screen asking twice, and it also blinded the
    // reviewer to the hosts whose own rules DEMAND the step — which is the reading
    // `skills/format-reference.ts` already gives the writer.
    expect(REVIEWER_SYSTEM).not.toContain("never wrong for having no confirmation step");
    expect(REVIEWER_SYSTEM).toContain("THIS PRODUCT'S OWN STATED RULES DECIDE");
    // The default stands where no rule speaks…
    expect(REVIEWER_SYSTEM).toContain("a screen that confirms nothing of its own is not wrong for that alone");
    // …and the product's own approval is a confirmation, so a rule it satisfies is
    // satisfied and no finding is filed about it.
    expect(REVIEWER_SYSTEM).toContain("not the product's own approval either, which counts wherever it fires");
    // What a rule requires is material even when it is not a value on screen.
    expect(REVIEWER_SYSTEM).toContain("anything else one of those rules requires that this screen does not do");
  });
});

describe("the seat the reviewer's one model call rides", () => {
  it("spends the REVIEW model when the floor carries one, and `model` when it does not", async () => {
    // Judging a finished screen against its own rows is a reading job, so the
    // deployment hands the floor the family's fast pick. Two recorders is what
    // makes this a real assertion: which one was asked is the whole fact.
    const writerCalls: ScriptedModelCall[] = [];
    const reviewCalls: ScriptedModelCall[] = [];
    const writer = scriptedLanguageModel((call) => { writerCalls.push(call); return reported([]); });
    const reviewModel = scriptedLanguageModel((call) => { reviewCalls.push(call); return reported([]); });

    await factReviewerCheck({ ...deps(writer), reviewModel }, samples).run(inputFor(invoicesApp));
    expect(reviewCalls).toHaveLength(1);
    expect(writerCalls).toHaveLength(0);

    // No review seat — a host composing this block itself — and it rides `model`,
    // exactly as it always did.
    await factReviewerCheck(deps(writer), samples).run(inputFor(invoicesApp));
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
  });
});

describe("the AI reviewer", () => {
  it("parses the reported findings and returns them as Finding[]", async () => {
    const model = scriptedLanguageModel(() => reported([
      {
        severity: "block",
        where: '<Text> labeled "Total: $12,480"',
        message: "the figure $12,480 is typed into the screen and appears in no tool response",
      },
      {
        severity: "warn",
        where: "document",
        message: "nothing here answers which invoices are overdue, which the ask named",
      },
    ]));

    const findings = await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

    expect(findings).toEqual([
      {
        severity: "block",
        where: '<Text> labeled "Total: $12,480"',
        message: "the figure $12,480 is typed into the screen and appears in no tool response",
      },
      {
        severity: "warn",
        where: "document",
        message: "nothing here answers which invoices are overdue, which the ask named",
      },
    ]);
  });

  it("sends ONE strict report_findings call carrying the request, the stored screen and the sample data", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      return reported([]);
    });

    await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp, "list my overdue invoices"));

    expect(calls).toHaveLength(1);
    const call = calls[0] as ScriptedModelCall;
    const tool = call.tools?.[0] as { name?: string; strict?: boolean; inputSchema?: unknown };
    expect(tool.name).toBe("report_findings");
    expect(tool.strict).toBe(true);
    const schema = tool.inputSchema as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        findings: {
          type: string;
          items: {
            additionalProperties: boolean;
            required: string[];
            properties: { severity: { enum: string[] }; message: { description: string } };
          };
        };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["findings"]);
    expect(schema.properties.findings.type).toBe("array");
    expect(schema.properties.findings.items.additionalProperties).toBe(false);
    // THE VERDICT IS WRITTEN LAST. This is the schema as the PROVIDER receives it
    // — the object the model is decoded against — so the key order asserted here
    // is the order that reaches the wire, and the order the finding is written in:
    // the locus and the evidence, and only then the grade for them.
    expect(schema.properties.findings.items.required).toEqual(["where", "message", "severity"]);
    expect(Object.keys(schema.properties.findings.items.properties))
      .toEqual(["where", "message", "severity"]);
    expect(schema.properties.findings.items.properties.severity.enum).toEqual(["block", "warn"]);
    // A TOOL DESCRIPTION IS PROMPT, and this one rides in the same call as the
    // rubric — it asked for "what is wrong AND the real alternative" for a while
    // after the rubric stopped, so the model was handed both charters at once.
    expect(schema.properties.findings.items.properties.message.description).not.toMatch(ADVISORY);

    const text = call.prompt.map((message) => typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.text ?? "").join("")).join("\n");
    // The ask, verbatim.
    expect(text).toContain("USER_REQUEST: list my overdue invoices");
    // The app as its author wrote it: the whole `app.tsx`, labelled and verbatim.
    expect(text).toContain(`APP (${SCREEN_FILE}):\n${invoicesApp}`);
    // The truth the literals are judged against.
    expect(text).toContain('invoices: {"data":[{"id":"inv_1","client":"Northwind","amountCents":99000}]}');
  });

  it("says nothing at all about an app that carries no screen", async () => {
    // The `document` fact check reports a document with nothing in it; the
    // reviewer stays quiet instead of judging rubble.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    const findings = await factReviewerCheck(deps(model), samples).run({
      document: { format: VENDO_APP_FORMAT, id: "app_reviewer_test", name: "Invoices", ui: "tree" },
      request: "show me my invoices",
    });

    expect(findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("returns no findings when the model says nothing and calls no tool", async () => {
    const model = scriptedLanguageModel("I have no comment on this app.");

    const findings = await factReviewerCheck(deps(model)).run(inputFor(invoicesApp));

    expect(findings).toEqual([]);
  });

  it("returns no findings when the model call throws, so a broken reviewer never crashes generation", async () => {
    const model = scriptedLanguageModel(() => { throw new Error("529 overloaded"); });

    const findings = await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

    expect(findings).toEqual([]);
  });

  it("flows its findings through createCheckingLayer alongside the fact checks", async () => {
    const model = scriptedLanguageModel(() => reported([{
      severity: "block",
      where: '<Button> labeled "Remind client"',
      message: 'the button is labelled "Remind client" and calls host_listInvoices, whose description is "Open invoices"',
    }]));
    const layer = createCheckingLayer({ checks: [reviewerCheck(deps(model), samples)] });

    // An app with no title: one fact finding, alongside whatever the reviewer says.
    const findings = await layer.run({
      document: { ...documentFrom(invoicesApp), name: "" },
      request: "show me my invoices",
    });

    expect(layer.checks.map(({ name }) => name)).toContain("reviewer");
    expect(findings).toContainEqual({
      severity: "block",
      where: '<Button> labeled "Remind client"',
      message: 'the button is labelled "Remind client" and calls host_listInvoices, whose description is "Open invoices"',
      check: "reviewer",
    });
    expect(findings.some(({ check, message }) =>
      check === "document" && message.includes('non-empty name="..."'))).toBe(true);
  });

  it("reads a caller's own rendering when it has a truer one than the stored screen", async () => {
    // `validate` holds the source AND what the queries really returned, so it
    // builds the block itself (`reviewComponentScreenInput`) — and what it hands
    // over is what the reviewer reads, with no second header bolted on.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples, [], "SCREEN AS THE CALLER RENDERED IT").run(inputFor(invoicesApp));

    const text = JSON.stringify(calls[0]?.prompt ?? "");
    expect(text).toContain("SCREEN AS THE CALLER RENDERED IT");
    expect(text).not.toContain(`APP (${SCREEN_FILE})`);
  });
});
