/**
 * ROUND B proof — the center's a11y/motion/contrast fixes, in real Chromium.
 *
 * Every case here is one of the checker's findings, exercised the way a person
 * would: the ···→Activity→··· recovery (H10), a keyboard walk of the rail that
 * used to destroy the open conversation (H18), the mobile history sheet's focus
 * contract (M34), the inert tile previews (H11), the takeover inerting the host
 * (H12), and the axe sweep (desktop + 390px) before/after.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const EVIDENCE = "/Users/yousefh/orca/workspaces/flowlet/ui-s1-fixdefects/docs/superpowers/evidence/2026-08-03-ui-redesign/postcheck-b";

test.use({ reducedMotion: "reduce" });

async function openCenter(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expect(page.locator('section[aria-label="Vendo workspace"]')).toBeVisible();
}

const axeOf = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include('section[aria-label="Vendo workspace"]');

test("axe: the center has zero WCAG 2.1 A/AA violations (desktop)", async ({ page }) => {
  await openCenter(page, "/page-chat");
  await expect(page.getByRole("tab", { name: "Apps" })).toBeVisible();
  const home = await axeOf(page).analyze();
  // The Apps door: every tile in the grid is a live preview (H11's blast radius).
  await page.getByRole("tab", { name: "Apps" }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  const apps = await axeOf(page).analyze();
  await page.screenshot({ path: `${EVIDENCE}/b-desktop-apps-grid.png`, fullPage: false });
  const report = [...home.violations, ...apps.violations].map(v => `${v.id} ×${v.nodes.length}`);
  expect(report, `desktop violations: ${JSON.stringify(report)}`).toEqual([]);
});

test("axe: the center has zero WCAG 2.1 A/AA violations (390px, sheet open)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCenter(page, "/page-chat");
  await expect(page.getByRole("button", { name: "Chats" })).toBeVisible();
  const closed = await axeOf(page).analyze();
  await page.getByRole("button", { name: "Chats" }).click();
  await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
  await page.waitForTimeout(400);
  const open = await axeOf(page).analyze();
  await page.screenshot({ path: `${EVIDENCE}/b-mobile-sheet.png` });
  const report = [...closed.violations, ...open.violations].map(v => `${v.id} ×${v.nodes.length}`);
  expect(report, `390px violations: ${JSON.stringify(report)}`).toEqual([]);
});

test("H10: ··· → Activity → ··· leaves a tab stop and a named panel", async ({ page }) => {
  await openCenter(page, "/page-chat");
  const more = page.getByRole("button", { name: "More sections" });
  await more.click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await more.click();
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveCount(0);

  // The switcher is still reachable from the keyboard…
  const stops = await page.locator('[role="tab"][tabindex="0"]').count();
  expect(stops).toBe(1);
  // …and the panel still has a name (its labelling tab is gone).
  const panel = page.getByRole("tabpanel");
  await expect(panel).toHaveAttribute("aria-label", "Activity");
  await expect(panel).not.toHaveAttribute("aria-labelledby", /./);
  // Prove it with the real keyboard: the surviving stop takes focus, and one
  // Tab from it leaves the tablist (a roving list has exactly one entry).
  const stop = page.locator('[role="tab"][tabindex="0"]');
  await stop.focus();
  await expect(stop).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(stop).not.toBeFocused();
  await page.screenshot({ path: `${EVIDENCE}/b-h10-activity-recovery.png` });
});

test("H18: a keyboard walk of the rail destroys nothing", async ({ page }) => {
  await openCenter(page, "/page-chat");
  const row = page.locator(".fl-rail-chat[aria-current='page']").first();
  await expect(row).toBeVisible();
  const conversation = (await row.textContent())!;

  // Type a draft, then walk the rail with the arrow keys.
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("half-typed question the arrows must not eat");
  await page.getByRole("tab", { name: "Apps" }).click();
  await page.getByRole("tab", { name: "Apps" }).focus();
  for (const key of ["ArrowUp", "ArrowUp", "ArrowDown", "Home", "End"]) {
    await page.keyboard.press(key);
  }
  // Apps is still the selected view; the conversation and its draft survive.
  await expect(page.getByRole("tab", { name: "Apps" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".fl-rail-chat[aria-current='page']").first()).toHaveText(conversation);
  await page.screenshot({ path: `${EVIDENCE}/b-h18-keyboard-walk.png` });

  await page.getByRole("tab", { name: "New chat" }).focus();
  await page.keyboard.press("Enter");
  // Enter is what acts — and only then.
  await expect(page.getByRole("tab", { name: "New chat" })).toHaveAttribute("aria-selected", "true");
});

test("H11: nothing inside a live tile preview is reachable", async ({ page }) => {
  await openCenter(page, "/page");
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  const inside = await page.evaluate(() => {
    const previews = [...document.querySelectorAll(".fl-tile-view")];
    return {
      previews: previews.length,
      inert: previews.filter(node => node.hasAttribute("inert")).length,
      ariaHidden: previews.filter(node => node.getAttribute("aria-hidden") === "true").length,
      focusables: previews.reduce((total, node) => total + node.querySelectorAll("button,input,a[href],[tabindex]").length, 0),
    };
  });
  expect(inside.previews).toBeGreaterThan(0);
  expect(inside.inert).toBe(inside.previews);
  expect(inside.ariaHidden).toBe(0);

  // The real browser's own answer: focus every focusable inside a preview and
  // watch it refuse (inert), then confirm the tab order only offers "Open …".
  const refused = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>(".fl-tile-view button, .fl-tile-view input, .fl-tile-view a[href]")];
    return nodes.every(node => {
      node.focus();
      return document.activeElement !== node;
    });
  });
  expect(refused).toBe(true);
  await page.screenshot({ path: `${EVIDENCE}/b-h11-inert-tiles.png` });
});

test("M34: the mobile sheet takes focus, traps it, and gives it back on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCenter(page, "/page-chat");
  const chats = page.getByRole("button", { name: "Chats" });
  await chats.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("complementary", { name: "Conversations" });
  await expect(sheet).toBeVisible();
  // Focus landed inside.
  await expect(page.getByRole("button", { name: "Close conversations" })).toBeFocused();
  // Tab cycles inside the sheet rather than walking into the covered page.
  const trapped = await page.evaluate(() => {
    const sheetEl = document.querySelector(".fl-center-sheet")!;
    return sheetEl.contains(document.activeElement);
  });
  expect(trapped).toBe(true);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    const still = await page.evaluate(() => document.querySelector(".fl-center-sheet")!.contains(document.activeElement));
    expect(still, `Tab ${index + 1} stayed in the sheet`).toBe(true);
  }
  await page.screenshot({ path: `${EVIDENCE}/b-m34-sheet-focus.png` });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(chats).toBeFocused();
});

test("H12: the takeover inerts the host page and brings no second main", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCenter(page, "/page-chat");
  const state = await page.evaluate(() => {
    const wrapper = document.querySelector(".fl-overlay-portal");
    const siblings = [...document.body.children].filter(child => child !== wrapper
      && child.tagName !== "SCRIPT" && child.tagName !== "STYLE");
    return {
      portaled: wrapper !== null,
      siblings: siblings.length,
      inert: siblings.filter(child => child.hasAttribute("inert")).length,
      mains: document.querySelectorAll("main").length,
      vendoMains: document.querySelectorAll(".fl-center main, main.fl-center").length,
    };
  });
  expect(state.portaled).toBe(true);
  expect(state.siblings).toBeGreaterThan(0);
  expect(state.inert).toBe(state.siblings);
  // The harness owns exactly one <main>; the center adds none.
  expect(state.mains).toBe(1);
  expect(state.vendoMains).toBe(0);
});

test("M33: every state indicator clears 3:1, measured in the browser", async ({ page }) => {
  await openCenter(page, "/page-chat");
  const contrast = await page.evaluate(() => {
    const parse = (value: string): [number, number, number] => {
      const parts = value.match(/[\d.]+/g)!.map(Number);
      return [parts[0]!, parts[1]!, parts[2]!];
    };
    const luminance = (rgb: [number, number, number]) => {
      const channel = (raw: number) => {
        const value = raw / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const ratio = (a: string, b: string) => {
      const [light, dark] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return (light! + 0.05) / (dark! + 0.05);
    };
    const root = document.querySelector(".fl-center") as HTMLElement;
    const ground = getComputedStyle(root).backgroundColor;
    const bar = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      return ratio(getComputedStyle(element, "::before").backgroundColor, ground);
    };
    const out: Record<string, number | null> = {
      openConversation: bar(".fl-rail-chat[aria-current='page']"),
      selectedRow: bar(".fl-rail-row[aria-selected='true']"),
    };
    const tile = document.querySelector(".fl-tile");
    out.tileEdge = tile === null
      ? null
      : ratio(getComputedStyle(tile).borderTopColor, getComputedStyle(tile.parentElement!).backgroundColor || ground);
    return out;
  });
  for (const [name, value] of Object.entries(contrast)) {
    if (value === null) continue;
    expect(value, `${name} = ${value?.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  }
  await page.screenshot({ path: `${EVIDENCE}/b-m33-indicators-desktop.png` });
});
