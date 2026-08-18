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
  message: "the button calls a tool that only reads invoices — it sends no reminder; drop it or say so honestly.",
};

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
  return { tool: "report_findings", input: { findings: reviewerFindings } };
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

  it("sends the prompt it always sent when the host set no rules", async () => {
    // Byte for byte: a deployment with no design rules must not pay a single
    // character for this seam.
    const runtime = setup();
    const appId = await storedApp(runtime);

    await runtime.validate({ appId }, ctx);

    expect(systemPrompts[0]).toBe(REVIEWER_SYSTEM);
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
