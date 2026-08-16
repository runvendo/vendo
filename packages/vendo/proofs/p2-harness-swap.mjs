/**
 * Wave-1 live proof P2 — E1's harness swap.
 *
 * "Swapping the harness mid-conversation continues the thread from OUR
 * transcript." Two DISTINCT harness instances take turn 1 and turn 2 of ONE
 * thread, over one real store. Turn 2's harness records what `turn.messages`
 * handed it; if the transcript is ours and canonical, it sees turn 1's user text
 * AND turn 1's assistant reply, neither of which its own instance ever produced.
 *
 * Two `vendo()` instances are the wave-1-valid swap (claudeCode() is wave 2), but
 * this uses two scripted harnesses with DIFFERENT names so the swap is
 * observable: harness B can only know turn 1 by reading the store.
 *
 * Run: node packages/vendo/proofs/p2-harness-swap.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVendo } from "@vendoai/vendo/server";
import { createStore } from "@vendoai/store";
import { defineHarness } from "@vendoai/harnesses";

const principal = { kind: "user", subject: "user_swap" };
const THREAD = "thr_swap";

const dataDir = await mkdtemp(join(tmpdir(), "p2-swap-"));
const store = createStore({ dataDir });

/** What each harness SAW on `turn.messages` when it ran. */
const seen = { A: null, B: null };

function scripted(label, reply) {
  return defineHarness({
    name: `swap-${label}`,
    async *run(turn) {
      seen[label] = turn.messages.map((m) => ({
        role: m.role,
        text: (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
      }));
      yield { type: "text", delta: reply };
    },
  });
}

const compose = (harness) => {
  const v = createVendo({ models: { default: {} }, principal: async () => principal, store, harness });
  return v;
};

const message = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });
const ctx = () => ({ principal, venue: "chat", presence: "present", sessionId: "sess_swap" });

// Turn 1 — harness A.
const a = compose(scripted("A", "A here: two invoices are open."));
await (await a.harness.stream({ threadId: THREAD, message: message("m1", "How many invoices?"), ctx: ctx() })).text();

// Turn 2 — harness B, SAME thread, SAME store, a different thinker.
const b = compose(scripted("B", "B here: still two."));
await (await b.harness.stream({ threadId: THREAD, message: message("m2", "And now?"), ctx: ctx() })).text();

const bSawTurn1User = seen.B?.some((m) => m.role === "user" && m.text.includes("How many invoices?")) ?? false;
const bSawTurn1Assistant = seen.B?.some((m) => m.role === "assistant" && m.text.includes("A here")) ?? false;

console.log(JSON.stringify({
  harnessA_sawMessages: seen.A,
  harnessB_sawMessages: seen.B,
  VERDICT: {
    // The whole claim: B continued from OUR transcript.
    b_sees_turn1_user_message: bSawTurn1User,
    b_sees_turn1_reply_it_never_wrote: bSawTurn1Assistant,
    swap_continued_from_our_transcript: bSawTurn1User && bSawTurn1Assistant,
  },
}, null, 2));

await store.close();
await rm(dataDir, { recursive: true, force: true });
