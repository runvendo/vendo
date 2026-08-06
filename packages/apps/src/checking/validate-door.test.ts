/**
 * The `validate` VERB runs the whole floor — blueprint §7.1 item 3.
 *
 * The door was built with `createCheckingLayer({ deps, checks: config.checks })`
 * and nothing else, so it ran the seven deterministic fact checks and the host's
 * own plugged checks and SKIPPED the AI reviewer. `create` and `edit` ran it (via
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
  type Check,
  type Finding,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApps } from "../index.js";
import {
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  type ScriptedModelCall,
} from "../testing/index.js";

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

const APP_WIRE = '<App name="Invoices"><Text text="Invoices"/><Disclaimer reason="Scripted fixture app."/></App>';

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
let reviewerCalls = 0;
let reviewerThrows = false;
let reviewerRefuses = false;

const model = () => scriptedLanguageModel((call: ScriptedModelCall) => {
  if (call.tools?.some(({ name }) => name === "report_findings") !== true) return APP_WIRE;
  reviewerCalls += 1;
  // The system prompt arrives as the `system` role message in the normalized
  // prompt — the rubric the host's judgment rules are appended to.
  systemPrompts.push(call.prompt
    .filter(({ role }) => role === "system")
    .map(({ content }) => (typeof content === "string"
      ? content
      : content.map(({ text }) => text ?? "").join("")))
    .join("\n"));
  if (reviewerThrows) throw new Error("the model gateway is down");
  // A refusal is the model answering in prose instead of calling the one tool it
  // was given — `strictToolCall` finds no call and reports nothing.
  if (reviewerRefuses) return "I would rather not judge this app.";
  return { tool: "report_findings", input: { findings: reviewerFindings } };
});

const setup = (checks?: readonly Check[]) => createApps({
  store: memoryStore(),
  guard: guardFixture(),
  tools,
  catalog: [],
  model: model(),
  ...(checks === undefined ? {} : { checks }),
});

beforeEach(() => {
  reviewerFindings = [];
  systemPrompts = [];
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
    const runtime = setup();
    const appId = await storedApp(runtime);
    reviewerRefuses = true;

    // A document whose name is gone: a fact, decided by lookup, with no model in
    // the loop at all.
    const result = await runtime.validate(
      { document: '<App name=""><Text text="hi"/></App>' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.findings.some(({ message }) => message.includes("name"))).toBe(true);
  });
});
