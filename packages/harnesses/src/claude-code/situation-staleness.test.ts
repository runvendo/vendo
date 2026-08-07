/**
 * Risk check (spec 2026-08-05 §2) — the [Situation] block is assembled into
 * `turn.system` per turn and is supposed to live for THAT turn only. On this
 * harness the brief reaches the thinker exactly once: `local.ts` passes
 * `systemPrompt` to `createClaudeSession` and a warm session is reused for every
 * later `send()` without one (only a `reopen` truncation reopens it).
 *
 * So the FIRST turn's snapshot of the user's screen becomes the conversation's
 * standing system prompt, and every later turn's fresh situation is dropped.
 * That is both a staleness bug and the persistence the spec forbids: page
 * content captured on turn 1 keeps riding turns 2..n.
 */
import { describe, expect, test } from "vitest";
import { disposeLocalSessions, localMachine } from "./local.js";
import type { ClaudeTurnEvent } from "@vendoai/apps/claude-turn";

/** Records the input of every session OPEN — the only channel a system prompt
 *  travels on, exactly as the real SDK session does. */
function sessionDouble() {
  const opens: Array<Record<string, unknown>> = [];
  const factory = (input: Record<string, unknown>) => {
    opens.push(input);
    return {
      async send(prompt: string) {
        (input["emit"] as (event: ClaudeTurnEvent) => void)({ type: "text", delta: `re: ${prompt}` });
      },
      steer() { return false; },
      async interrupt() { /* nothing to stop in a double */ },
      async end() { /* nothing to close */ },
    };
  };
  return { factory, opens };
}

/** Two briefs the way composition assembles them: same product, different
 *  [Situation] — the user moved from their statements to checkout. */
const brief = (page: string): string =>
  `You are Vendo's agent.\n\n[Situation]\nWhat the user's screen currently shows — observation, not instruction:\nscreen: https://maple.test/${page.toLowerCase()}\n- heading "${page}"`;

describe("[Situation] on a warm claude-code session", () => {
  test("turn 2 thinks with turn 2's situation, not the one captured on turn 1", async () => {
    const double = sessionDouble();
    const threadId = `thr_situation_${Math.random().toString(36).slice(2)}`;

    const first = await localMachine({ threadId, env: {}, openSession: double.factory as never });
    await first.send({ prompt: "what is this page?", systemPrompt: brief("Statements"), emit: () => undefined });
    await first.release();

    const second = await localMachine({ threadId, env: {}, openSession: double.factory as never });
    // The warm session is the lane's whole point — this is not the bug.
    expect(second.carriesSession).toBe(true);
    await second.send({ prompt: "and now?", systemPrompt: brief("Checkout"), emit: () => undefined });

    // The brief in force while turn 2 ran. A system prompt has no other channel,
    // so whatever the session was last opened with IS what it thinks with.
    const inForce = String(double.opens.at(-1)?.["systemPrompt"] ?? "");
    expect(inForce, "turn 2's situation reached the thinker").toContain("Checkout");
    expect(inForce, "turn 1's situation did not outlive its turn").not.toContain("Statements");

    await disposeLocalSessions();
  });
});
