import type { Json, StoreAdapter } from "@vendoai/core";
import { distillPersona } from "./distill.js";
import type { Persona } from "./types.js";

/** One held-out decision: the prompt the user sent and the tool they actually
 *  chose. Replay asks whether an agent reproduces that choice. */
export interface DecisionCase {
  prompt: string;
  expectedTool: string;
}

export interface SubjectFixture {
  subject: string;
  /** Past tool calls (a name repeated once per use) that shape the persona. */
  historyTools: string[];
  /** Past user asks that shape the persona (format cues live here). */
  historyAsks: string[];
  /** Decisions held out of the history, replayed to score reproduction. */
  holdout: DecisionCase[];
}

/** Seed one subject's history so distillPersona has real rows to read: audit
 *  tool-calls plus one thread of asks, exactly the two sources the distiller
 *  mines in production. */
export const seedSubject = async (store: StoreAdapter, fixture: SubjectFixture): Promise<void> => {
  let index = 0;
  for (const tool of fixture.historyTools) {
    const event = {
      id: `aud_${fixture.subject}_${index}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      kind: "tool-call",
      principal: { kind: "user", subject: fixture.subject },
      venue: "chat",
      presence: "present",
      tool,
      outcome: "ok",
    };
    await store.records("vendo_audit").put({ id: event.id, data: event as unknown as Json, refs: { subject: fixture.subject } });
    index += 1;
  }
  await store.records("vendo_threads").put({
    id: `thr_${fixture.subject}`,
    data: {
      subject: fixture.subject,
      messages: fixture.historyAsks.map((text, k) => ({ id: `m_${k}`, role: "user", parts: [{ type: "text", text }] })),
    } as unknown as Json,
    refs: { subject: fixture.subject },
  });
};

/** The turn under test: given a prompt and the caller's persona (or null for the
 *  stock agent), return the tool the agent would call. A model-backed
 *  implementation plugs in here to produce the real replay number; a
 *  deterministic oracle stands in for CI, proving the harness and that a persona
 *  can move a decision without a live model. */
export type RunTurn = (input: { subject: string; prompt: string; persona: Persona | null }) => Promise<string>;

export interface ReplayReport {
  cases: number;
  withoutPersona: number;
  withPersona: number;
  accuracyWithout: number;
  accuracyWith: number;
  delta: number;
}

/** Offline replay. For every fixture: distill a persona from its history, then
 *  run each held-out decision twice (stock and persona-conditioned) and score
 *  agreement with the user's actual choice. The delta is the persona's effect. */
export const runPersonaReplay = async (
  store: StoreAdapter,
  fixtures: SubjectFixture[],
  runTurn: RunTurn,
): Promise<ReplayReport> => {
  let cases = 0;
  let withPersona = 0;
  let withoutPersona = 0;
  for (const fixture of fixtures) {
    const persona = await distillPersona(store, fixture.subject);
    for (const decision of fixture.holdout) {
      cases += 1;
      const stock = await runTurn({ subject: fixture.subject, prompt: decision.prompt, persona: null });
      const conditioned = await runTurn({ subject: fixture.subject, prompt: decision.prompt, persona });
      if (stock === decision.expectedTool) withoutPersona += 1;
      if (conditioned === decision.expectedTool) withPersona += 1;
    }
  }
  const accuracyWithout = cases === 0 ? 0 : withoutPersona / cases;
  const accuracyWith = cases === 0 ? 0 : withPersona / cases;
  return {
    cases,
    withoutPersona,
    withPersona,
    accuracyWithout,
    accuracyWith,
    delta: accuracyWith - accuracyWithout,
  };
};
