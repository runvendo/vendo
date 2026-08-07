import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * Wave-3 fix lane A, in a real browser — the consumer voice law (design §3): a
 * sentence written for a HOST DEVELOPER must never reach the person using the
 * product. The sharing cases (F1/F2/F11/F12) were vehicles on the deleted
 * full-page surface and went with it; the automations case is what remains.
 *
 * Screenshots land in docs/verification/wave3-fix-a/ (gitignored, like every
 * other lane's).
 */

const SHOTS = new URL("../../../docs/verification/wave3-fix-a/", import.meta.url).pathname;

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test("a stopped automation is findable, with the reason in the consumer's words", async ({ page }) => {
  // B-3 / §9.9 — a lapsed sponsorship STOPS the automation. The panel rendered
  // it as an ordinary "Disabled", which reads as something somebody switched
  // off, so nobody had a reason to come looking (E8-F2).
  await page.route("**/api/vendo/automations", async (route) => {
    const answer = await route.fetch();
    const entries = await answer.json() as Array<Record<string, unknown>>;
    // Per TRIGGER, not per app: sponsorship is held by one trigger of an app,
    // so a lapse stops that trigger and leaves its siblings running.
    const stopped = entries.map((item, index) => index === 0
      ? {
          ...item,
          triggers: (item["triggers"] as Array<Record<string, unknown>>).map((row, position) =>
            position === 0
              ? {
                  ...row,
                  enabled: false,
                  stopped: {
                    reason: "departure",
                    summary: "This stopped because the person it ran as no longer has access to the app.",
                  },
                }
              : row),
        }
      : item);
    await route.fulfill({ response: answer, json: stopped });
  });

  await openScenario(page, "automations");
  const row = page.locator(".fl-automation").first();
  // The state WORD, not merely the summary sentence that happens to contain it:
  // `stopped` outranks a run row still marked running, and "Disabled" (which
  // reads as somebody's choice) is gone.
  await expect(row.locator(".fl-auto-sub").first()).toHaveText("Stopped");
  await expect(row).toContainText("no longer has access to the app");
  await expect(row).not.toContainText("Disabled");
  await expect(row).not.toContainText("running now");
  await page.screenshot({ path: `${SHOTS}b3-stopped-automation.png` });
});
