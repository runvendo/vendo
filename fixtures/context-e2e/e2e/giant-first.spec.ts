import { expect, test } from "@playwright/test";
import {
  expectNoTurnError, hasRealKey, lastReply, ledgerIds, ledgerPaste, newRunsSince,
  NO_KEY, openFreshChat, promptTokens, send, TURN_MS,
} from "./maple.js";

/**
 * One enormous message, then an ordinary conversation on top of it.
 *
 * The shape this suite was missing, and the one the engine is FOR. Every other
 * spec here pastes several medium statements, so the cut always had a message
 * boundary to land on inside the preserved tail and compaction always looked
 * alive. On a thread whose bulk is ONE message the cut used to land on 0, the
 * floor believed a 143k-token prompt fit its budget, and the projection never
 * changed for the life of the thread — every turn paid the trigger and nothing
 * ever got smaller. The cache absorbed the bill, so nobody saw it.
 *
 * Two claims, and they are different in kind. The prompt has to SHRINK and stay
 * shrunk, which is the defect stated as a number. And the thread has to still
 * know what was in the paste, which is what tells a summary apart from a
 * deletion: the floor underneath would also make the prompt small, by throwing
 * the statement away.
 *
 * `overflow-recovery.spec.ts` owns the neighbouring case — one oversized message
 * with NOTHING after it, where there is genuinely nothing above the cut and the
 * floor is the answer.
 */

/** Three strings the paste is the only source of. Deliberately not anything
 *  Maple seeds or a model could guess. */
const REFERENCE = "MPL-GIANT-58203-FALCON";
const AMOUNT = "8,204.19";
const PATH = "reports/falcon-giant-first-2026-02.csv";

/** ~37k tokens at the chars/4 estimate, ~64k real on this kind of text: past
 *  the 32k the seat believes it has and far past the 20k preserved tail, in ONE
 *  message. */
const PASTE_CHARS = 150_000;

const giantPaste = (): string => [
  "Before the statement, note these three details for later.",
  `The January reconciliation reference is ${REFERENCE}, the disputed amount is $${AMOUNT},`,
  `and I saved the working file at ${PATH}.`,
  "",
  ledgerPaste(PASTE_CHARS, "FALCON"),
].join("\n");

const SMALL_TURN = "Thanks. Just reply with the single word: noted. Do not use any tools.";

test.skip(!hasRealKey, NO_KEY);

test("a thread built on one giant message keeps getting smaller, and still remembers it", async ({ page }) => {
  test.setTimeout(5 * TURN_MS);
  await openFreshChat(page);
  const before = await ledgerIds(page);

  await send(page, giantPaste());
  await send(page, SMALL_TURN);
  await send(page, SMALL_TURN);
  await send(page, [
    "Remind me: what was the January reconciliation reference, the exact disputed amount,",
    "and the path of the working file? Answer from what I told you earlier in this conversation.",
    "Do not use any tools.",
  ].join(" "));

  const reply = await lastReply(page);
  await expectNoTurnError(page);
  await page.screenshot({ path: "e2e/artifacts/giant-first.png", fullPage: false });

  // Claim one, in the runtime's own ledger. The rows have to EXIST before any
  // number read off them means anything — an empty ledger would otherwise read
  // as a thread that shrank beautifully. A hire writes a `run` row too and its
  // prompt is not the resident's, so the numbers below are the resident's only.
  const runs = (await newRunsSince(page, before)).filter((row) => row.detail?.subagent === undefined);
  expect(runs.length, `the thread wrote ${runs.length} resident run rows for 4 turns`).toBeGreaterThanOrEqual(4);
  const prompts = runs.map((row) => {
    expect(row.detail?.usage, `a run row carried no usage: ${JSON.stringify(row)}`).toBeDefined();
    return promptTokens(row.detail!.usage!);
  });
  console.log("[context-e2e] giant-first prompt tokens per turn:", prompts.join(", "));

  // Turn 1 sends the paste whole, and correctly: one oversized message on a
  // fresh thread has nothing above it to summarize.
  const first = prompts[0] as number;
  expect(first, `turn 1 sent ${first} prompt tokens — the paste never reached the model`)
    .toBeGreaterThan(40_000);
  // Every turn after it, and not merely the next one. The defect was a prompt
  // that never changed again.
  for (const [index, prompt] of prompts.slice(1).entries()) {
    expect(prompt, `turn ${index + 2} sent ${prompt} prompt tokens against turn 1's ${first} — the paste never left`)
      .toBeLessThan(first / 2);
  }

  // Claim two: the paste was SUMMARIZED, not deleted. Containment, never a
  // judgement of prose — the identifiers survive verbatim or they do not.
  expect(reply, `the reference did not survive the summary. Reply:\n${reply}`).toContain(REFERENCE);
  expect(reply, `the amount did not survive the summary. Reply:\n${reply}`).toContain(AMOUNT);
  expect(reply, `the file path did not survive the summary. Reply:\n${reply}`).toContain(PATH);
});
