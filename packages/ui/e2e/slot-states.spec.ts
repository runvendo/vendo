import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/**
 * The slot's own build vocabulary, in a real browser over the real wire.
 *
 * A placement row is written the moment the app id is minted, so an EMPTY slot
 * knows it is about to be filled while the build is still streaming: the
 * skeleton, then the live app, without a reload. (A slot carrying the host's own
 * markup keeps it until the build is ready — a working host component never
 * blanks into a skeleton.) Both READY surface kinds are proven here — a tree
 * payload and a served (http) machine url — because a slot that only ever
 * mounted trees would ship broken for every rung-4 app.
 */

/** The reason the harness wire puts on `app_slot_failed` (e2e/harness/vite.config.ts).
 *  The slot prints it as written — it names the thing that has to change. */
const BUILD_FAILURE_REASON = "This app wasn't created, because it didn't pass the checks that keep an app honest:"
  + " the `value` expression is a declarative string that the DataTable does not evaluate,"
  + " not JavaScript: amount / sum(spending.data.amount)";

test("a placed build narrates itself: skeleton, then the live app in place", async ({ page }) => {
  // Seeded by the test: placing a landing app rewinds its build window, so a CI
  // retry gets the same story instead of a slot that already filled.
  await page.request.post("/api/vendo/apps/app_slot_building/place", { data: { slot: "slot-building" } });
  await openScenario(page, "slot-building");

  const slot = page.locator('[data-vendo-slot="slot-building"]');
  await expect(slot.getByRole("status")).toContainText("Building your view");
  await page.screenshot({ path: screenshotPath("slot-building"), animations: "disabled" });
  await expect(slot.getByText("Trip planner app surface")).toBeVisible({ timeout: 20_000 });
});

test("a ready slot mounts BOTH surface kinds — a tree payload and a served machine url", async ({ page }) => {
  await openScenario(page, "slot-states");

  const tree = page.locator('[data-vendo-slot="slot-ready"]');
  await expect(tree.getByText("Invoices app surface")).toBeVisible();

  const served = page.locator('[data-vendo-slot="slot-http"] iframe[title="Vendo app"]');
  await expect(served).toBeVisible();
  await expect(served).toHaveAttribute("src", "/frame-target.html");
  await expect(
    page.frameLocator('[data-vendo-slot="slot-http"] iframe[title="Vendo app"]').getByText("Local HTTP app"),
  ).toBeVisible();
  // `animations: "disabled"` runs the reveal to its end state first — a
  // screenshot caught mid cross-fade shows the host's markup and the app on top
  // of each other, which is evidence of nothing.
  await page.screenshot({ path: screenshotPath("slot-states"), fullPage: true, animations: "disabled" });
});

test("a failed build says the reason it was given, whole, on the host page", async ({ page }) => {
  await openScenario(page, "slot-states");
  const slot = page.locator('[data-vendo-slot="slot-failed"]');
  await expect(slot.getByRole("alert")).toBeVisible();
  await expect(slot.getByText(BUILD_FAILURE_REASON)).toBeVisible();
  await expect(slot.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(slot.getByRole("button", { name: "Clear this slot" })).toBeVisible();
  await slot.screenshot({ path: screenshotPath("slot-failed"), animations: "disabled" });

  const rendered = (await slot.innerText()).replace(/\s+/g, " ");
  expect(rendered).toContain(BUILD_FAILURE_REASON.replace(/\s+/g, " "));
});

test("clearing a failed slot gives the host its own markup back", async ({ page }) => {
  // Seeded by the test, not the harness: this case UNPLACES, and CI retries
  // would otherwise re-run it against a slot it already emptied.
  await page.request.post("/api/vendo/apps/app_slot_failed/place", { data: { slot: "slot-failed-clear" } });
  await openScenario(page, "slot-states");

  const section = page.getByRole("region", { name: "Slot failed clear" });
  await section.getByRole("button", { name: "Clear this slot" }).click();
  await expect(section.getByText("Host hero (clear me)")).toBeVisible();
  await expect(page.locator('[data-vendo-slot="slot-failed-clear"]')).toHaveCount(0);
});

test("Add to… puts the embed's app into a slot on the same page", async ({ page }) => {
  // Idempotent under retries: clear whatever a previous attempt placed.
  await page.request.post("/api/vendo/apps/app_1/unplace", { data: { slot: "picker-target" } });
  await openScenario(page, "slot-picker");

  await expect(page.getByText("Host hero (empty)")).toBeVisible();
  await page.getByRole("button", { name: "Add to…" }).click();
  // The open menu, photographed: it hangs off the app-card bar, which is the one
  // place it could be clipped.
  await expect(page.getByRole("menu")).toBeVisible();
  await page.screenshot({ path: screenshotPath("slot-picker-menu"), fullPage: true, animations: "disabled" });
  await page.getByRole("menuitem", { name: "Picker target" }).click();

  await expect(page.getByRole("button", { name: "Added to Picker target" })).toBeVisible();
  await expect(page.locator('[data-vendo-slot="picker-target"]').getByText("Invoices app surface")).toBeVisible();
  await page.screenshot({ path: screenshotPath("slot-picker"), fullPage: true, animations: "disabled" });
});
