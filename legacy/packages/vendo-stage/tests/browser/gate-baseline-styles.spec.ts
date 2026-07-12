import { test, expect } from "@playwright/test";

/**
 * Srcdoc baseline gate (audit F5): the sandbox document must give generated
 * markup a sane, brand-driven starting point — the injected --vendo-* vars
 * have to be CONSUMED by the document, not just defined on :root. Without a
 * baseline, bare markup renders with the UA serif default and an 8px body
 * margin ("web page from 1996").
 */
test("gate baseline: sandbox body inherits the brand font, fg color, and has no default margin", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=card");
  const frame = page.frameLocator("#vendo-stage");
  await expect(frame.getByRole("heading", { name: "Hello" })).toBeVisible();

  const body = frame.locator("body");
  const styles = await body.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fontFamily: cs.fontFamily, margin: cs.margin, color: cs.color };
  });

  // The fixture theme sets --vendo-font: "TestBrandFont, sans-serif" and
  // --vendo-fg: #111. The body must consume both.
  expect(styles.fontFamily).toContain("TestBrandFont");
  expect(styles.margin).toBe("0px");
  expect(styles.color).toBe("rgb(17, 17, 17)");
});
