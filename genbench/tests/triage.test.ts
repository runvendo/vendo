/**
 * The stage that decides what is even a CLAIM.
 *
 * The extraction is deliberately blind — it cuts every digit group out of the
 * screen's text, because a rule for what "looks like data" is a rule a fabricated
 * number can be written to satisfy. That leaves tokens no honest program could
 * ever return: the `2444` inside a job id, a clock time, an axis tick. A model
 * sorts those, because deciding what a number MEANS is the job that needs the
 * screen around it.
 *
 * It can only ever WAIVE, and only on the record. So what is pinned here is the
 * fail-closed half: everything it does not explicitly waive, with a reason, is
 * checked — and a triage that cannot be reached waives nothing at all.
 *
 * The model boundary is the only double; the contract, the batching and the
 * fail-closed rules are the real ones.
 */
import { MockLanguageModelV3 } from "ai/test";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUDITOR_CONTRACT } from "../src/audit.js";
import { MAX_OUTPUT_TOKENS_FLOOR } from "../src/meter.js";
import { triage, TRIAGE_PROMPT, TriageContract } from "../src/triage.js";

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const answering = (decisions: Array<{ claim: boolean; why?: string }>): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ decisions }) }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  });

const SCREEN = "Job J-2444 · started 12:45 · quoted $13,200.00";

/** Where a token actually sits on SCREEN. Every stage below the extraction
 *  judges an OCCURRENCE, so a test names one by its offset rather than by its
 *  characters — two tokens can share characters and never share a verdict. */
const at = (text: string): number => SCREEN.indexOf(text);
const token = (text: string) => ({ text, at: at(text) });

/** SCREEN is shorter than the context window, so every token's surroundings are
 *  the whole line. */
const WHERE = SCREEN;

describe("the triage", () => {
  it("answers one decision per token, in the order it was asked", async () => {
    const model = answering([
      { claim: false, why: "the hour on a clock" },
      { claim: true, why: "the quote for this job" },
    ]);

    const sorted = await triage({ tokens: [token("12"), token("$13,200.00")], visibleText: SCREEN }, { model });

    expect(sorted.decisions).toEqual([
      { text: "12", at: at("12"), claim: false, why: "the hour on a clock", where: WHERE },
      { text: "$13,200.00", at: at("$13,200.00"), claim: true, why: "the quote for this job", where: WHERE },
    ]);
    expect(sorted.degraded).toBeUndefined();
    expect(sorted.usage.calls).toBe(1);
  });

  /** A bare number means nothing on its own — the same digits are a job id on one
   *  screen and a total on the next — so the screen around it is what the model
   *  is actually shown. */
  it("shows the model where on the screen each token appeared", async () => {
    const model = answering([{ claim: true, why: "the quote for this job" }]);

    await triage({ tokens: [token("$13,200.00")], visibleText: SCREEN }, { model });

    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(sent).toContain("$13,200.00");
    expect(sent).toContain("where it appears");
    expect(sent).toContain("started 12:45");
  });

  it("sorts a whole screen in ONE call", async () => {
    const model = answering([{ claim: false, why: "an id" }, { claim: false, why: "a clock" }, { claim: true, why: "a total" }]);

    await triage({ tokens: [token("J-2444"), token("12"), token("$13,200.00")], visibleText: SCREEN }, { model });

    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("calls nobody when nothing survived the verbatim clearing", async () => {
    const model = answering([]);

    const sorted = await triage({ tokens: [], visibleText: SCREEN }, { model });

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(sorted.decisions).toEqual([]);
    expect(sorted.usage.calls).toBe(0);
  });
});

/**
 * Fail-closed, in every direction. A waiver is the one thing this stage can do,
 * so anything short of an explicit, reasoned waiver has to leave the token where
 * it was: in front of the auditor.
 */
/**
 * The stage made ONE attempt with the SDK's own retries off, so a single 529 —
 * our own infrastructure having an afternoon — became "nothing was sorted", and
 * every clock time and axis tick on the screen then went to the auditor as a
 * claim it could not derive. A provider hiccup was reported as the contender
 * fabricating data. The judge has ridden this out with three attempts and a
 * backoff since it was written; this is the same pattern, in the same shape.
 */
describe("retry", () => {
  it("rides out a rate limit and comes back with the real decisions", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("529 Overloaded");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ decisions: [{ claim: false, why: "a clock" }] }) }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: ZERO_USAGE,
          warnings: [],
        };
      },
    });

    const slept: number[] = [];
    const sorted = await triage(
      { tokens: [token("12")], visibleText: SCREEN },
      {
        model,
        delayMs: (attempt) => {
          slept.push(attempt);
          return 0;
        },
      },
    );

    expect(attempts).toBe(2);
    expect(sorted.degraded).toBeUndefined();
    expect(sorted.decisions[0]).toMatchObject({ claim: false, why: "a clock" });
    // A transient error is the only kind that earns a wait.
    expect(slept).toEqual([0]);
  });

  it("gives up after three attempts and waives nothing", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        attempts += 1;
        throw new Error("503 Service Unavailable");
      },
    });

    const sorted = await triage({ tokens: [token("12")], visibleText: SCREEN }, { model, delayMs: () => 0 });

    expect(attempts).toBe(3);
    expect(sorted.degraded).toBe(true);
    expect(sorted.decisions[0]).toMatchObject({ claim: true });
  });

  /** Contenders get an output ceiling through the meter; the graders had none,
   *  so a truncated answer failed `decisions.length !== tokens.length` and the
   *  whole screen degraded on our own default. */
  it("asks for the same output ceiling the contenders are given", async () => {
    const model = answering([{ claim: true, why: "a total" }]);
    await triage({ tokens: [token("$13,200.00")], visibleText: SCREEN }, { model });

    expect(model.doGenerateCalls[0]!.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS_FLOOR);
  });
});

describe("fail-closed", () => {
  it("treats every token as a claim when the triage cannot be reached", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("503 Service Unavailable");
      },
    });

    const sorted = await triage(
      { tokens: [token("12"), token("$13,200.00")], visibleText: SCREEN },
      { model, delayMs: () => 0 },
    );

    expect(sorted.degraded).toBe(true);
    expect(sorted.error).toContain("503");
    expect(sorted.decisions.map((decision) => decision.claim)).toEqual([true, true]);
  });

  it("gives up on a request that never answers, so the case is still written", async () => {
    const model = new MockLanguageModelV3({ doGenerate: () => new Promise(() => undefined) });

    const sorted = await triage({ tokens: [token("12")], visibleText: SCREEN }, { model, timeoutMs: 20 });

    expect(sorted.degraded).toBe(true);
    expect(sorted.error).toContain("did not answer within 20ms");
    expect(sorted.decisions).toEqual([{ text: "12", at: at("12"), claim: true, why: sorted.error, where: WHERE }]);
  });

  /** An answer that does not line up with the batch is not a triage of this
   *  screen — it is a guess about which token each decision belongs to. */
  it("waives nothing when the answer does not line up with the batch", async () => {
    const sorted = await triage(
      { tokens: [token("12"), token("45"), token("$13,200.00")], visibleText: SCREEN },
      { model: answering([{ claim: false, why: "a clock" }]), delayMs: () => 0 },
    );

    expect(sorted.degraded).toBe(true);
    expect(sorted.decisions.map((decision) => decision.claim)).toEqual([true, true, true]);
  });

  it("checks a token the model waived without saying why", async () => {
    // A waiver nobody can read is a waiver nobody can overturn, and the preview
    // prints this clause beside the value it excused.
    const sorted = await triage(
      { tokens: [token("12")], visibleText: SCREEN },
      { model: answering([{ claim: false, why: "   " }]) },
    );

    expect(sorted.decisions[0]).toMatchObject({ claim: true });
  });
});

describe("TriageContract", () => {
  it("pins the triage's own model, separately from whoever is being graded", () => {
    expect(TriageContract.model).toBe("claude-sonnet-5");
    expect(TriageContract.triageVersion).toBe(2);
  });

  /** One screen's honesty bill is priced in a single pass over the triage's and
   *  the auditor's tokens together (`auditFloor`), which is only exact while both
   *  are pinned to the same model. */
  it("is pinned to the same model the auditor is, which is what makes one price exact", () => {
    expect(TriageContract.model).toBe(AUDITOR_CONTRACT.model);
  });

  /** A LITERAL, not a re-derivation: hashing the prompt under test and comparing
   *  it to the hash of the prompt under test cannot fail, so every word of the
   *  sorting rules could change under a green suite. Pinned, an edit fails here
   *  until `triageVersion` moves on purpose. */
  const PROMPT_HASH = "ca3df4af4d97282a0d13e5a4f46959b76812b47ddb476b6ae85c4dd24614a7a5";

  it("hashes the prompt, so any edit to it changes the contract", () => {
    expect(TriageContract.promptHash).toBe(PROMPT_HASH);
    expect(createHash("sha256").update(TRIAGE_PROMPT).digest("hex")).toBe(PROMPT_HASH);
  });

  /**
   * The rule the whole stage rests on, quoted byte-exact: an unsure triage
   * checks. Softening this sentence turns a stage that only removes provable
   * noise into one that quietly excuses whatever it could not read, so it fails
   * here rather than being re-signed by whoever edited it.
   */
  it("tells the triage to check whatever it is unsure about", () => {
    expect(TRIAGE_PROMPT).toContain("When you are unsure, answer claim: true.");
  });
});
