/**
 * The supervisor slot (§4.1 item 6) — ONE slot, ONE call site, shipped as a
 * no-op.
 *
 * It exists before anyone needs it because the verification project fills it, and
 * its signature is a frozen inter-project seam. So the two things worth testing
 * are the two things that could go wrong on our side: an unset supervisor must
 * cost a turn nothing at all, and a refusal must reach the user through the error
 * path that already exists rather than a new part nobody renders.
 */
import type { RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  userMessage,
} from "./test-helpers.js";

type Supervised = { turnId: string; answer: string; ctx: RunContext };

async function turn(supervise?: (input: Supervised) => Promise<{ ok: true } | { ok: false; reason: string }>) {
  const guard = testGuard({});
  const agent = createAgent({
    model: scriptedModel([textTurn("Two invoices.", "t1")]),
    tools: boundRegistry({}, guard),
    guard,
    ...(supervise === undefined ? {} : { supervise }),
  });
  const response = await agent.stream({
    threadId: "thr_supervise",
    message: userMessage("u1", "how many invoices"),
    ctx: ctx(),
  });
  return readSse(response);
}

/** The `start` frame's messageId is minted per stream by the SDK, so it is the
 *  one field two runs of the same turn cannot agree on. Everything else is
 *  compared byte for byte. */
const stable = (frames: string[]): string[] =>
  frames.map((frame) => frame.replace(/"messageId":"[^"]+"/u, '"messageId":"<minted>"'));

describe("the supervisor slot", () => {
  it("costs an unset turn nothing — byte-identical to no supervisor at all", async () => {
    const baseline = await turn();
    const approved = await turn(async () => ({ ok: true }));
    expect(stable(approved.rawFrames)).toEqual(stable(baseline.rawFrames));
  });

  it("sends a refusal through the EXISTING error path, with no new part", async () => {
    const { parts } = await turn(async () => ({ ok: false, reason: "The answer names an account the user cannot see." }));

    // `wireErrorMessage`'s Vendo-shaped branch: the reason is ours, crafted, and
    // safe to show, so it travels recognizably prefixed — the same affordance
    // (banner, Retry, detail line) every other turn failure already renders.
    const error = parts.find((part) => part.type === "error");
    expect(error?.errorText).toBe(
      "Vendo: The answer names an account the user cannot see. (blocked)",
    );
    // And it is RECORDED in the turn, like any other failure, so a reload still
    // says why the answer was withheld.
    const recorded = parts.find((part) => part.type === "data-vendo-turn-error");
    expect((recorded as { data: { message: string } } | undefined)?.data.message)
      .toBe("Vendo: The answer names an account the user cannot see. (blocked)");
    // No second vocabulary: nothing shaped like a supervision part is on the wire.
    expect(parts.some((part) => String(part.type).includes("supervis"))).toBe(false);
  });

  it("is told the turn it judged, the answer it judged, and whose run it was", async () => {
    const seen: Supervised[] = [];
    await turn(async (input) => {
      seen.push(input);
      return { ok: true };
    });

    expect(seen).toHaveLength(1);
    const [only] = seen;
    // The turn id is §3.5's, minted once per turn — the same id the audit rows
    // carry, which is the whole point of handing it over.
    expect(only!.turnId).toMatch(/^trn_[0-9a-f]{32}$/);
    expect(only!.answer).toBe("Two invoices.");
    expect(only!.ctx.principal.subject).toBe("u1");
    expect(only!.ctx.turnId).toBe(only!.turnId);
  });
});
