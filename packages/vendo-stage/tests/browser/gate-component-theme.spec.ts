import { test, expect } from "@playwright/test";

/**
 * Gate: the componentTheme wrapper mounts (TU-3 runtime↔bundle contract).
 *
 * When an init payload carries an opaque `componentTheme`, the runtime mounts the
 * host bundle's `window.__VENDO_THEME_WRAP__(blob, children)` around the tree
 * (see runtime.ts buildElement). The sample bundle implements that wrapper with a
 * React context; the registered `ThemeProbe` host component reads `blob.marker`
 * out of it. Proving both the "present" and "absent" paths pins the gating: the
 * wrap runs only when componentTheme is supplied, and it forwards the blob opaquely.
 *
 * This validates the MECHANISM with a sample wrapper — no OpenUI needed.
 */
test("gate component-theme: componentTheme mounts the bundle wrap and passes the blob through", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=component-theme");
  const frame = page.frameLocator("#vendo-stage");

  const marker = frame.locator("[data-theme-marker]");
  await expect(marker).toBeVisible();
  await expect(marker).toHaveText("themed-ok");
});

test("gate component-theme: WITHOUT componentTheme the wrap is a no-op (empty marker)", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=component-theme-none");
  const frame = page.frameLocator("#vendo-stage");

  // The probe still renders (proving it mounted) but empty — an empty inline
  // span has zero size, so assert attachment rather than visibility.
  const marker = frame.locator("[data-theme-marker]");
  await expect(marker).toBeAttached();
  // No wrap ⇒ no context provider ⇒ ctx?.marker is undefined ⇒ empty span.
  const text = await marker.textContent();
  expect(text).toBe("");
});
