/**
 * §10.1 — the pin, proven as a person meets it. There was no browser proof of
 * this path at all: not the nudge, not the ceremony's flight, and not what a pin
 * does on a host with no slot mounted (which used to be nothing at all — the
 * panel dismissed and the pin vanished).
 *
 * Real Chromium, the production-built harness, the scripted wire fixture. The
 * host's own pin write is stubbed at the wire boundary the way smoke.spec stubs
 * the ask queue, and for the same reason: every spec in the run shares one wire
 * server, so a mutation left behind would leak into its neighbours.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/** The scripted multi-tool + build turn (`[smoke-build]` in the wire fixture). */
const BUILD_TURN = "[smoke-build] a board showing where my money goes";
const BUILT_APP = "app_smoke";

/** The view the pinned app renders — in the thread's card and, once pinned, in
 *  its shelf tile. */
const BUILT_VIEW = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Text", props: { text: "$1,240 this month across 4 categories." } }],
};

/** The record the real runtime would have persisted for the build, placed. */
const BUILT_APP_DOC = {
  format: "vendo/app@1",
  id: BUILT_APP,
  name: "Where my money goes",
  ui: "tree",
  tree: BUILT_VIEW,
  placements: ["hero"],
};

/**
 * The HOST's half of a pin: its own API writes the placement, and the shelf then
 * reads the app back over the wire. `vendo_make`'s fixture turn streams the view
 * without persisting a record, so this stands in for the record the real runtime
 * would have — spec-scoped, so no other spec sees it.
 */
async function hostPinWrite(page: Page): Promise<() => void> {
  let placed = false;
  await page.route("**/api/vendo/apps", async (route) => {
    if (route.request().method() !== "GET") return await route.fallback();
    const response = await route.fetch();
    const apps = (await response.json()) as unknown[];
    await route.fulfill({ json: placed ? [BUILT_APP_DOC, ...apps] : apps });
  });
  // A shelf tile renders the app's OWN view, and `useApp` fetches the document
  // and the surface TOGETHER — stubbing only the list left a real tile reading
  // "This didn't load.", which is a fixture gap, not a product state.
  await page.route(`**/api/vendo/apps/${BUILT_APP}`, async (route) => {
    await route.fulfill({ json: BUILT_APP_DOC });
  });
  await page.route(`**/api/vendo/apps/${BUILT_APP}/open*`, async (route) => {
    await route.fulfill({ json: { kind: "tree", payload: BUILT_VIEW } });
  });
  return () => {
    placed = true;
  };
}

/** Park the nudge on the keyframe at `ms`, or `null` to let it run again.
 *  Photography only — it changes no declared timing, and it seeks the animation
 *  itself: pausing and then rewriting `animation-delay` does NOT re-seek in
 *  Chromium, which silently photographed the same resting frame twice. */
async function freezeAt(target: Locator, ms: number | null): Promise<void> {
  await target.evaluate((node, at) => {
    const nudge = node.getAnimations().find(item => (item as CSSAnimation).animationName === "fl-pin-nudge");
    if (nudge === undefined) throw new Error("the pin nudge is not animating");
    if (at === null) return nudge.play();
    nudge.pause();
    nudge.currentTime = at;
  }, ms);
}

/** The affordance itself, with room around it: the nudge is a ring OUTSIDE the
 *  button's box, so a tight crop would cut off the thing being photographed. */
async function closeUp(page: Page, target: Locator, name: string): Promise<void> {
  const box = (await target.boundingBox())!;
  await page.screenshot({
    path: screenshotPath(name),
    clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 },
  });
}

/** Chromium's animation clock, slowed so a 300ms flight and a 180ms ring can be
 *  photographed. The ceremony's own timings are untouched. */
async function slowMotion(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
}

test("a settled build invites the pin, and the pin lands in the Apps shelf", async ({ page }) => {
  const write = await hostPinWrite(page);
  await openScenario(page, "pin-shelf");

  // The page behind the assistant: the Apps shelf, live, holding real apps. The
  // shelf rides the HOME composer, and the fixture's stored conversation is
  // selected on mount — so start a fresh one, as a person landing here would.
  await page.getByRole("button", { name: "New chat" }).click();
  const shelf = page.getByRole("region", { name: "Your apps" });
  await expect(shelf).toBeVisible();

  // The build happens in the conversation, over the page.
  await page.getByRole("button", { name: "AI agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  await dialog.getByRole("textbox", { name: "Message" }).fill(BUILD_TURN);
  await dialog.getByRole("button", { name: "Send" }).click();

  // While it BUILDS there is no pin at all — §8 gives a build one moving thing.
  await expect(dialog.getByText("Building your view…")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("button", { name: "Pin to dashboard" })).toHaveCount(0);

  // Settled: the pin invites. Quiet, and at the edge of vision.
  await expect(dialog.getByText("Spending board").first()).toBeVisible({ timeout: 25_000 });
  const pin = dialog.getByRole("button", { name: "Pin to dashboard" });
  await expect(pin).toHaveAttribute("data-vendo-pin", "invite");
  await expect(pin).toHaveCSS("animation-iteration-count", /infinite/);
  await page.screenshot({ path: screenshotPath("pin-nudge-invite") });
  // A still cannot show a pulse, so photograph both ENDS of the cycle — rest,
  // then the 45% peak. This proves the ring's shape; the assertion above proves
  // it is actually running.
  await freezeAt(pin, 0);
  await closeUp(page, pin, "pin-nudge-invite-rest");
  const rest = await pin.evaluate(node => getComputedStyle(node).boxShadow);
  await freezeAt(pin, 1_080);
  await closeUp(page, pin, "pin-nudge-invite-peak");
  const peak = await pin.evaluate(node => getComputedStyle(node).boxShadow);
  // …and one frame per 200ms of the cycle, which assembles into the loop a
  // person actually sees (a still can only ever show one instant of it).
  for (let at = 0; at < 2_400; at += 200) {
    await freezeAt(pin, at);
    await closeUp(page, pin, `frames/pin-nudge-frame-${String(at).padStart(4, "0")}`);
  }
  // The ring really does open and close — a flat keyframe would photograph the
  // same at both ends, and the two stills above could not tell you.
  expect(peak, `rest ${rest} → peak ${peak}`).not.toBe(rest);
  expect(peak).toMatch(/5px/);
  await freezeAt(pin, null);

  // Taking it: the panel goes first, then the ghost flies to the shelf and the
  // shelf takes the settle ring. No slot is mounted anywhere on this page — that
  // used to mean the pin did nothing visible at all.
  await slowMotion(page);
  write();
  await pin.click();
  await expect(page.locator("[data-vendo-pin-ring]")).toBeAttached({ timeout: 10_000 });
  const ring = (await page.locator("[data-vendo-pin-ring]").boundingBox())!;
  const target = (await shelf.boundingBox())!;
  for (const side of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(ring[side] - target[side]), `the ring's ${side} follows the shelf, not the page`).toBeLessThan(2);
  }
  // The ring lands in the ACCENT, not in body text. Borrowing the shelf's own
  // `color` drew a near-black rectangle around it — a debug outline where the
  // payoff of the whole ceremony should be.
  const ink = await page.locator("[data-vendo-pin-ring]").evaluate(node => ({
    ring: getComputedStyle(node).boxShadow,
    accent: getComputedStyle(node.parentElement!).getPropertyValue("--vendo-accent"),
    body: getComputedStyle(document.querySelector(".fl-shelf")!).color,
  }));
  expect(ink.ring, `ring ${ink.ring} · accent ${ink.accent} · body ${ink.body}`).not.toContain(ink.body);
  await page.screenshot({ path: screenshotPath("pin-ring-on-shelf") });

  // The host's write fired…
  await expect(page.getByTestId("pin-recorder")).toHaveText(`pinned: ${BUILT_APP}`);
  // …and the shelf holds the app WITHOUT a refresh. This used to need a reload,
  // which meant the flight above landed in a shelf that did not have the app in
  // it — the ceremony asserting something untrue.
  await expect(shelf.getByRole("button", { name: "Open Where my money goes" })).toBeVisible();
  await page.screenshot({ path: screenshotPath("pin-shelf-holds-app") });
});

test("the invitation resolves once the pin is taken, on whichever surface shows it next", async ({ page }) => {
  await hostPinWrite(page);
  await openScenario(page, "pin-shelf");

  await page.getByRole("button", { name: "AI agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  await dialog.getByRole("textbox", { name: "Message" }).fill(BUILD_TURN);
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText("Spending board").first()).toBeVisible({ timeout: 25_000 });
  await dialog.getByRole("button", { name: "Pin to dashboard" }).click();

  // The pin closed the panel. Reopening restores the same conversation (closing
  // never discards it), and the card's pin is settled rather than still asking.
  await page.getByRole("button", { name: "AI agent" }).click();
  const settled = page.getByRole("dialog", { name: "Vendo assistant" })
    .getByRole("button", { name: "Pin to dashboard" });
  await expect(settled).toHaveAttribute("data-vendo-pin", "pinned");
  await expect(settled).toHaveCSS("animation-iteration-count", /^(?!.*infinite).*$/);
  // `animations: "disabled"` finishes the panel's entrance first — without it the
  // shot lands mid-open and photographs a half-transparent dialog.
  await page.screenshot({ path: screenshotPath("pin-settled"), animations: "disabled" });
  await closeUp(page, settled, "pin-settled-bar");
});
