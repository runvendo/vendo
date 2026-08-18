import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const SHOTS = "/tmp/s5-holes";

/**
 * The holes a `<Remixable>` split leaves behind, painted for real. Nothing on
 * this page is in the harness `components` map: the generated wiring const —
 * the same one `createVendo({ remixWiring })` takes — is the only thing that
 * carries these five components to the renderer.
 */
test("remix holes paint real components, from the generated wiring alone", async ({ page }) => {
  await openScenario(page, "tree-holes");

  // The npm hole: real recharts, composed back out of four separate tree nodes
  // through the renderer's own per-node wrappers. Geometry, not just presence —
  // a curve that resolved but drew nothing would pass a DOM-only assertion.
  const curve = page.locator("path.recharts-area-area");
  await expect(curve).toBeVisible();
  const box = await curve.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(200);
  expect(box?.height ?? 0).toBeGreaterThan(40);

  // Its sibling holes drew too, off the host's own data keys.
  await expect(page.locator(".recharts-cartesian-grid")).toBeVisible();
  await expect(page.getByText("Jun", { exact: true })).toBeVisible();

  // The host sub-component hole, resolved by the name the host wrote.
  await expect(page.getByText("$4,820", { exact: true })).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/holes.png`, fullPage: true, animations: "disabled" });
});
