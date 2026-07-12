import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * 01-core §8; 08-ui §5 — the containment quartet, proven in a real browser.
 * jail-and-tree.spec covers (a) an erroring node → contained placeholder and the
 * initial skeleton of (b) dangling children. These are the remaining three:
 * (b) the skeleton later swaps in, (c) an unknown formatVersion contains, and
 * (d) a throwing pin falls back to the original host component.
 */

test("dangling child skeleton swaps in when the streamed node arrives", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "tree-stream");

  // Before completion: the missing child renders a streaming skeleton.
  await expect(page.locator('[data-dangling-node="late"] [data-primitive="Skeleton"]')).toBeVisible();
  await expect(page.getByText("Streamed node arrived")).toBeHidden();

  // After completion: the real node swaps in and the skeleton is gone.
  await expect(page.getByText("Streamed node arrived")).toBeVisible();
  await expect(page.locator('[data-dangling-node="late"]')).toHaveCount(0);
  expect(pageErrors, "streaming completion must not surface uncaught errors").toEqual([]);
});

test("an unknown formatVersion contains to a notice, direct and in a thread", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "unknown-format");

  // Direct: the renderer dispatches by tag and finds no match → contained notice.
  const direct = page.locator('section[aria-label="Unknown format direct"]');
  await expect(direct.getByRole("note", { name: "Unsupported UI format" })).toContainText("vendo-genui/v999");
  await expect(direct.getByText("Host content after the direct unknown surface survived.")).toBeVisible();

  // In-thread: a VendoViewPart with an unknown payload contains without breaking
  // the surrounding conversation — the trailing message still renders.
  const thread = page.locator('section[aria-label="Unknown format in thread"]');
  await expect(thread.getByRole("note", { name: "Unsupported UI format" })).toContainText("vendo-genui/v999");
  await expect(thread.getByText("The conversation keeps going past the unknown surface.")).toBeVisible();

  expect(pageErrors, "an unknown format is a contained failure, never an uncaught error").toEqual([]);
});

test("a throwing pin mount falls back to the original host component", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "slot-fallback");

  // The app open() throws; the pin error boundary shows the original children.
  await expect(page.getByRole("heading", { name: "Original host hero" })).toBeVisible();
  await expect(page.getByText("Host fallback stayed on screen.")).toBeVisible();

  // Only the deliberately-thrown pin error may reach the page error channel.
  const unexpected = pageErrors.filter(message => !message.includes("pin mount exploded during render"));
  expect(unexpected, "the pin failure must not escape its boundary").toEqual([]);
});
