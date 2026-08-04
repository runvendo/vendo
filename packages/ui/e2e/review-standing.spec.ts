import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/**
 * Remix final shape (2026-08-02) — the review-kind standing in a real
 * browser: an unapproved review-kind payload (venue `pending-review`, no
 * component source shipped) renders ONLY its standing — "sent for review",
 * or the reviewer's rejection note — never a jailed fork, never an
 * invalid-tree verdict, never the drop-back vocabulary.
 */
test("pending and rejected review standings render their notices, and nothing jails", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "tree-review");

  const pending = page.locator('section[aria-label="Remix sent for review"]');
  await expect(pending.getByRole("note", { name: "Sent for review" }))
    .toContainText("original component stays in place");

  const rejected = page.locator('section[aria-label="Remix rejected with a note"]');
  const note = rejected.getByRole("note", { name: "Remix rejected" });
  await expect(note).toContainText("Keep the original balance label.");
  await expect(note).toContainText("resubmit");

  // No jailed render anywhere, no in-client mount, no wrong vocabulary.
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("[data-vendo-inclient-mount]")).toHaveCount(0);
  await expect(page.getByRole("note", { name: "In-client approval invalidated" })).toHaveCount(0);
  await expect(page.getByRole("note", { name: "Invalid UI tree" })).toHaveCount(0);

  expect(pageErrors, "the review standings must not throw uncaught page errors").toEqual([]);
  await page.screenshot({ path: screenshotPath("tree-review"), fullPage: true, animations: "disabled" });
});
