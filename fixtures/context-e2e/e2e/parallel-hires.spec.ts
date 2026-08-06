import { expect, test } from "@playwright/test";
import { hasRealKey, lastReply, ledgerIds, ledger, NO_KEY, openFreshChat, send, TURN_MS, url } from "./maple.js";

/**
 * Two specialists, one turn — and a reply that never says so in machine words.
 *
 * `subagent-loop.test.ts` proves a hire rides the loop. This proves the two
 * halves that only a browser can: the receipts reach the ledger the activity
 * panel reads, and the resident's REPLY is still one assistant speaking plainly.
 *
 * The reply assertion is scoped to the conversation on purpose. The activity
 * panel prints tool identifiers by design — that is its job — so a page-wide
 * "no `host_`" assertion would be asserting the opposite of the product.
 */

/** Identifiers that belong to the machine, not the conversation. */
const MACHINE_WORDS = ["host_", "vendo_", "hire_subagent"];

test.skip(!hasRealKey, NO_KEY);

test("a turn that hires two specialists shows their receipts and keeps them out of the reply", async ({ page }) => {
  test.setTimeout(3 * TURN_MS);
  await openFreshChat(page);
  const before = await ledgerIds(page);

  await send(page, [
    "Hire two specialists and let them work at the same time:",
    "one to review my recent transactions and describe my top spending categories,",
    "and one to list my accounts with their balances.",
    "Wait for both, then give me one combined summary in plain prose.",
  ].join(" "));

  const reply = await lastReply(page);
  await page.screenshot({ path: "e2e/artifacts/parallel-hires-reply.png", fullPage: false });

  // The ledger partitions a hiring turn: the resident's own row, plus one row
  // per hire (`runtime.ts` reportRun).
  const rows = (await ledger(page)).filter((row) => !before.has(row.id));
  const hires = rows.filter((row) => row.detail?.subagent !== undefined);
  console.log("[context-e2e] hire rows:", JSON.stringify(hires.map((row) => row.detail?.subagent)));
  expect(hires.length, "the turn did not hire two specialists").toBeGreaterThanOrEqual(2);

  // The same rows, as a person sees them.
  await page.goto(url("/vendo/workspace"));
  const more = page.locator('button[aria-label="More sections"]');
  if (await more.isVisible()) await more.click();
  await page.locator("#vendo-tab-activity").click();
  const receipts = page.locator("li.fl-act-led-row", { hasText: "Specialist hired" });
  // A floor, not an equality: the panel is the principal's WHOLE ledger, so it
  // also carries every hire an earlier run of this suite left in the store.
  await expect.poll(() => receipts.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(hires.length);
  await page.screenshot({ path: "e2e/artifacts/parallel-hires-activity.png", fullPage: false });

  for (const word of MACHINE_WORDS) {
    expect(reply, `the reply named the machinery: "${word}"\n${reply}`).not.toContain(word);
  }
});
