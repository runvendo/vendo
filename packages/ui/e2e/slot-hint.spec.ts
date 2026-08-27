import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const SHOTS = "/tmp/b1-shots";

test("the empty-press fallback, in a real browser", async ({ page }) => {
  await openScenario(page, "slot-hint");

  // 1 — an empty slot renders.
  const slot = page.locator('[data-vendo-slot="net-worth-card"]');
  await expect(slot.getByRole("button", { name: "Design a view" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-empty-slot.png`, fullPage: true, animations: "disabled" });

  // 2 — the hint, because this page mounts no conversation surface.
  await slot.getByRole("button", { name: "Design a view" }).click();
  await expect(slot.getByRole("status"))
    .toHaveText("Ask your assistant to build something for this spot. Net worth card");
  await expect(slot.getByRole("button", { name: "Design a view" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/2-hint.png`, fullPage: true, animations: "disabled" });

  // 3 — onAuthor wins over both, on the slot beside it.
  await page.locator('[data-vendo-slot="spending-card"]').getByRole("button", { name: "Design a view" }).click();
  await expect(page.getByTestId("authored")).toHaveText("spending-card");
  await page.screenshot({ path: `${SHOTS}/3-onauthor.png`, fullPage: true, animations: "disabled" });
});
