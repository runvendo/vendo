import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * FORMAT-EVOLUTION FIRE DRILL — the UI renderer-registry seam proven in a REAL
 * browser (08-ui §5; 01-core §8). A throwaway second UI format `vendo/tree@2-drill`
 * is registered ONLY in the test harness, never in product source. The three
 * proofs the evolution story requires:
 *   (a) a registered drill renderer renders the drill payload;
 *   (b) an unregistered drill tag contains to a notice — the page never breaks,
 *       and a v1 tree elsewhere on the page is unaffected;
 *   (c) a stored v0 tree renders identically whether or not the drill is
 *       registered ("a runtime keeps rendering every format it ever registered").
 */

const DRILL_FORMAT = "vendo/tree@2-drill";

test("(a) a registered drill renderer renders the drill payload", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "format-drill-registered");

  const drill = page.locator('section[aria-label="Drill payload"]');
  await expect(drill.getByRole("region", { name: "Drill format surface" })).toBeVisible();
  await expect(drill.getByText("Quarterly revenue")).toBeVisible();
  await expect(drill.getByText("$4,200 across 3 invoices")).toBeVisible();
  // The registered renderer means NO fallback notice.
  await expect(drill.getByRole("note", { name: "Unsupported UI format" })).toHaveCount(0);

  expect(pageErrors, "a registered format must render without uncaught errors").toEqual([]);
});

test("(b) an unregistered drill tag contains to a notice; the v1 tree beside it is unaffected", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "format-drill-unregistered");

  // The drill surface with no renderer registered → contained notice naming the tag.
  const drill = page.locator('section[aria-label="Drill payload"]');
  await expect(drill.getByRole("note", { name: "Unsupported UI format" })).toContainText(DRILL_FORMAT);
  await expect(drill.getByRole("region", { name: "Drill format surface" })).toHaveCount(0);

  // The v1 tree on the SAME page rendered normally — the contained failure did
  // not leak past its own surface.
  const stored = page.locator('section[aria-label="Stored v0 tree"]');
  await expect(stored.getByText("Stored v0 invoice")).toBeVisible();
  await expect(stored.getByText("4200")).toBeVisible();

  await expect(page.getByText("Host content after the drill surfaces survived.")).toBeVisible();
  expect(pageErrors, "an unregistered format is a contained failure, never an uncaught error").toEqual([]);
});

test("(c) the stored v0 tree renders identically with and without the drill registered", async ({ page }) => {
  const readStored = async (scenario: string): Promise<string> => {
    await openScenario(page, scenario);
    const stored = page.locator('section[aria-label="Stored v0 tree"]');
    await expect(stored.getByText("Stored v0 invoice")).toBeVisible();
    // Normalize the rendered surface to compare structure + text across pages.
    return (await stored.locator('[data-vendo-node-id="root"]').innerHTML()).trim();
  };

  const withDrill = await readStored("format-drill-registered");
  const withoutDrill = await readStored("format-drill-unregistered");
  expect(withDrill, "a stored v0 record renders identically regardless of newer registered formats")
    .toBe(withoutDrill);
  expect(withDrill).toContain("Stored v0 invoice");
  expect(withDrill).toContain("4200");
});
