import { expect, test } from "@playwright/test";
import {
  expectNoTurnError, hasRealKey, lastReply, ledgerIds, ledgerPaste, newRunsSince,
  NO_KEY, openFreshChat, send, TURN_MS,
} from "./maple.js";

/**
 * The floor holds when the summary cannot.
 *
 * One message far bigger than the seat's declared window, first in a fresh
 * thread. The trigger trips, but there is nothing above the cut to summarize —
 * `findCutIndex` returns 0 on a single oversized message — so the summarizer is
 * skipped and `shedToBudget` runs instead. Everything after that is S1's
 * well-formedness sweep and S4's recovery posture: the prompt that goes out is
 * still one a provider accepts, and the user is told nothing went wrong,
 * because nothing did.
 *
 * WHAT THIS SPEC DOES NOT PROVE, stated plainly: a genuine provider 400 is not
 * reachable from a browser once a small `contextWindowTokens` is in force — the
 * estimate always trips before the real 200k window does, which is the whole
 * point of the trigger. `overflow.test.ts` owns the classifier and the
 * one-retry budget; this owns the half only a person can see.
 */

/** ~37k tokens: past the 32k the seat believes it has, past the 20k preserved
 *  tail, and in ONE message so the cut has nowhere to land. */
const OVERSIZED_CHARS = 150_000;

test.skip(!hasRealKey, NO_KEY);

test("a message far past the window still finishes, with nothing said about it", async ({ page }) => {
  test.setTimeout(2 * TURN_MS);
  await openFreshChat(page);
  const before = await ledgerIds(page);

  await send(page, ledgerPaste(OVERSIZED_CHARS, "OVERSIZED"));

  const reply = await lastReply(page);
  await expectNoTurnError(page);
  await page.screenshot({ path: "e2e/artifacts/overflow-recovery.png", fullPage: false });
  console.log("[context-e2e] recovered reply:", reply.slice(0, 200));

  // The banner is the UI's account of the turn; the ledger is the runtime's.
  // A silent recovery means both are clean.
  const runs = await newRunsSince(page, before);
  const turn = runs.at(-1);
  // The row has to EXIST before its absent error means anything. Read off an
  // empty ledger, `turn?.detail?.error` is undefined for the one reason this
  // spec must never accept: the runtime recorded nothing at all, and the
  // recovery it claims to have seen never happened.
  expect(turn, "the oversized turn wrote no run row — the runtime recorded nothing").toBeDefined();
  console.log("[context-e2e] oversized turn usage:", JSON.stringify(turn!.detail?.usage));
  expect(turn!.detail?.error, `the runtime recorded a failure: ${JSON.stringify(turn!.detail?.error)}`).toBeUndefined();
});
