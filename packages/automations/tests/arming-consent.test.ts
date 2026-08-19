/**
 * 07 §3 — arming covers the WHOLE job, and one yes is what pays for it.
 *
 * The incident behind every case here (2026-08-18, production Maple): a user
 * armed "check my checking balance every 15 minutes and text me" over iMessage,
 * their YES to the job landed, and arming then minted FOUR MORE per-tool asks —
 * `vendo_text_me`, `vendo_knowledge_search`, `request_connection`,
 * `list_connections`. Three of those are read-grade tools a live chat runs
 * without asking anybody, and the fourth was literally in the sentence they
 * typed. Consent was framed per-tool while the person was thinking per-job.
 *
 * What that did NOT change is the SURFACE. An automation runs on captured
 * grants, so everything it may touch away still has to be granted at arming or
 * the firing meets a permission nobody holds — the surface here is as wide as it
 * has always been, minus only the two kinds a standing grant could never satisfy.
 * What changed is what a person is made to DO about it: the whole surface is
 * named once, on the arming ask, and one yes mints all of it.
 *
 * The harness (descriptors, `ctx`, `create`, `GuardDouble`, `registry`, `flush`)
 * is engine.test.ts's, verbatim; only the optional seams no case here scripts are
 * left out, and `policyOutcome` is added as one more scripted-per-test seam
 * beside the ones the double already carries.
 */
import {
  serviceToolSlug,
  USE_SERVICE_TOOL,
  type ApprovalId,
  type AutomationRecord,
  type CreateAutomationInput,
  type Guard,
  type GuardDecision,
  type RiskLabel,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { beforeEach, describe, expect, it } from "vitest";
import {
  automationsInternals,
  createAutomations,
  powerTitles,
  READ_ONLY_POWER,
  type AutomationsEngine,
} from "../src/index.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");

const readTool: ToolDescriptor = {
  name: "read_data",
  description: "Read data",
  inputSchema: { type: "object" },
  risk: "read",
};

const writeTool: ToolDescriptor = {
  name: "write_data",
  description: "Write data",
  inputSchema: { type: "object" },
  risk: "write",
};

/** Destructive and NOTHING else. `criticalTool` in engine.test.ts is destructive
 *  AND `confirmEach`, which cannot tell the two filters apart — and telling them
 *  apart is the whole point of the pair of cases below. */
const wipeTool: ToolDescriptor = {
  name: "wipe_data",
  description: "Wipe data",
  inputSchema: { type: "object" },
  risk: "destructive",
};

/** `confirmEach` on a WRITE, so severity is not what drops it: only governance
 *  (05 §2 — a person, every time, and no grant may suppress it) is. */
const signTool: ToolDescriptor = {
  name: "sign_off",
  description: "Sign something off",
  inputSchema: { type: "object" },
  risk: "write",
  confirmEach: true,
};

/** The connector dispatcher, `ungraded` by construction: its real grade arrives
 *  per SLUG through the risk resolver, never off this label. */
const dispatcher: ToolDescriptor = {
  name: USE_SERVICE_TOOL,
  description: "Use a connected service's tool",
  inputSchema: { type: "object" },
  risk: "ungraded",
};

/** The two authoring calls the armedBy gate turns on. `vendo_automate` is
 *  write-graded, so an asks-on-writes policy asked a person about it — the call
 *  reaching enable() at all is that person's yes. `vendo_make` is read-graded, so
 *  the same policy RAN it and nobody was asked anything. */
const automateTool: ToolDescriptor = {
  name: "vendo_automate",
  description: "Arm an automation",
  inputSchema: { type: "object" },
  risk: "write",
};

const makeTool: ToolDescriptor = {
  name: "vendo_make",
  description: "Build a screen",
  inputSchema: { type: "object" },
  risk: "read",
};

const ctx = (subject = "user_a"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** The ONE create op, with this suite's defaults: a code-authored record the
 *  calling ctx speaks for. There is no public create — every authoring door
 *  goes through `automationsInternals`, so the tests do too. */
const create = async (
  engine: AutomationsEngine,
  input: Omit<CreateAutomationInput, "owner" | "authoredBy"> & Partial<CreateAutomationInput>,
  runCtx: RunContext = ctx(),
): Promise<AutomationRecord> =>
  await automationsInternals(engine).create(
    { owner: runCtx.principal, authoredBy: "code", ...input },
    runCtx,
  );

class GuardDouble implements Guard {
  /** The optional policy probe, scripted. Left unset by default because a guard
   *  that cannot answer is read as "nobody was asked" — the conservative answer,
   *  and the last case of the armedBy gate below. */
  policyOutcome?: (
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ) => Promise<GuardDecision["action"]>;
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }

  async report(): Promise<void> {}

  async directions(): Promise<string[]> { return []; }

  onApprovalDecision(callback: (id: ApprovalId, approved: boolean) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  decide(id: string, approved: boolean): void {
    for (const callback of this.callbacks) callback(id, approved);
  }
}

const registry = (
  descriptors: ToolDescriptor[] = [],
  execute: (call: ToolCall, runCtx: RunContext) => Promise<ToolOutcome> = async () => ({ status: "ok", output: {} }),
): ToolRegistry => ({
  async descriptors() { return descriptors; },
  execute,
});

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/** A host policy that asks about exactly these grades and runs everything else.
 *  It is consulted about ONE call — the one that armed the automation — and
 *  never about the surface: the surface is the law's business, not policy's. */
const asksOn = (...risks: RiskLabel[]) =>
  async (_call: ToolCall, descriptor: ToolDescriptor): Promise<GuardDecision["action"]> =>
    risks.includes(descriptor.risk) ? "ask" : "run";

const tools = (result: { records: Array<{ data: unknown }> }): unknown[] =>
  result.records.map((row) => (row.data as { tool: string }).tool);

describe("what arming covers: everything but what a standing grant could not satisfy", () => {
  let store: StoreAdapter;

  beforeEach(() => {
    store = memoryStoreAdapter();
  });

  /**
   * The STEPS branch of the destructive filter, which is the branch that did not
   * exist before: only the goal path narrowed its candidates, so a steps record
   * that DECLARED a destructive tool got a standing-grant ask for it — an ask
   * promising authority the guard refuses away no matter what is granted. A card
   * that lies, and a grant row nobody can spend.
   */
  it("never names a destructive tool a STEPS record declares, and mints no standing grant for it", async () => {
    const guard = new GuardDouble();
    const engine = createAutomations({
      tools: registry([writeTool, wipeTool]), guard, store, now: () => NOW,
    });
    const record = await create(engine, {
      id: "atm_steps_destructive",
      when: { event: "go" },
      task: { kind: "steps", steps: [
        { id: "write", tool: writeTool.name },
        { id: "wipe", tool: wipeTool.name },
      ] },
    });

    const { missing } = await engine.enable(record.id, ctx());

    expect(missing.map(({ call }) => call.tool)).toEqual([writeTool.name]);

    guard.decide(missing[0]!.id, true);
    await flush();

    // …and the only standing grant this consent moment can ever mint is the
    // write's: with nothing named for the wipe there is no ask to answer yes to.
    expect(tools(await store.records("vendo_grants").list())).toEqual([writeTool.name]);
  });

  /**
   * The CONNECTOR SLUG branch of the same filter, and the reason the surface is
   * graded through `withResolvedRisk` at all: the authored dispatcher is
   * `ungraded`, and the real grade arrives per slug from the broker through the
   * resolver. The send surviving is what proves the resolver ran — the authored
   * `ungraded` would have dropped BOTH steps — and the delete is gone on its
   * RESOLVED grade, which the authored label never mentions.
   */
  it("never names a connector slug the risk resolver grades destructive, whatever the dispatcher's own label says", async () => {
    const guard = new GuardDouble();
    const engine = createAutomations({
      tools: registry([dispatcher]),
      guard,
      store,
      now: () => NOW,
      resolveRisk: async (call) => serviceToolSlug(call) === "GMAIL_DELETE_MESSAGE" ? "destructive" : "write",
    });
    const record = await create(engine, {
      id: "atm_slug_destructive",
      when: { event: "go" },
      task: { kind: "steps", steps: [
        { id: "send", tool: USE_SERVICE_TOOL, args: { slug: "'GMAIL_SEND_EMAIL'" } },
        { id: "delete", tool: USE_SERVICE_TOOL, args: { slug: "'GMAIL_DELETE_MESSAGE'" } },
      ] },
    });

    const { missing } = await engine.enable(record.id, ctx());

    expect(missing.map(({ call }) => serviceToolSlug(call))).toEqual(["GMAIL_SEND_EMAIL"]);
    // The card states the grade the call will really run under, not `ungraded`.
    expect(missing[0]?.descriptor.risk).toBe("write");

    guard.decide(missing[0]!.id, true);
    await flush();

    const grants = (await store.records("vendo_grants").list()).records;
    expect(grants).toHaveLength(1);
    // Keyed on the SLUG: one name stands in for a whole third-party catalog, so
    // a tool-wide grant here would be consent to all of it behind one card.
    expect(grants[0]?.data).toMatchObject({
      tool: USE_SERVICE_TOOL,
      scope: { kind: "service-tool", slug: "GMAIL_SEND_EMAIL" },
    });
  });

  /** Governance, not severity — which is why this tool is write-graded, so the
   *  destructive filter is provably not what drops it. `confirmEach` needs a
   *  person EVERY time and no grant may suppress it (05 §2), so a standing power
   *  for one is dead on arrival: naming it would be a card promising something
   *  the run will not honour. */
  it("never names a confirmEach tool, though it is otherwise an ordinary write", async () => {
    const guard = new GuardDouble();
    const engine = createAutomations({
      tools: registry([writeTool, signTool]), guard, store, now: () => NOW,
    });
    const record = await create(engine, {
      id: "atm_confirm_each",
      when: { event: "go" },
      task: { kind: "steps", steps: [
        { id: "write", tool: writeTool.name },
        { id: "sign", tool: signTool.name },
      ] },
    });

    const { missing } = await engine.enable(record.id, ctx());

    expect(missing.map(({ call }) => call.tool)).toEqual([writeTool.name]);

    guard.decide(missing[0]!.id, true);
    await flush();

    expect(tools(await store.records("vendo_grants").list())).toEqual([writeTool.name]);
  });
});

/**
 * The armedBy gate: ONE yes, or none.
 *
 * The arming ask is the guard's own ask about the AUTHORING call, and it names
 * the powers before anything is armed. So a call the policy would ask about
 * reaching enable() at all is proof a person answered that ask yes — and that
 * yes is what licenses minting the standing powers on the spot, with no second
 * per-tool ceremony. A call the policy RUNS proves nothing, and minting off it
 * would be a silent consent regression in the other direction.
 *
 * Same record, same policy, four doors — only the arming call differs.
 */
describe("the armedBy gate", () => {
  const ID = "atm_armed_by";
  let store: StoreAdapter;
  let guard: GuardDouble;
  let engine: AutomationsEngine;

  beforeEach(async () => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
    guard.policyOutcome = asksOn("write");
    engine = createAutomations({
      tools: registry([readTool, writeTool, automateTool, makeTool]), guard, store, now: () => NOW,
    });
    await create(engine, {
      id: ID,
      when: "*/15 * * * *",
      task: { kind: "steps", steps: [
        { id: "read", tool: readTool.name },
        { id: "write", tool: writeTool.name },
      ] },
    });
  });

  const armedBy = (tool: string): ToolCall => ({ id: `call_${tool}`, tool, args: {} });

  /**
   * THE case, and the whole reshape in one assertion: the yes covers the JOB, so
   * BOTH powers are live standing grants the instant arming returns — the read
   * included. Naming the read separately is what the person on Maple was made to
   * do four extra times, three of them for reads a live chat never asks about.
   *
   * Liveness is read back through the engine's own grant lookup rather than off
   * the row: a second arming finds every power already held and asks nothing, so
   * the rows are grants the firing will actually accept, not just rows that look
   * like grants.
   */
  it("mints the WHOLE surface — the read as well as the write — when the arming call is one policy ASKED about", async () => {
    const result = await engine.enable(ID, ctx(), { armedBy: armedBy(automateTool.name) });

    // Nothing left for any surface to chase: the person already answered.
    expect(result.missing).toEqual([]);
    const grants = (await store.records("vendo_grants").list()).records;
    // Sorted: which order a store hands its rows back in is the store's business,
    // and the claim here is that BOTH powers are held, not that they were written
    // in surface order.
    expect(tools({ records: grants }).sort()).toEqual([readTool.name, writeTool.name]);
    for (const grant of grants) {
      expect(grant.data).toMatchObject({
        subject: "user_a",
        scope: { kind: "tool" },
        duration: "standing",
        source: "automation",
        automationId: ID,
      });
    }
    // No pending ask and no capture row — those are what the incident's four
    // extra cards were made of.
    expect((await store.records("automations:captures").list()).records).toEqual([]);
    expect((await store.records("vendo_approvals").list()).records).toEqual([]);

    const again = await engine.enable(ID, ctx());

    expect(again.missing).toEqual([]);
    expect((await store.records("vendo_grants").list()).records).toHaveLength(2);
  });

  /** `vendo_make` is read-graded — it arms the schedule half of "build me the
   *  board and refresh it every Monday" — so under this policy it runs unasked.
   *  Minting standing away powers off a call nobody was asked about would be the
   *  silent regression in the other direction; the per-tool captures stay, and
   *  the set ask delivers them. */
  it("mints nothing and parks one ask per power when the arming call is one policy RUNS", async () => {
    const result = await engine.enable(ID, ctx(), { armedBy: armedBy(makeTool.name) });

    expect(result.missing.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    expect((await store.records("vendo_grants").list()).records).toEqual([]);
    expect((await store.records("automations:captures").get(result.missing[0]!.id))?.data)
      .toMatchObject({ automationId: ID, subject: "user_a", tool: readTool.name });
    expect((await store.records("automations:captures").get(result.missing[1]!.id))?.data)
      .toMatchObject({ automationId: ID, subject: "user_a", tool: writeTool.name });
  });

  /** The wire's own turn-it-on route passes no `armedBy` at all, and an absent
   *  arming call can never be read as an answered one. */
  it("mints nothing and parks one ask per power when nothing armed it", async () => {
    const result = await engine.enable(ID, ctx());

    expect(result.missing.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    expect((await store.records("vendo_grants").list()).records).toEqual([]);
    expect((await store.records("automations:captures").list()).records).toHaveLength(2);
  });

  /** The safe fallback for a host's custom Guard: a guard that cannot say what
   *  its policy would do is read as "nobody was asked", so the powers fall back
   *  to pending asks — exactly the behaviour that predates the gate. A guard that
   *  cannot answer must never be read as a guard that said yes on someone's
   *  behalf. */
  it("mints nothing when the guard has no policyOutcome to say whether anybody was asked", async () => {
    const silent = new GuardDouble();
    const other = createAutomations({
      tools: registry([readTool, writeTool, automateTool, makeTool]), guard: silent, store, now: () => NOW,
    });

    const result = await other.enable(ID, ctx(), { armedBy: armedBy(automateTool.name) });

    expect(result.missing.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    expect((await store.records("vendo_grants").list()).records).toEqual([]);
    expect((await store.records("automations:captures").list()).records).toHaveLength(2);
  });
});

/**
 * How the surface READS once it is all named at once.
 *
 * Naming every power on one card is only an improvement if the card is
 * readable: the incident's wall of four tool identifiers is not fixed by
 * printing all of them together. Writes are the part a person can act on, so
 * they keep a line each; reads are the bulk and the least interesting thing
 * about any automation, so they collapse into one phrase about the account
 * rather than a list of identifiers nobody asked for.
 */
describe("powerTitles", () => {
  const power = (descriptor: { name: string; title?: string; risk: string }) => ({ descriptor });

  it("names each write by its title and folds every read into one trailing phrase", () => {
    const titles = powerTitles([
      power({ ...readTool, title: "Read your balances" }),
      power({ ...writeTool, title: "Send you a text" }),
      power({ ...readTool, name: "read_more", title: "Search your knowledge" }),
      power({ ...signTool, title: "Sign a document" }),
    ]);

    // The read phrase is LAST and appears exactly once however many reads there
    // are: it is the closing "…and it can see your data", not an item competing
    // with the actions for the person's attention.
    expect(titles).toEqual(["Send you a text", "Sign a document", READ_ONLY_POWER]);
    expect(titles.at(-1)).toBe(READ_ONLY_POWER);
    expect(titles.filter((title) => title === READ_ONLY_POWER)).toHaveLength(1);
    // Design §3's voice law: an identifier on a consent card is the engine
    // talking to itself in front of a person who cannot act on it.
    expect(titles.join(" ")).not.toContain("_");
  });

  it("says only the read phrase when everything the automation holds is a read", () => {
    expect(powerTitles([
      power({ ...readTool, title: "Read your balances" }),
      power({ ...readTool, name: "read_more", title: "Search your knowledge" }),
    ])).toEqual([READ_ONLY_POWER]);
  });

  /** The other end: an automation that only acts must not be told it can also
   *  see things. The phrase is claim about the surface, so it is only true when
   *  a read is actually in it. */
  it("never says the read phrase when the surface holds no read at all", () => {
    expect(powerTitles([power({ ...writeTool, title: "Send you a text" })]))
      .toEqual(["Send you a text"]);
    expect(powerTitles([])).toEqual([]);
  });

  /** Titles, never identifiers — but a descriptor with no title still has to
   *  render as something, and the name is the same fallback every other consent
   *  surface makes. Silently dropping the power would be worse than an ugly one. */
  it("falls back to the tool's own name when a write has no title", () => {
    expect(powerTitles([power(writeTool)])).toEqual([writeTool.name]);
  });
});
