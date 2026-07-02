import { test, expect } from "@playwright/test";

/**
 * Gate: an injected brand var actually themes a sandboxed component.
 *
 * Direct regression guard for "components silently fall back because brand vars
 * aren't injected". The stage is initialized with a DISTINCTIVE --flowlet-accent
 * (#ff00aa); the sample Card's heading reads `color: var(--flowlet-accent)`. We
 * assert the computed color equals the injected value — if the var were dropped
 * the heading would fall back (to the inherited/black default) and this fails.
 */
test("gate theme-vars: injected --flowlet-accent themes the rendered component", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=theme-vars");
  const frame = page.frameLocator("#flowlet-stage");

  const heading = frame.getByRole("heading", { name: "Themed" });
  await expect(heading).toBeVisible();

  const color = await heading.evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe("rgb(255, 0, 170)"); // #ff00aa — the injected brand value, not a fallback
});
