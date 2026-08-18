/**
 * The `validate` VERB runs the whole floor — blueprint §7.1 item 3.
 *
 * The door was built with `createCheckingLayer({ checks: config.checks })` and
 * nothing else, so it ran the deterministic document check and the host's own
 * plugged checks and SKIPPED the AI reviewer. `create` and `edit` ran it (via
 * `conductor.ts`'s `checkingFor`); the door did not. So the building-apps skill
 * teaches "validate after every edit — it is faster and surer than re-reading your
 * own work", and the thing it taught could not see invented data, dishonest tool
 * use, dead controls, dropped work, or a single one of the host's own judgment
 * rules. Half a checker answering "ok" is the worst lie a checker can tell.
 *
 * The reviewer stays FAIL-OPEN here, exactly as it is everywhere else: silence, a
 * refusal to call the tool, and a failed request all mean "no findings", and the
 * layer's crash guard degrades a throw to a `warn`. A reviewer that could not judge
 * must never be the reason a good app is refused — and must never turn a `validate`
 * into a tool error either, because an error reads to a model as "the tool is
 * broken" while findings read as "your document is wrong".
 */
import {
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type Check,
  type Finding,
} from "../../src/contract/index.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "../../src/server/index.js";
import { REVIEWER_SYSTEM } from "../../src/server/checking/reviewer-prompt.js";
import { authoringAssembler } from "../../src/server/testing/screen-assembler.js";
import { guardFixture } from "../../src/server/testing/guard-fixture.js";
import { memoryStore } from "../../src/server/testing/memory-store.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../../src/server/testing/scripted-model.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const APP_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Invoices() {
  return <Stack gap={12}><Text text="Invoices" variant="heading" /></Stack>;
}
`;

/** What no lookup can decide: the number on the card was typed, not read. */
const INVENTED_DATA: Finding = {
  severity: "block",
  where: 'node "n2" prop "text"',
  message: "the balance on the card is typed into the app rather than read from your account, so it is not your real balance.",
};

const DEAD_CONTROL: Finding = {
  severity: "warn",
  where: '<Button> labeled "Remind client"',
  message: "pressing the button calls a tool that only reads invoices; nothing on this screen sends a reminder.",
};

/** The host's own convention about a status, in the owner's own words. */
const PILL_RULE = "A status is a pill (EnumBadge), never a bare word.";

/** A screen that paints a status as a BARE WORD — which is the one thing the host
 *  rule below forbids, and which no mechanical check can know is wrong. */
const BARE_STATUS_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Invoices() {
  return (
    <Stack gap={12}>
      <Text text="Invoices" variant="heading" />
      <Text text="past_due" variant="body" />
    </Stack>
  );
}
`;

/** What the reviewer answers when it applies that rule: a `warn`, because the
 *  person can see it too — the two halves of a fact, the screen's own text and
 *  the rule it is read against, and no word about what to do instead. */
const BROKEN_CONVENTION: Finding = {
  severity: "warn",
  where: '<Text> reading "past_due"',
  message: 'the status renders as the bare word past_due, and this product\'s rule is "A status is a pill (EnumBadge), never a bare word".',
};

/** A screen whose only blemish is a matter of phrasing: a heading a reader with
 *  taste would have written as "Invoices". Nothing on it is wrong, and nobody
 *  using it is misled or blocked by a word. */
const WORDY_HEADING_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Invoices() {
  return <Stack gap={12}><Text text="Invoices list" variant="heading" /></Stack>;
}
`;

/** The finding an eager reviewer files about it: a rewording, priced at a repair
 *  round the person sits and waits through. */
const LABEL_NIT: Finding = {
  severity: "warn",
  where: '<Text> labeled "Invoices list"',
  message: 'the heading reads "Invoices list", and "Invoices" reads better',
};

/** The two halves of the charter's materiality bar the readers below apply: what
 *  clears it, and what it turns away. */
const MATERIAL_CONVENTION = "a displayed value breaking a rule this product's owner stated";
const POLISH_BAR = "anything you would call a polish suggestion";

/** A host's own JUDGMENT RULE, plugged in through a pack. It is not code: it is
 *  one sentence, and the reviewer is the only thing that can apply it. Without
 *  the reviewer, a `validate` could not enforce it at all. */
const HOUSE_RULE: Check = {
  name: "maple-house-rules",
  kind: "judgment",
  rule: "Never show a money figure without saying which account it came from.",
};

let reviewerFindings: Finding[] = [];
/** Every rubric the reviewer was actually sent, so a test can prove the host's
 *  own rule reached the model rather than merely being registered. */
let systemPrompts: string[] = [];
/** The other half of the same claim: what the reviewer was asked ABOUT, which is
 *  where the person's own ask lands (`USER_REQUEST:`). */
let userPrompts: string[] = [];
let reviewerCalls = 0;
let reviewerThrows = false;
let reviewerRefuses = false;
/** A reviewer that APPLIES the rubric it was just handed instead of answering a
 *  constant: it is given that rubric and decides what to report. Set it and
 *  `reviewerFindings` is ignored — which is what lets a test about the rubric's
 *  own words fail when those words go. */
let readsTheRubric: ((rubric: string) => Finding[]) | undefined;

/** The reviewer, and ONLY the reviewer: the app under test is landed by the
 *  assembler in the `screen` slot, so every model call this fixture sees is a
 *  `report_findings` call from the door under test. */
const model = () => scriptedLanguageModel((call: ScriptedModelCall) => {
  if (call.tools?.some(({ name }) => name === "report_findings") !== true) return APP_SCREEN;
  reviewerCalls += 1;
  // The system prompt arrives as the `system` role message in the normalized
  // prompt — the rubric the host's judgment rules are appended to.
  const textOf = (role: string): string => call.prompt
    .filter((message) => message.role === role)
    .map(({ content }) => (typeof content === "string"
      ? content
      : content.map(({ text }) => text ?? "").join("")))
    .join("\n");
  systemPrompts.push(textOf("system"));
  userPrompts.push(textOf("user"));
  if (reviewerThrows) throw new Error("the model gateway is down");
  // A refusal is the model answering in prose instead of calling the one tool it
  // was given — `strictToolCall` finds no call and reports nothing.
  if (reviewerRefuses) return "I would rather not judge this app.";
  const rubric = systemPrompts[systemPrompts.length - 1] ?? "";
  return { tool: "report_findings", input: { findings: readsTheRubric?.(rubric) ?? reviewerFindings } };
});

/** The host's own design rules, as composition hands them to every writer — a
 *  briefing pack, not a check. Nothing else in this fixture registers them, so a
 *  rule that shows up in the reviewer's rubric got there through the door. */
const briefingWith = (designRules: string): AppsConfig["briefing"] => async () => ({
  designRules,
  catalog: [],
  hostSemantics: "",
});

const setup = (
  checks?: readonly Check[],
  briefing?: AppsConfig["briefing"],
  screen = APP_SCREEN,
  /** The host surface, for a screen that reads one. Default: the empty registry
   *  above, which is every test whose screen fetches nothing. */
  registry: ToolRegistry = tools,
): AppsRuntime => {
  let runtime: AppsRuntime;
  runtime = createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools: registry,
    catalog: [],
    model: model(),
    screen: authoringAssembler(() => runtime, screen),
    ...(checks === undefined ? {} : { checks }),
    ...(briefing === undefined ? {} : { briefing }),
  });
  return runtime;
};

beforeEach(() => {
  reviewerFindings = [];
  systemPrompts = [];
  userPrompts = [];
  reviewerCalls = 0;
  reviewerThrows = false;
  reviewerRefuses = false;
  readsTheRubric = undefined;
});

/** A stored app to validate. Created with a clean reviewer so the create itself
 *  is never the thing that failed. */
const storedApp = async (runtime: ReturnType<typeof setup>): Promise<string> => {
  const created = await runtime.create({ prompt: "my invoices" }, ctx);
  reviewerCalls = 0;
  systemPrompts = [];
  userPrompts = [];
  return created.id;
};

describe("validate({ appId }) runs the AI reviewer, like create and edit do", () => {
  it("spends the reviewer's one call", async () => {
    const runtime = setup();
    const appId = await storedApp(runtime);

    await runtime.validate({ appId }, ctx);

    expect(reviewerCalls).toBe(1);
  });

  it("reports what no lookup could have decided", async () => {
    const runtime = setup();
    const appId = await storedApp(runtime);
    reviewerFindings = [INVENTED_DATA, DEAD_CONTROL];

    const result = await runtime.validate({ appId }, ctx);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({ ...INVENTED_DATA, check: "reviewer" });
    expect(result.findings).toContainEqual({ ...DEAD_CONTROL, check: "reviewer" });
  });

  it("keeps a warn out of the verdict — only a block means not ok", async () => {
    const runtime = setup();
    const appId = await storedApp(runtime);
    reviewerFindings = [DEAD_CONTROL];

    const result = await runtime.validate({ appId }, ctx);

    expect(result.findings).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("hands the reviewer the host's own judgment rules, so a pack rule is enforceable here too", async () => {
    const runtime = setup([HOUSE_RULE]);
    const appId = await storedApp(runtime);

    await runtime.validate({ appId }, ctx);

    expect(systemPrompts.join("\n")).toContain(HOUSE_RULE.rule);
  });
});

describe("the ask the reviewer judges against", () => {
  /** Two of the reviewer's five things — a section nobody asked for, work quietly
   *  dropped — are written against the person's own words, and this door used to
   *  pass `request: ""` on both paths. The rules were live text over an empty
   *  slot: nothing could ever break them, because nothing was ever asked for. */
  it("carries the person's ask into the reviewer's prompt", async () => {
    const runtime = setup();
    const appId = await storedApp(runtime);

    await runtime.validate({ appId, request: "show me unpaid invoices by month" }, ctx);

    expect(userPrompts[0] ?? "").toContain("USER_REQUEST: show me unpaid invoices by month");
  });

  it("reads exactly as it always did when the caller has no ask to hand over", async () => {
    // A bare verb call carries no user text, and that has to stay indistinguishable
    // from the door as it shipped — the threading is additive or it is a rewrite of
    // every check that reads `request`.
    const runtime = setup();
    const appId = await storedApp(runtime);

    await runtime.validate({ appId }, ctx);
    await runtime.validate({ appId, request: "" }, ctx);

    expect(userPrompts[0]).toBe(userPrompts[1]);
    expect(userPrompts[0] ?? "").toContain("USER_REQUEST: \n");
  });
});

/**
 * The reviewer used to judge a screen it could not see the SHAPE of: it read the
 * source, which says what the screen MIGHT draw, and knew nothing about the
 * surface — so a third table below a 900px fold and a step nobody reaches without
 * a click read to it exactly like content on the person's screen. The paint the
 * gauntlet already took (stage 4) was computed and thrown away on this very door.
 */
const BRANCHING_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Invoices() {
  const rows = ["Acme", "Globex", "Initech"];
  const confirming = false;
  return (
    <Stack gap={12}>
      <Text text="Invoices" variant="heading" />
      {rows.map((row) => <Text key={row} text={row} variant="body" />)}
      {confirming ? <Text text="Step two: confirm" variant="body" /> : null}
    </Stack>
  );
}
`;

describe("the surface the reviewer judges the screen on", () => {
  it("shows the reviewer what the screen really painted, framed by the pixels it paints into", async () => {
    const runtime = setup(undefined, undefined, BRANCHING_SCREEN);
    const appId = await storedApp(runtime);

    await runtime.validate({ appId, viewport: { width: 480, height: 900 } }, ctx);

    const prompt = userPrompts[0] ?? "";
    expect(prompt).toContain("PAINTED (what this screen really draws on first paint");
    // The frame, in the words the writer was given it in.
    expect(prompt).toContain("480×900 CSS pixels");
    expect(prompt).toContain("only the first 900px is on the person's screen");
    // The paint, in paint order, with what each node SAYS — a Kit component
    // carries its words in props, so an outline of names alone says nothing.
    expect(prompt).toContain(`Stack gap=12\n  Text text="Invoices" variant="heading"`);
    expect(prompt).toContain(`Text text="Acme" variant="body"`);
    // A run of siblings reads as three and a count, so a long list cannot crowd
    // the file it describes out of the prompt.
    expect(prompt).toContain("…and 1 more Text");
    // THE POINT: the branch the data did not take is in the FILE and not on the
    // screen, and only the paint can say so.
    expect(prompt).toContain("Step two: confirm");
    expect(prompt.slice(prompt.indexOf("PAINTED ("))).not.toContain("Step two: confirm");
  });

  it("sends the prompt it always sent when the caller does not know the surface", async () => {
    // Byte for byte: a deployment that cannot measure its surface must not pay a
    // single character for this seam, and must never be shown a frame nobody
    // measured.
    const runtime = setup(undefined, undefined, BRANCHING_SCREEN);
    const appId = await storedApp(runtime);

    await runtime.validate({ appId, request: "show me my invoices" }, ctx);

    expect(userPrompts[0]).toBe(
      `USER_REQUEST: show me my invoices\nSCREEN (the .tsx file this app renders):\n${BRANCHING_SCREEN}`,
    );
  });
});

describe("the host's own design rules are rubric lines, not just brief text", () => {
  /** They reached the WRITER (`HOST DESIGN RULES:` in the briefing pack) and
   *  stopped there, so the only thing enforcing them was the writer remembering
   *  them — while `rubricSection`'s "ALSO REJECT anything that breaks one of these
   *  rules" rendered over an empty list on every deployment. */
  it("hands the reviewer the rules the host wrote for its writers", async () => {
    const runtime = setup(undefined, briefingWith(
      "Dates are shown as `Aug 7`, never ISO.\n- Every money figure names its account.",
    ));
    const appId = await storedApp(runtime);

    await runtime.validate({ appId }, ctx);

    const rubric = systemPrompts[0] ?? "";
    expect(rubric).toContain("ALSO REJECT");
    expect(rubric).toContain("- Dates are shown as `Aug 7`, never ISO.");
    // The block's own markdown bullet is stripped, so the rubric's `- ` is not
    // doubled into a line that reads as a quotation of nothing.
    expect(rubric).toContain("- Every money figure names its account.");
    expect(rubric).not.toContain("- - Every money figure");
  });

  /**
   * …AND THE REVIEWER IS TOLD TO GRADE THE SCREEN AGAINST THEM.
   *
   * Handing over the rules was half of it. The rubric arrived under "ALSO REJECT",
   * which names no severity, while the prompt's own severity paragraph enumerates
   * the five things it was written for and stops — so a broken convention was
   * either not looked for at all or reported as a `block`, and a `block` on a font
   * or a date format throws away a screen that was otherwise right.
   *
   * Nothing on this path is stubbed but the verdict: the rule travels the real
   * briefing pack, the real door and the real prompt, the offending screen travels
   * the real gauntlet, and the finding travels the real checking layer back out.
   * There is no model in a test, so the scripted half is the ANSWER — and what this
   * pins is the pair a model needs to produce it, arriving in one call.
   */
  it("tells the reviewer to read the screen against those conventions, and to warn rather than block", async () => {
    const runtime = setup(undefined, briefingWith(PILL_RULE), BARE_STATUS_SCREEN);
    const appId = await storedApp(runtime);
    // A reader that files this finding only while the rubric carries BOTH halves it
    // needs: the owner's rule, and the materiality bar counting a broken one as
    // something a person is misled by. The bar came in to silence an eager
    // reviewer; take the convention out of what clears it and this goes red.
    readsTheRubric = (rubric) =>
      (rubric.includes(PILL_RULE) && rubric.includes(MATERIAL_CONVENTION) ? [BROKEN_CONVENTION] : []);

    const result = await runtime.validate({ appId, request: "show me my invoices" }, ctx);

    const rubric = systemPrompts[0] ?? "";
    // The owner's own sentence…
    expect(rubric).toContain(`- ${PILL_RULE}`);
    // …the instruction to judge the screen by it, at the severity that buys a fix…
    expect(rubric).toContain("READ THE SCREEN AGAINST THIS PRODUCT'S OWN CONVENTIONS");
    expect(rubric).toMatch(/visibly breaks[\s\S]*?"warn"/u);
    // …the bar that says a broken one is still worth the person's wait…
    expect(rubric).toContain(MATERIAL_CONVENTION);
    // …and in FACT form: the two halves are what the screen renders and what the
    // rule says, never what to render in its place. A finding reaches the repair
    // round as an order, so a remedy here is a remedy carried out.
    expect(rubric).toContain("what the screen renders, and what the rule says");
    // …and the screen that breaks it, in the same call.
    expect(userPrompts[0] ?? "").toContain('text="past_due"');
    // The finding comes back out of the door and does NOT kill the screen: `ok`
    // stays true on a warn, and the screen agent's repair round reads the findings
    // rather than the verdict (`vendo` screen-agent.ts `judgeScreen`), so a broken
    // convention is fixed instead of shipped.
    expect(result.ok).toBe(true);
    expect(result.findings).toContainEqual({ ...BROKEN_CONVENTION, check: "reviewer" });
  });

  it("sends the prompt it always sent when the host set no rules", async () => {
    // Byte for byte: a deployment with no design rules must not pay a single
    // character for this seam.
    const runtime = setup();
    const appId = await storedApp(runtime);

    await runtime.validate({ appId }, ctx);

    expect(systemPrompts[0]).toBe(REVIEWER_SYSTEM);
  });
});

/**
 * THE OTHER HALF OF THE SAME BAR. Everything above buys a fix; this buys nothing.
 * Every finding costs a repair round the person sits and waits through — the eager
 * reviewer moved the median 15s — so a true remark that changes nothing anyone can
 * feel is not worth the wait. The pair is deliberate: the convention test above
 * proves the bar does not silence a real one, and this proves it silences a nit,
 * and neither can pass by the bar going missing.
 */
describe("a finding has to be worth the repair round it buys", () => {
  it("stays silent about a rewording, and hands the screen back ok with nothing to repair", async () => {
    const runtime = setup(undefined, undefined, WORDY_HEADING_SCREEN);
    const appId = await storedApp(runtime);
    // A reviewer that WOULD file the nit, and stops only because the charter told
    // it not to. Take the bar out of the prompt and this test goes red with a
    // finding — which is the only way it can be about the bar at all.
    readsTheRubric = (rubric) => (rubric.includes(POLISH_BAR) ? [] : [LABEL_NIT]);

    const result = await runtime.validate({ appId, request: "show me my invoices" }, ctx);

    // The reviewer read the screen — this is silence, not a skipped call.
    expect(reviewerCalls).toBe(1);
    expect(userPrompts[0] ?? "").toContain('text="Invoices list"');
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("prices the bar in the charter's own words, next to what still clears it", async () => {
    const runtime = setup(undefined, undefined, WORDY_HEADING_SCREEN);
    const appId = await storedApp(runtime);

    await runtime.validate({ appId, request: "show me my invoices" }, ctx);

    const rubric = systemPrompts[0] ?? "";
    expect(rubric).toContain("If the screen would ship fine without the fix, it is not a finding");
    expect(rubric).toContain(POLISH_BAR);
    // The bar filters what gets said; it does not soften the verdict on what does.
    expect(rubric).toContain('Severity: "block" ONLY for what the person cannot detect themselves');
  });
});

describe("the reviewer can never be the reason a validate fails", () => {
  it("fails open on a refusal — no call, no findings, still ok", async () => {
    const runtime = setup();
    const appId = await storedApp(runtime);
    reviewerRefuses = true;

    const result = await runtime.validate({ appId }, ctx);

    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("fails open on a thrown request, and says so as a warn rather than a throw", async () => {
    const runtime = setup();
    const appId = await storedApp(runtime);
    reviewerThrows = true;

    const result = await runtime.validate({ appId }, ctx);

    // `strictToolCall` swallows its own failure, so this is silence rather than a
    // crash finding — either way the verdict stands and the door does not throw.
    expect(result.ok).toBe(true);
    expect(result.findings.filter(({ severity }) => severity === "block")).toEqual([]);
  });

  it("still reports the deterministic findings when the reviewer is silent", async () => {
    // A host's own FACT check: decided by lookup, with no model in the loop at
    // all. A silent reviewer must not carry it down with it. Armed only after the
    // create, because the same check on the floor would stop the create itself.
    let biting = false;
    const runtime = setup([{
      name: "maple-house-style",
      kind: "fact",
      run: async () => (biting ? [{ severity: "block", message: "the invoice total names no account." }] : []),
    }]);
    const appId = await storedApp(runtime);
    biting = true;
    reviewerRefuses = true;

    const result = await runtime.validate({ appId }, ctx);

    expect(result.ok).toBe(false);
    expect(result.findings.some(({ message }) => message.includes("names no account"))).toBe(true);
  });
});

/**
 * FETCHED, AND NEVER SHOWN — through the real door, end to end.
 *
 * The failure this closes shipped repeatedly: a tool returns rows carrying eight
 * fields, the screen paints three columns, and the two fields the person actually
 * came for (the commit message, the author) are fetched, thrown away, and never
 * missed — every mechanical check passes, because dropping a field is not a shape
 * error. Nothing in the pipeline computed "fetched minus painted", and both sides
 * were in the gauntlet's hands the whole time.
 *
 * Nothing is stubbed on either side of that seam: the real registry answers the
 * real query, the real gauntlet runs and paints the screen, and the only scripted
 * thing is the reviewer's verdict — so what this asserts is what the model is
 * really handed.
 */
const BUILDS_TOOL = "maple_list_builds";

const BUILDS_SCREEN = `import { DataTable, useQuery } from "@vendo/screen";

export default function Builds() {
  const builds = useQuery("${BUILDS_TOOL}");
  return <DataTable rows={builds.data} columns={["build_number", "status", "branch"]} />;
}
`;

const BUILD_ROWS = {
  data: [
    {
      id: "bld_412",
      build_number: 412,
      status: "passed",
      branch: "main",
      commit_message: "widen the reviewer's evidence",
      author: "ada",
      duration_ms: 91_000,
    },
  ],
};

const buildsDescriptor: ToolDescriptor = {
  name: BUILDS_TOOL,
  title: "Recent builds",
  description: "The last builds on this repo",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
};

const buildsRegistry: ToolRegistry = {
  async descriptors() { return [buildsDescriptor]; },
  async execute() { return { status: "ok", output: BUILD_ROWS }; },
};

describe("what the screen fetched and never showed", () => {
  it("hands the reviewer the leftovers, with the rule that tells it what to do with them", async () => {
    const runtime = setup(undefined, undefined, BUILDS_SCREEN, buildsRegistry);
    const appId = await storedApp(runtime);

    // NO viewport: what a paint left unshown is true at every size, so this must
    // not wait for a caller that measured its surface.
    await runtime.validate({ appId, request: "show me the last builds" }, ctx);

    const prompt = userPrompts[0] ?? "";
    expect(prompt).not.toContain("PAINTED (");
    const leftovers = prompt.slice(prompt.indexOf("LEFTOVERS ("));
    expect(leftovers).toContain("LEFTOVERS (fields these queries returned that the screen never shows");
    // The two the person came for, each with one real value beside it.
    expect(leftovers).toContain(`commit_message ("widen the reviewer's evidence")`);
    expect(leftovers).toContain(`author ("ada")`);
    // …and not the three the table draws: a column key is how a Kit table says
    // which field it shows, even though no row value is ever written as text.
    expect(leftovers).not.toContain("build_number");
    expect(leftovers).not.toContain("branch");
    // The other half of the same claim: the rubric that arrived in the SAME call
    // tells the reviewer what a leftover is and who decides.
    expect(systemPrompts[0] ?? "").toContain("FETCHED AND NEVER SHOWN IS THE SAME DROP.");
  }, 60_000);
});

/**
 * NAMED IN THE ASK, AND NOWHERE ON THE SCREEN — through the real door, end to end.
 *
 * The largest cluster in run 2026-08-18T21-39-10, 11 cases: a screen better than
 * the one before it in every other way, missing one noun the person named — a field
 * on a team form, an owner's name beside a row, their own reason echoed back.
 *
 * LEFTOVERS cannot reach this one, which is the whole point of the fixture: the
 * dropped noun was never FETCHED, so every field the query returned is on the
 * screen and the mechanical half has nothing to say. The only reader that can catch
 * it is one walking the person's own words, and the only thing that can stop it is
 * the materiality bar mistaking a small noun for a nit — so both clauses are keyed
 * on here, and the case below it pins the bar still working in the other direction.
 */
const INVOICES_TOOL = "maple_list_invoices";

const OWNER_ASK = "list my open invoices with the amount and the owner on each row";

const OWNERLESS_SCREEN = `import { DataTable, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("${INVOICES_TOOL}");
  return <DataTable rows={invoices.data} columns={["client", "amount"]} />;
}
`;

const INVOICE_ROWS = { data: [{ id: "inv_7", client: "Northwind", amount: 990 }] };

const invoicesRegistry: ToolRegistry = {
  async descriptors() {
    return [{
      name: INVOICES_TOOL,
      title: "Open invoices",
      description: "The invoices still owed on this account",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    }];
  },
  async execute() { return { status: "ok", output: INVOICE_ROWS }; },
};

/** The two clauses the walk needs to survive its own bar: the walk itself, down to
 *  a noun smaller than a deliverable, and the ruling that the person naming it IS
 *  the materiality. */
const ASK_WALK = "WALK THE ASK'S NAMED ELEMENTS ONE BY ONE";
const ASK_NAMED_MATERIAL = "AN ELEMENT THE ASK NAMED IS MATERIAL BY DEFINITION";
/** …and what keeps the widened walk from reporting every absent field: a leftover
 *  nobody asked about is nobody's finding. */
const ID_IS_NOT_A_DROP = "an internal id, a foreign key, or a flag nothing here turns on is not";

const MISSING_OWNER: Finding = {
  severity: "warn",
  where: "<DataTable>",
  message: 'the ask names the owner on each row; the table draws client and amount, and no query on this screen returns an owner.',
};

const UNSHOWN_ID: Finding = {
  severity: "warn",
  where: "<DataTable>",
  message: "the rows carry an id and the table does not draw it",
};

describe("a noun the ask named and the screen never shows", () => {
  it("reports it, on a screen whose leftovers say nothing at all about it", async () => {
    const runtime = setup(undefined, undefined, OWNERLESS_SCREEN, invoicesRegistry);
    const appId = await storedApp(runtime);
    // A reader that files it only while the rubric carries BOTH halves: take either
    // the walk or its materiality out and this goes red — which is the only way the
    // test can be about the rubric rather than about a scripted constant.
    readsTheRubric = (rubric) =>
      (rubric.includes(ASK_WALK) && rubric.includes(ASK_NAMED_MATERIAL) ? [MISSING_OWNER] : []);

    const result = await runtime.validate({ appId, request: OWNER_ASK }, ctx);

    const prompt = userPrompts[0] ?? "";
    // The person's own words, and the screen that answers all but one of them.
    expect(prompt).toContain(`USER_REQUEST: ${OWNER_ASK}`);
    expect(prompt).toContain('columns={["client", "amount"]}');
    // THE POINT: the mechanical half never sees this drop. `owner` is in the ask and
    // in nothing else — no query returns it, so no leftover can name it.
    expect(prompt.slice(prompt.indexOf("SCREEN ("))).not.toContain("owner");
    // A warn, so the screen is repaired rather than thrown away.
    expect(result.ok).toBe(true);
    expect(result.findings).toContainEqual({ ...MISSING_OWNER, check: "reviewer" });
  }, 60_000);

  it("stays silent about a field the ask never named, so the wider walk is still a walk of the ASK", async () => {
    // THE OTHER DIRECTION OF THE SAME PAIR. Widening (5) from deliverables to nouns
    // must not turn every unshown field into a repair round: the id these rows carry
    // is a real leftover, it reaches the reviewer as one, and nobody asked for it.
    const runtime = setup(undefined, undefined, OWNERLESS_SCREEN, invoicesRegistry);
    const appId = await storedApp(runtime);
    readsTheRubric = (rubric) => (rubric.includes(ID_IS_NOT_A_DROP) ? [] : [UNSHOWN_ID]);

    const result = await runtime.validate({ appId, request: OWNER_ASK }, ctx);

    // The reviewer read it — this is silence, not a skipped call — and it was really
    // shown the id it stayed quiet about.
    expect(reviewerCalls).toBe(1);
    const prompt = userPrompts[0] ?? "";
    expect(prompt.slice(prompt.indexOf("LEFTOVERS ("))).toContain(`id ("inv_7")`);
    expect(result).toEqual({ ok: true, findings: [] });
  }, 60_000);
});
