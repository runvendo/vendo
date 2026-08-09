import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { consumerVoiceViolation } from "../src/consumer-voice.js";
import { openScenario } from "./helpers.js";

/**
 * The final cleanup, in a real browser — an automation's run-history row.
 *
 * The row printed the RunStatus SLUG and the raw ISO instant at the automation's
 * owner ("error", "2026-07-11T12:00:00.000Z") while the helpers that turn both
 * into human words already sat in the same file. Spec §16 law 3 and the
 * automations design's consumer-voice run history.
 *
 * HONEST LIMIT, asserted below: the consumer-voice vocabulary does NOT flag a
 * status slug or an ISO instant — "error" is a real English word and the instant
 * carries no id underscore or dotted identifier. A filter could never have caught
 * this, so the control is the ROW'S OWN TEXT: the machine values are asserted
 * absent from what the person reads, and the ISO instant is asserted to remain in
 * `<time dateTime>`, where machines read it.
 *
 * Screenshot lands in e2e/test-results/final-cleanup/ (gitignored).
 */

const SHOTS = new URL(
  "./test-results/final-cleanup/",
  import.meta.url,
).pathname;

const STARTED_AT = "2026-07-11T12:00:00.000Z";
const HUMAN_TIME = "Jul 11, 2026, 12:00 PM";

/** Two runs whose machine values are the ones a person must never be shown: the
 *  refused unattended run, and the run that stopped loudly on a permission
 *  nobody had allowed yet (there is no parked run any more — a missing
 *  permission ends the run and the person runs it again). */
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
    id: "run_needs_permission",
    appId: "app_auto",
    trigger: { kind: "schedule" },
    status: "error",
    startedAt: STARTED_AT,
    finishedAt: "2026-07-11T12:00:03.000Z",
    steps: [],
    summary: "stopped at notify: it needs a permission nobody has allowed yet — allow it and run this again",
    error: { code: "needs-permission", message: "needs permission to use host_notify", tool: "host_notify" },
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
  await expect(history.locator(".fl-act-lbl")).toHaveText(["Failed", "Failed"]);
  await expect(history.locator(".fl-act-sub").first()).toHaveText(HUMAN_TIME);

  // The machine value the row used to print, now absent from the page's text.
  const rendered = await history.innerText();
  expect(rendered).not.toContain(STARTED_AT);

  // …and still present where a machine reads them.
  await expect(history.locator("time").first()).toHaveAttribute("datetime", STARTED_AT);

  await page.screenshot({ path: `${SHOTS}automations-run-history.png` });
});
