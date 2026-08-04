/**
 * The center's a11y, focus and containment contracts — in CI.
 *
 * These claims used to live in a one-shot proof script under
 * `docs/superpowers/evidence/.../postcheck-b/center.proof.spec.ts`, outside
 * `playwright.config.ts`'s `testDir`. A spec that runs once and is then filed as
 * evidence cannot catch a regression; ruling 21 says a test that cannot fail is
 * not a test, and one that can never run again is worse. Lifted here verbatim in
 * intent, minus the hardcoded screenshot paths (evidence is a separate job).
 *
 * This file is also the CI home of the four browser-only mechanisms the wave
 * otherwise pinned only in jsdom:
 *   `inert`         — H11 tile previews, H12 the takeover inerting the host
 *   focus order     — H10 tab-stop recovery, M34 the mobile sheet's trap
 *   IntersectionObserver — H16, a tile below the fold boots nothing
 *   `:has()`        — see smoke.spec.ts §8 (the build-suppression rule is a
 *                     `:has()` rule and is asserted through computed style)
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
  expect(await page.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
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
});

test("H18: a keyboard walk of the rail destroys nothing", async ({ page }) => {
  await openCenter(page, "/page-chat");
  const row = page.locator(".fl-rail-chat[aria-current='page']").first();
  await expect(row).toBeVisible();
  const conversation = (await row.textContent())!;

  // ⚠️ TEST EDIT — H18's GUARANTEE is unchanged and still asserted below: an
  // arrow walk of the rail destroys neither the open conversation nor the
  // draft. What changed is why it holds. It used to rest on the tablist
  // refusing to activate on arrow (manual activation), which the rail needed
  // only because "New chat" — an ACT — was one of its tabs. The act is a plain
  // button outside the tablist now, so the arrows CANNOT REACH IT AT ALL, and
  // the remaining tabs (all views) select as you move, per APG.
  await page.getByRole("textbox", { name: "Message" }).fill("half-typed question the arrows must not eat");
  const newChat = page.getByRole("button", { name: "New chat" });
  await page.getByRole("tab", { name: "Apps" }).click();
  await page.getByRole("tab", { name: "Apps" }).focus();
  for (const key of ["ArrowUp", "ArrowUp", "ArrowDown", "Home", "End"]) {
    await page.keyboard.press(key);
  }
  // The walk never landed on the act, and the conversation is still the open
  // one — the half-typed question was not eaten.
  await expect(newChat).not.toBeFocused();
  await expect(newChat).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator(".fl-rail-chat[aria-current='page']").first()).toHaveText(conversation);

  // Clicking the act is what starts over — and only then.
  await newChat.click();
  await expect(newChat).toHaveAttribute("aria-current", "page");
});

test("H11: nothing inside a live tile preview is reachable", async ({ page }) => {
  await page.goto("/page");
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  const inside = await page.evaluate(() => {
    const previews = [...document.querySelectorAll(".fl-tile-view")];
    return {
      previews: previews.length,
      inert: previews.filter(node => node.hasAttribute("inert")).length,
      // `aria-hidden` alone was the old lie: screen readers were told to skip a
      // subtree the keyboard could still walk into. `inert` does both.
      ariaHidden: previews.filter(node => node.getAttribute("aria-hidden") === "true").length,
    };
  });
  expect(inside.previews).toBeGreaterThan(0);
  expect(inside.inert).toBe(inside.previews);
  expect(inside.ariaHidden).toBe(0);

  // The real browser's own answer: plant a focusable in every preview, focus it,
  // and watch `inert` refuse. jsdom cannot answer this question at all.
  const reachable = await page.evaluate(() => {
    const previews = [...document.querySelectorAll(".fl-tile-view")];
    return previews.filter((preview) => {
      const planted = document.createElement("button");
      planted.type = "button";
      planted.textContent = "Pay now";
      preview.appendChild(planted);
      planted.focus();
      return document.activeElement === planted;
    }).length;
  });
  expect(reachable, "a planted button inside an inert preview must refuse focus").toBe(0);
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

test("M34: the mobile sheet takes focus, traps it, and gives it back on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCenter(page, "/page-chat");
  const chats = page.getByRole("button", { name: "Chats" });
  await chats.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("complementary", { name: "Conversations" });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole("button", { name: "Close conversations" })).toBeFocused();
  // Tab cycles inside the sheet rather than walking into the covered page.
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    const still = await page.evaluate(() => document.querySelector(".fl-center-sheet")!.contains(document.activeElement));
    expect(still, `Tab ${index + 1} stayed in the sheet`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(chats).toBeFocused();
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
  const measured = Object.entries(contrast).filter(([, value]) => value !== null);
  expect(measured.length, "nothing was measured — the selectors went stale").toBeGreaterThan(0);
  for (const [name, value] of measured) {
    expect(value, `${name} = ${value?.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  }
});

/**
 * H16 driven through IntersectionObserver itself rather than through scrolling.
 *
 * The harness grid holds three tiles and `useInViewport` boots 200px AHEAD of
 * the viewport, so no honest viewport size puts a tile outside the gate — a
 * scroll-based test here would pass whether or not the gate existed. Replacing
 * the observer with one WE fire is the only way to hold a tile on each side of
 * the gate deliberately. jsdom cannot answer this at all (it has no
 * IntersectionObserver, which is precisely the fail-open branch below).
 */
const CONTROLLED_OBSERVER = () => {
  const pending: (() => void)[] = [];
  class Controlled {
    constructor(private readonly callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {}
    observe(target: Element): void {
      pending.push(() => this.callback([{ isIntersecting: true, target }]));
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Controlled;
  (globalThis as unknown as { __vendoSeeEverything: () => void }).__vendoSeeEverything = () => {
    for (const fire of pending.splice(0)) fire();
  };
};

test("H16: a tile the observer has not reported boots nothing, and boots when it does", async ({ page }) => {
  await page.addInitScript(CONTROLLED_OBSERVER);
  await page.goto("/page");
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(800);

  const skeletons = await page.locator(".fl-tile-skel").count();
  expect(skeletons, "every view-bearing tile must still be a skeleton").toBeGreaterThan(0);
  await expect(page.locator(".fl-tile-scale")).toHaveCount(0);

  // Now report them all as on screen. The gate delays work, it never drops it.
  await page.evaluate(() => (globalThis as unknown as { __vendoSeeEverything(): void }).__vendoSeeEverything());
  await expect(page.locator(".fl-tile-scale")).toHaveCount(skeletons, { timeout: 10_000 });
});

test("H16 fails OPEN: an engine with no IntersectionObserver still shows every tile", async ({ page }) => {
  await page.addInitScript(() => {
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  });
  await page.goto("/page");
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  // A missing browser API must never hide a surface.
  await expect(page.locator(".fl-tile-scale").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".fl-tile-skel")).toHaveCount(0);
});
