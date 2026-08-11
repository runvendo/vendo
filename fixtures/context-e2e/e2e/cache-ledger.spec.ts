import { expect, test } from "@playwright/test";
import { cachedShare, hasRealKey, ledgerIds, newRunsSince, NO_KEY, openFreshChat, send, TURN_MS } from "./maple.js";

/**
 * The cache the breakpoint buys, read out of the ledger.
 *
 * S5 advances the trailing cache breakpoint every step, so a step's growing
 * tool results are re-read from cache instead of re-billed. Each of the three
 * turns below needs a host read to answer (Maple's policy runs reads silently),
 * so each turn is several steps.
 *
 * TWO DIVERGENCES FROM "rises across steps", both recorded rather than worked
 * around, because the fix for either would be product work this slice does not
 * own:
 *
 *  1. The ledger's granularity is per TURN, not per step. The harness emits ONE
 *     `usage` event at turn finish carrying `totalUsage` summed over the turn's
 *     steps (`vendo.ts` `usageOf`), and `reportRun` writes that as the row.
 *     Per-step rows do not exist in the audit trail, the store or the wire.
 *  2. Because a row is a SUM over steps, a strict turn-over-turn rise would be
 *     asserting the model's step count, not the cache: this suite's first live
 *     run measured 9,417 → 20,239 → 10,822 cache reads, where the third turn
 *     simply answered in one step instead of two.
 *
 * So the S5 claim is asserted the two ways the shipped ledger can express it:
 * the thread's cached prefix GREW (the last turn reads more than the cold first
 * one), and most of a multi-step turn's prompt is a cache READ — which is only
 * true if steps after the first are cached, which is exactly what the advancing
 * breakpoint does.
 */

/** The cold first turn writes the cache and reads about half of its own prompt.
 *  Every turn after it reads the great majority; 0.6 is well under the 0.90 the
 *  first live run measured and well over anything a stale breakpoint yields. */
const CACHED_SHARE_FLOOR = 0.6;

test.skip(!hasRealKey, NO_KEY);

test("the audit ledger shows a growing prefix served from cache", async ({ page }) => {
  test.setTimeout(4 * TURN_MS);
  await openFreshChat(page);
  const before = await ledgerIds(page);

  // Each one needs a host read, so each one is a multi-step turn.
  await send(page, "List my accounts and tell me which one holds the highest balance.");
  await send(page, "Now show my five most recent transactions and total them.");
  await send(page, "Now list my scheduled payments and tell me which one is due next.");

  const runs = (await newRunsSince(page, before)).filter((row) => row.detail?.usage !== undefined);
  const usage = runs.map((row) => row.detail!.usage!);
  console.log("[context-e2e] cache growth across turns:", JSON.stringify(usage, null, 2));
  console.log("[context-e2e] cached share per turn:", JSON.stringify(usage.map(cachedShare)));

  expect(usage.length, "three turns did not write three run rows").toBeGreaterThanOrEqual(3);

  const first = usage[0]!;
  const last = usage.at(-1)!;

  // `inputTokens` is the WHOLE prompt: the cached halves are inside it, not
  // beside it. This is S2's ground truth, re-measured every run.
  for (const row of usage) {
    const parts = (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    expect(parts, `a turn billed ${row.inputTokens} input but only ${parts} of it is accounted for`)
      .toBeLessThanOrEqual(row.inputTokens);
  }

  expect(
    last.cacheReadTokens ?? 0,
    `the thread's cached prefix did not grow: first turn read ${first.cacheReadTokens}, last read ${last.cacheReadTokens}`,
  ).toBeGreaterThan(first.cacheReadTokens ?? 0);

  expect(
    cachedShare(last),
    `only ${(cachedShare(last) * 100).toFixed(1)}% of the last turn's prompt came from cache — its steps are re-billing the prefix`,
  ).toBeGreaterThanOrEqual(CACHED_SHARE_FLOOR);
});
