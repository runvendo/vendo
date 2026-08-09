import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { consumerVoiceViolation } from "../src/consumer-voice.js";
import { openScenario } from "./helpers.js";

/**
 * Pass 3, in a real browser — the last three consumer-voice holes of the
 * redesign wave (conductor ruling 11), each photographed as a person sees it:
 *
 *  a) the approval card fed a MODEL-authored descriptor
 *  b) the SAME ask's row in the waiting-on-you queue
 *  c) a failed unattended run in an automation's history
 *
 * Every capture is machine-audited with the ONE consumer-voice vocabulary the
 * product itself gates on (`src/consumer-voice.ts`), and each case carries its
 * POSITIVE CONTROL: the pre-fix string, asserted to FAIL that same audit. An
 * audit that cannot fail proves nothing.
 *
 * Screenshots land in e2e/test-results/pass3/ (gitignored).
 */

const SHOTS = new URL("./test-results/pass3/", import.meta.url).pathname;

/** The exact sentence demo-bank shipped for the MODEL, seen live on
 *  `standing-01-pending.png` during this wave. */
const MODEL_INSTRUCTION =
  "Spending by category for the current period. Amounts are integer cents"
  + " (e.g. 285000 = $2,850.00): divide by 100 exactly once before displaying,"
  + " including any totals you compute. Do not re-divide.";

/** The route scanner's fallback description, which Maple shipped on seven tools. */
const ROUTE_FALLBACK = "POST /api/demo/pin";

/** The scheduler's own refusal, as the run-history row used to print it. */
const RUN_FAILURE_WIRE = "meter-exhausted: blocked by allowance: Vendo Cloud paused usage"
  + " — the $49.00 included this billing period is used up (resets 2026-08-01)."
  + " Upgrade your plan (https://console.vendo.run/billing).";

/** The card's ask, applied to the WIRE's own pending approval so the queue row
 *  under test is the same ask the card renders — identity, args, descriptor and
 *  all. Everything else (ids, ctx, timestamps, the envelope) stays exactly as
 *  the server produced it: the point is the real wire path, not a fixture. */
const asTheCardsAsk = (ask: Record<string, unknown>) => ({
  ...ask,
  call: { ...(ask.call as object), tool: "host_getSpendingInsights", args: { period: "month" } },
  descriptor: {
    name: "host_getSpendingInsights",
    description: MODEL_INSTRUCTION,
    inputSchema: { type: "object", properties: { period: { type: "string" } } },
    risk: "read",
  },
});

const FAILED_RUN = {
  id: "run_blocked",
  appId: "app_auto",
  trigger: { kind: "schedule" },
  status: "error",
  startedAt: "2026-07-11T12:00:00.000Z",
  finishedAt: "2026-07-11T12:00:05.000Z",
  steps: [],
  error: {
    code: "meter-exhausted",
    message: "blocked by allowance: Vendo Cloud paused usage — the $49.00 included this"
      + " billing period is used up (resets 2026-08-01). Upgrade your plan"
      + " (https://console.vendo.run/billing) or bring your own infrastructure"
      + " (https://docs.vendo.run/byo).",
  },
};

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test("the positive control — the vocabulary DOES fail on the pre-fix strings", () => {
  // (a)/(b): the descriptor the card used to print.
  expect(consumerVoiceViolation(MODEL_INSTRUCTION)).toBe("a model instruction: integer cents");
  // TASK 2: the route scanner's fallback, which Maple shipped on seven tools.
  expect(consumerVoiceViolation(ROUTE_FALLBACK)).toBe("an HTTP route line: POST /");
  // …and it passes the words the surfaces say instead, so the audit is a filter
  // and not a blanket refusal.
  expect(consumerVoiceViolation("This reads your data, as you.")).toBeUndefined();
  expect(consumerVoiceViolation("This run didn’t finish — nothing in your account was changed.")).toBeUndefined();
  expect(consumerVoiceViolation("Reads the suggestions Maple offers you to try.")).toBeUndefined();

  // (c) is HONESTLY not a vocabulary case, and this is the assertion that says
  // so: the scheduler's refusal names a billing allowance and a console URL, and
  // the vocabulary sees nothing wrong with it (hyphens are not id underscores;
  // real URLs are user content and are lifted out). A filter could never have
  // caught it — which is exactly why ruling 11 answered it with a PRODUCT
  // decision about what a failed unattended run may say to its owner. Its
  // control is the row's own text, asserted in (c).
  expect(consumerVoiceViolation(RUN_FAILURE_WIRE)).toBeUndefined();
});

test("(a) the approval card fed a model-instruction descriptor says its OWN words", async ({ page }) => {
  await openScenario(page, "approval-descriptor");
  const card = page.locator("article.fl-approval");
  await expect(card).toBeVisible();

  await expect(card).not.toContainText("integer cents");
  await expect(card).not.toContainText("divide by 100");
  await expect(card).not.toContainText("e.g.");
  // The honest fallback: the consequence CLASS, in full — not a truncation.
  await expect(card.locator(".fl-card-line")).toHaveText("This reads your data, as you.");

  const violation = consumerVoiceViolation((await card.innerText()).replace(/^host_\S+$/gm, ""));
  expect(violation, `the approval card rendered ${violation}`).toBeUndefined();
  await page.screenshot({ path: `${SHOTS}a-approval-card-descriptor.png` });
});

test("(b) the SAME ask's queue row agrees with the card", async ({ page }) => {
  await page.route("**/api/vendo/approvals", async (route) => {
    if (route.request().method() !== "GET") return await route.fallback();
    const answer = await route.fetch();
    const asks = await answer.json() as Array<Record<string, unknown>>;
    await route.fulfill({ response: answer, json: asks.map(asTheCardsAsk) });
  });
  await openScenario(page, "waiting");
  await page.locator(".fl-waiting-strip > summary").click();
  const row = page.locator("article.fl-cardshell").first();
  await expect(row).toBeVisible();

  await expect(row).not.toContainText("integer cents");
  await expect(row).not.toContainText("divide by 100");
  await expect(row.locator(".fl-card-line")).toHaveText("This reads your data, as you.");

  const violation = consumerVoiceViolation((await row.innerText()).replace(/^host_\S+$/gm, ""));
  expect(violation, `the queue row rendered ${violation}`).toBeUndefined();
  await page.screenshot({ path: `${SHOTS}b-waiting-queue-row.png` });
});

test("(c) a failed unattended run tells its owner what did not happen", async ({ page }) => {
  await page.route("**/api/vendo/runs*", async (route) => {
    if (route.request().method() !== "GET") return await route.fallback();
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { runs: [FAILED_RUN] } });
  });
  await openScenario(page, "automations");
  await page.getByRole("button", { name: "Run history" }).first().click();
  const history = page.getByRole("group", { name: /^Run history for/ });
  await expect(history).toBeVisible();

  await expect(history.getByRole("alert")).toHaveText("This run didn’t finish — nothing in your account was changed.");
  await expect(history).not.toContainText("meter-exhausted");
  await expect(history).not.toContainText("allowance");
  await expect(history).not.toContainText("console.vendo.run");

  const violation = consumerVoiceViolation(await history.getByRole("alert").innerText());
  expect(violation, `the failed-run row rendered ${violation}`).toBeUndefined();
  await page.screenshot({ path: `${SHOTS}c-automations-failed-run.png` });
});
