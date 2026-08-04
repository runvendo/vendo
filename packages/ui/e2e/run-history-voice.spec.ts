import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { consumerVoiceViolation } from "../src/consumer-voice.js";
import { openScenario } from "./helpers.js";

/**
 * The final cleanup, in a real browser — an automation's run-history row.
 *
 * The row printed the RunStatus SLUG and the raw ISO instant at the automation's
 * owner ("error", "pending-approval", "2026-07-11T12:00:00.000Z") while the
 * helpers that turn both into human words already sat in the same file. Spec §16
 * law 3 and the automations design's consumer-voice run history.
 *
 * HONEST LIMIT, asserted below: the consumer-voice vocabulary does NOT flag a
 * status slug or an ISO instant — "error" is a real English word and the instant
 * carries no id underscore or dotted identifier. A filter could never have caught
 * this, so the control is the ROW'S OWN TEXT: the machine values are asserted
 * absent from what the person reads, and the ISO instant is asserted to remain in
 * `<time dateTime>`, where machines read it.
 *
 * Screenshot lands in
 * docs/superpowers/evidence/2026-08-03-ui-redesign/final-cleanup/.
 */

const SHOTS = new URL(
  "../../../docs/superpowers/evidence/2026-08-03-ui-redesign/final-cleanup/",
  import.meta.url,
).pathname;

const STARTED_AT = "2026-07-11T12:00:00.000Z";
const HUMAN_TIME = "Jul 11, 2026, 12:00 PM";

/** Two runs whose slugs are the ones a person must never be shown: the refused
 *  unattended run, and the run parked behind a decision. */
const RUNS = [
  {
    id: "run_blocked",
    appId: "app_auto",
    trigger: { kind: "schedule" },
    status: "error",
    startedAt: STARTED_AT,
    finishedAt: "2026-07-11T12:00:05.000Z",
    steps: [],
    error: { code: "meter-exhausted", message: "blocked by allowance: the allowance for this billing period is used up." },
  },
  {
    id: "run_parked",
    appId: "app_auto",
    trigger: { kind: "schedule" },
    status: "pending-approval",
    startedAt: STARTED_AT,
    steps: [],
  },
];

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test("the vocabulary CANNOT catch this — which is why the row's own text is the control", () => {
  expect(consumerVoiceViolation("error")).toBeUndefined();
  expect(consumerVoiceViolation(STARTED_AT)).toBeUndefined();
  // It does see the slug that carries an underscore, so the audit is alive.
  expect(consumerVoiceViolation("needs_review")).toBe("an id-shaped token: needs_review");
});

test("a run-history row names its state and its time in the owner's words", async ({ page }) => {
  await page.route("**/api/vendo/runs*", async (route) => {
    if (route.request().method() !== "GET") return await route.fallback();
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { runs: RUNS } });
  });
  await openScenario(page, "automations");
  await page.getByRole("button", { name: "Run history" }).first().click();
  const history = page.getByRole("group", { name: /^Run history for/ });
  await expect(history).toBeVisible();

  // The words the owner reads.
  await expect(history.locator(".fl-act-lbl")).toHaveText(["Failed", "Waiting on approval"]);
  await expect(history.locator(".fl-act-sub").first()).toHaveText(HUMAN_TIME);

  // The machine values the row used to print, now absent from the page's text.
  const rendered = await history.innerText();
  expect(rendered).not.toContain(STARTED_AT);
  expect(rendered).not.toContain("pending-approval");

  // …and still present where a machine reads them.
  await expect(history.locator("time").first()).toHaveAttribute("datetime", STARTED_AT);

  await page.screenshot({ path: `${SHOTS}automations-run-history.png` });
});
