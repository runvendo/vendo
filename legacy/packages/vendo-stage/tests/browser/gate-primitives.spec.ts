import { test, expect } from "@playwright/test";

/**
 * Brand-tier gate: the enriched layout primitives express host-like structure
 * purely from the injected --vendo-* tokens.
 *
 *  - Surface: the host-card look (surface bg, border, radius, shadow, padding)
 *  - Divider: hairline separator
 *  - Text variants: label (uppercase, letter-spaced, muted), value
 *    (tabular numerals, larger), muted
 *  - Containers: named gap tokens (xs..xl) resolve to the spacing scale
 */
test("gate primitives: Surface/Divider/Text variants render token-driven styles", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=primitives-rich");
  const frame = page.frameLocator("#vendo-stage");

  // Surface: card look from the injected tokens (fixture theme surface = #fff).
  const surface = frame.locator('[data-primitive="Surface"]').first();
  await expect(surface).toBeVisible();
  const s = await surface.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, radius: cs.borderRadius, borderWidth: cs.borderTopWidth, padding: cs.paddingTop };
  });
  expect(s.bg).toBe("rgb(255, 255, 255)");
  expect(s.radius).not.toBe("0px");
  expect(s.borderWidth).toBe("1px");
  expect(parseFloat(s.padding)).toBeGreaterThanOrEqual(12);

  // Divider: a 1px hairline.
  const divider = frame.locator('[data-primitive="Divider"]').first();
  await expect(divider).toBeAttached();
  const dh = await divider.evaluate((el) => getComputedStyle(el).height);
  expect(dh).toBe("1px");

  // Text variant "label": uppercase, letter-spaced, muted color.
  const label = frame.locator('[data-primitive="Text"][data-variant="label"]').first();
  const l = await label.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { tt: cs.textTransform, ls: cs.letterSpacing, color: cs.color };
  });
  expect(l.tt).toBe("uppercase");
  expect(l.ls).not.toBe("normal");
  expect(l.color).toBe("rgb(138, 139, 146)"); // fixture --vendo-fg-muted #8A8B92

  // Text variant "value": tabular numerals, heavier weight.
  const value = frame.locator('[data-primitive="Text"][data-variant="value"]').first();
  const v = await value.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fvn: cs.fontVariantNumeric, weight: parseInt(cs.fontWeight, 10) };
  });
  expect(v.fvn).toContain("tabular-nums");
  expect(v.weight).toBeGreaterThanOrEqual(600);

  // Container gap tokens: Stack gap="md" resolves to 12px.
  const stack = frame.locator('[data-primitive="Stack"]').first();
  const gap = await stack.evaluate((el) => getComputedStyle(el).rowGap);
  expect(gap).toBe("12px");
});
