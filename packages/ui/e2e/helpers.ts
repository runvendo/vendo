import { expect, type FrameLocator, type Page } from "@playwright/test";

export const screenshotPath = (name: string) => new URL(`./screenshots/${name}.png`, import.meta.url).pathname;

export async function openScenario(page: Page, name: string): Promise<void> {
  await page.goto(`/${name}`);
  await expect(page.locator(`main[data-scenario="${name}"]`)).toBeVisible();
}

export async function expectFocusIndicator(page: Page): Promise<void> {
  const visible = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return false;
    const style = getComputedStyle(active);
    return (style.outlineStyle !== "none" && style.outlineWidth !== "0px")
      || (style.boxShadow !== "none" && style.boxShadow !== "");
  });
  expect(visible, "keyboard focus must have a visible outline or box-shadow").toBe(true);
}

/** Assert that every currently visible native interactive can join the keyboard tab cycle. */
export async function expectKeyboardReachability(page: Page, scopeSelector = "body"): Promise<void> {
  const positive = await page.locator("[tabindex]").evaluateAll(nodes => nodes
    .map(node => Number(node.getAttribute("tabindex")))
    .filter(value => value > 0));
  expect(positive, "positive tabindex is forbidden").toEqual([]);

  const expected = await page.locator(scopeSelector).evaluate((scope, selector) => {
    const candidates = [...scope.querySelectorAll<HTMLElement>(selector)];
    return candidates.filter(element => {
      if (element.matches(":disabled") || element.tabIndex < 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && (element.offsetWidth > 0 || element.offsetHeight > 0);
    }).map((element, index) => {
      const id = `keyboard-target-${index}`;
      element.dataset.keyboardTarget = id;
      return id;
    });
  }, "button,input,textarea,select,a[href],summary,[tabindex]");

  expect(expected.length, `${scopeSelector} should expose keyboard interactions`).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (let index = 0; index < expected.length * 3 + 3; index += 1) {
    const current = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.keyboardTarget);
    if (current) {
      seen.add(current);
      await expectFocusIndicator(page);
    }
    if (expected.every(id => seen.has(id))) break;
    await page.keyboard.press("Tab");
  }
  expect([...seen].sort(), `all visible interactions in ${scopeSelector} must be tabbable`).toEqual([...expected].sort());
}

export async function tabTo(page: Page, predicate: () => Promise<boolean>, limit = 40): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (await predicate()) {
      await expectFocusIndicator(page);
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard target was not reached within the tab limit.");
}

/**
 * The jail is two nested frames (see JailedComponent): the host's iframe is a
 * trusted relay whose CSP jails the inner frame's navigations; generated code
 * runs one level down.
 */
export function jailFrame(page: Page, componentName: string): FrameLocator {
  return page
    .frameLocator(`iframe[title="Generated component: ${componentName}"]`)
    .frameLocator('iframe[title="Generated Vendo component"]');
}
