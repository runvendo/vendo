import { expect, test } from "@playwright/test";
import {
  hasRealKey, ledgerPaste, ledgerIds, lastReply, newRunsSince, NO_KEY,
  openFreshChat, promptTokens, send, TURN_MS,
} from "./maple.js";

/**
 * The trigger, the summary and the recall — in a real browser, on a real model.
 *
 * `compaction-eval.live.test.ts` proves the same claim at the loop's own seam.
 * This is its browser-level twin: the identifiers travel the whole way out
 * through Maple's transcript, so a summary that keeps them in the loop but
 * loses them on the way to the screen is caught here and nowhere else.
 *
 * The two pasted statements are what make the proof falsifiable. Compaction
 * cannot summarize a thread that fits inside its 20k-token preserved tail
 * (`findCutIndex`), so a "few short messages" thread would never trip anything
 * no matter how small the window is. At this size the cut lands past the seed
 * message, the first statement leaves the prompt entirely, and the recall turn's
 * prompt is about HALF the raw thread — which is the number this spec asserts
 * alongside the words, because the words alone would still be right if nothing
 * had compacted at all.
 */

/** Three strings the seed message is the only source of. Deliberately not
 *  anything Maple seeds or a model could guess. */
const REFERENCE = "MPL-REF-77412-ZEBRA";
const AMOUNT = "4,317.06";
const PATH = "reports/larkspur-reconciliation-2026-01.csv";

/** ~25k tokens each at the chars/4 estimate the trigger uses. */
const PASTE_CHARS = 100_000;

/**
 * The recall turn's whole prompt, in tokens, if it compacted.
 *
 * Two different numbers matter here and they are not the same size. The TRIGGER
 * and the cut point run on the chars/4 estimate, where a statement is ~26k and
 * so clears the 20k preserved tail. The PROVIDER's real count is roughly double
 * that on this kind of text — a statement measures ~43k real tokens (the
 * overflow spec's 150k-char paste billed 64k). So: Maple's own prompt ~10k,
 * compacted the recall turn sends the summary plus the NEWEST statement (~53k),
 * uncompacted it sends both (~96k). The recall question forbids tools, so the
 * turn is one step and the row is one prompt rather than a sum over several.
 */
const COMPACTED_CEILING = 70_000;

/** Never said out loud. The user is not told their thread was summarized. */
const MACHINERY = ["summariz", "compact", "context limit"];

test.skip(!hasRealKey, NO_KEY);

test("a compacted thread still answers from the band it summarized away", async ({ page }) => {
  test.setTimeout(4 * TURN_MS);
  await openFreshChat(page);
  const before = await ledgerIds(page);

  await send(page, [
    "Before we start, note these three details for later.",
    `The January reconciliation reference is ${REFERENCE}, the disputed amount is $${AMOUNT},`,
    `and I saved the working file at ${PATH}.`,
    "Just confirm you have them. Do not use any tools.",
  ].join(" "));

  // Two statements, each bigger than the preserved tail, so the seed message is
  // below the cut by the time the recall question is asked.
  await send(page, ledgerPaste(PASTE_CHARS, "A"));
  await send(page, ledgerPaste(PASTE_CHARS, "B"));

  await send(page, [
    "Remind me: what was the January reconciliation reference, the exact disputed amount,",
    "and the path of the working file? Answer from what I told you earlier in this conversation.",
    "Do not use any tools.",
  ].join(" "));

  const reply = await lastReply(page);
  await page.screenshot({ path: "e2e/artifacts/compaction-recall.png", fullPage: false });

  // Containment, never a judgement of prose: the identifiers survive verbatim
  // or they do not.
  expect(reply, `the reference did not survive the summary. Reply:\n${reply}`).toContain(REFERENCE);
  expect(reply, `the amount did not survive the summary. Reply:\n${reply}`).toContain(AMOUNT);
  expect(reply, `the file path did not survive the summary. Reply:\n${reply}`).toContain(PATH);

  // Silent by law: the transcript is the user's, and compaction is not their
  // business. Scoped to the conversation — the activity panel is a different
  // surface with different rules.
  const transcript = (await page.locator("div.fl-msglist").innerText()).toLowerCase();
  for (const word of MACHINERY) {
    expect(transcript, `the transcript told the user about its own machinery: "${word}"`).not.toContain(word);
  }

  // The witness that something actually compacted. Without it this spec passes
  // on a 200k-window deployment that never summarized anything.
  const runs = await newRunsSince(page, before);
  const recall = runs.at(-1);
  expect(recall?.detail?.usage, "the recall turn wrote no usage row").toBeDefined();
  const prompt = promptTokens(recall!.detail!.usage!);
  console.log("[context-e2e] recall turn usage:", JSON.stringify(recall!.detail!.usage));
  console.log("[context-e2e] every run row this thread wrote:", JSON.stringify(runs.map((r) => r.detail?.usage)));
  expect(
    prompt,
    `the recall turn sent ${prompt} prompt tokens — the whole raw thread, so nothing compacted`,
  ).toBeLessThan(COMPACTED_CEILING);
});
