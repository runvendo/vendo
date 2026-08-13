/**
 * The UI smoke pack — the things that must never silently stop working, and the
 * only browser specs wired into the root gate (`pnpm test` → `turbo run
 * test:ui`).
 *
 * Deliberately shallow: it asserts on ROLES and user-visible TEXT wherever a
 * role exists, so a restyle passes and a "nothing rendered / nothing responds"
 * regression fails. Two of the redesign's laws are STRUCTURAL, not textual — a
 * build may animate exactly one element (§8), and a settled turn folds its beats
 * into one row (§1) — so those two use the minimum DOM hook and say why.
 *
 * Everything runs off the scripted wire fixture (`test/wire-server.ts`) — no
 * model calls, no network, no clock dependence. Budget: under three minutes,
 * single worker.
 *
 * The deep behavioural coverage stays in the full local suite (`test:browser`).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openScenario } from "./helpers.js";

/** The scripted multi-tool + build turn (`[smoke-build]` in the wire fixture). */
const BUILD_TURN = "[smoke-build] a board showing where my money goes";

async function send(scope: Page | Locator, text: string): Promise<void> {
  await scope.getByRole("textbox", { name: "Message" }).fill(text);
  await scope.getByRole("button", { name: "Send" }).click();
}

/**
 * Every element inside `scope` that is running a LOOPING animation, itself or
 * through a pseudo-element. §8's "the build animates ONE thing" is a claim about
 * exactly this set, and nothing else can measure it. Names carry the pseudo
 * (`P::after`) so a failure says WHICH loop came back.
 */
async function looping(scope: Locator): Promise<string[]> {
  return scope.locator("*").evaluateAll(nodes => nodes.flatMap((node) => {
    const name = node.className.toString().trim().split(/\s+/).at(-1) || node.tagName.toLowerCase();
    return (["", "::before", "::after"] as const)
      .filter((pseudo) => {
        const style = getComputedStyle(node, pseudo === "" ? undefined : pseudo);
        return style.animationName !== "none"
          && style.animationIterationCount.split(",").some(count => count.trim() === "infinite");
      })
      .map(pseudo => `${name}${pseudo}`);
  }));
}

/**
 * Sample `looping()` continuously for as long as a card in `scope` is building,
 * and report the UNION of everything that ever moved plus what the fixture was
 * actually showing while we looked.
 *
 * One instant is not enough (ruling 21): the suppressed set changes shape
 * through the build — an empty streamed turn shows the lone `.fl-caret`, flowing
 * prose shows the trailing pseudo-caret, and a half-written table shows the
 * forming row's shimmer. Sampling the whole window catches all three without
 * racing any of them.
 */
async function loopingThroughBuild(scope: Locator): Promise<{
  moved: string[]; sawCaret: boolean; sawFlowingProse: boolean; sawFormingTable: boolean; samples: number;
}> {
  const moved = new Set<string>();
  const seen = { caret: false, prose: false, table: false };
  let samples = 0;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    // ONE evaluate: the building check and the animation sweep must observe the
    // SAME frame. As two round-trips, the build could finish between them and
    // the sweep then caught the prose caret legitimately resuming after the
    // window §8 makes a claim about — a race the paced text reveal
    // (useSmoothText) turned from theoretical into reliable, since the reveal
    // now renders continuously across the build's end instead of pausing on
    // network lulls. Mirrors looping(); Playwright serializes the callback, so
    // the logic cannot be shared by reference.
    const frame = await scope.evaluate(root => {
      const building = root.querySelector('.fl-appcard-bar[data-state="building"]') !== null;
      const loops: string[] = [];
      if (building) {
        for (const node of Array.from(root.querySelectorAll("*"))) {
          const name = node.className.toString().trim().split(/\s+/).at(-1) || node.tagName.toLowerCase();
          for (const pseudo of ["", "::before", "::after"] as const) {
            const style = getComputedStyle(node, pseudo === "" ? undefined : pseudo);
            if (style.animationName !== "none"
              && style.animationIterationCount.split(",").some(count => count.trim() === "infinite")) {
              loops.push(`${name}${pseudo}`);
            }
          }
        }
      }
      return {
        building,
        loops,
        caret: root.querySelector(".fl-caret") !== null,
        prose: root.querySelector(".fl-md--streaming") !== null,
        table: root.querySelector(".fl-skeleton-bar") !== null,
      };
    });
    if (!frame.building && samples > 0) break;
    if (frame.building) {
      samples += 1;
      seen.caret ||= frame.caret;
      seen.prose ||= frame.prose;
      seen.table ||= frame.table;
      for (const name of frame.loops) moved.add(name);
    }
  }
  return {
    moved: [...moved].sort(),
    sawCaret: seen.caret,
    sawFlowingProse: seen.prose,
    sawFormingTable: seen.table,
    samples,
  };
}

test("landing renders its greeting, suggestions and composer", async ({ page }) => {
  // The landing scenario is full-bleed (a host FRAME, not the harness card), so
  // it mounts a div rather than the `main[data-scenario]` openScenario expects.
  await page.goto("/thread-landing");
  // A first-ever visit shows the one-time greeting-as-tutorial instead of the
  // host greeting (discoverability §6) — mark it seen.
  await page.evaluate(() => localStorage.setItem("vendo:discoverability:greeting", "1"));
  await page.reload();
  await expect(page.locator('[data-scenario="thread-landing"]')).toBeVisible();
  await expect(page.getByText("What do you want to build?")).toBeVisible();
  await expect(page.getByRole("button", { name: /What was that \$87 DoorDash charge\?/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("a scripted turn streams assistant text into the transcript", async ({ page }) => {
  await openScenario(page, "composer");
  await send(page, "Say something back");
  await expect(page.getByText("Turn complete")).toBeVisible({ timeout: 20_000 });
});

test("the approval card approves and reports the decision", async ({ page }) => {
  await openScenario(page, "approval");
  // Humanized, never the raw slug — the consent surface's standing law.
  await expect(page.getByLabel("Approval for Delete invoice")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(page.getByText("host_delete_invoice")).toHaveCount(0);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("approval-recorder")).toHaveText('resolved: {"approve":true}');
});

test("the overlay opens from the launcher and closes on Escape", async ({ page }) => {
  await openScenario(page, "overlay-manual");
  const launcher = page.getByRole("button", { name: "AI agent" });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
});

test("a multi-tool turn narrates its steps as beats, then folds into one settled summary", async ({ page }) => {
  await openScenario(page, "composer");
  await send(page, BUILD_TURN);

  // §1 — one beat line per step, in the transcript, in the product's words.
  const beats = page.locator(".fl-beat");
  await expect(beats.filter({ hasText: /transactions/i })).toHaveCount(1);
  await expect(beats.filter({ hasText: /spending insights/i })).toHaveCount(1);

  // …and the turn closes into ONE reopenable row that counts every step —
  // including the build, which never had a beat of its own (§8 D1).
  const summary = page.getByRole("button", { name: /Did 3 things/ });
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await expect(beats).toHaveCount(0);
  await summary.click();
  await expect(beats.filter({ hasText: /transactions/i })).toHaveCount(1);
});

test("a build animates exactly one thing, and the bar flips to the app's name", async ({ page }) => {
  await openScenario(page, "composer");
  await send(page, BUILD_TURN);

  const list = page.locator(".fl-msglist");
  await expect(page.getByText("Building your view…")).toBeVisible({ timeout: 20_000 });
  const window_ = await loopingThroughBuild(list);

  // The fixture must have SHOWN the competing loops, or the §8 claim below is
  // about an empty set and cannot fail (ruling 21). These three are the exact
  // elements chrome-css suppresses while a card builds.
  expect(window_.samples, "the build window must have been sampled").toBeGreaterThan(3);
  expect(
    { caret: window_.sawCaret, prose: window_.sawFlowingProse, table: window_.sawFormingTable },
    "the fixture must stream prose beside the building card",
  ).toEqual({ caret: true, prose: true, table: true });

  // §8 — the hairline gliding across the card bar is the ONLY moving element
  // for the WHOLE build: no blinking caret, no pulsing beat orb, no shimmering
  // forming row. Reverting the suppression puts the caret and shimmer back here.
  expect(window_.moved).toEqual(["fl-boot-hairline"]);

  await expect(page.getByText("Spending board").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Did 3 things/ })).toBeVisible({ timeout: 20_000 });
  // The settled turn is calm: nothing loops once the work is done. "Done" now
  // includes the paced reveal's tail (useSmoothText): the caret deliberately
  // rides the REVEAL's end, not the stream's, so let the last frames drain —
  // the streaming class clearing IS the reveal finishing — before asserting.
  await expect(list.locator(".fl-md--streaming")).toHaveCount(0);
  expect(await looping(list)).toEqual([]);
});

test("the launcher pill works while the panel is closed, then offers the result", async ({ page }) => {
  await openScenario(page, "overlay-manual");
  const launcher = page.getByRole("button", { name: "AI agent" });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  await send(dialog, BUILD_TURN);
  // The close button, not Escape: a build expands the split workspace, and
  // Escape's first job there is collapsing it (escapeIntent).
  await page.getByRole("button", { name: "Close Vendo" }).click();
  await expect(dialog).toBeHidden();

  // Closing the panel is leaving, not stopping: the pill narrates the live step.
  await expect(page.locator(".fl-launcher-beat")).toBeVisible();
  // …and announces the finished run once, with the way back into it.
  const toast = page.locator(".fl-launcher-toast");
  await expect(toast).toContainText("Your spending board is ready.", { timeout: 20_000 });
  await expect(toast.getByRole("button", { name: "View" })).toBeVisible();
});

test("§15 — a turn whose stream died offers no Retry component", async ({ page }) => {
  await openScenario(page, "composer");
  await send(page, "[stream-kill] break it");
  await expect(page.getByText("the response didn’t finish")).toBeVisible();
  // The retry path is the conversation itself, never a component of its own.
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retry$/ })).toHaveCount(0);
});

test("a failed build ends the turn in ✕ and prose, and offers no component to poke", async ({ page }) => {
  await openScenario(page, "build-failed");
  const failure = page.locator("[data-vendo-build-failed]");
  await expect(failure).toBeVisible();
  await expect(failure.getByText("Couldn't build the app")).toBeVisible();
  // §15 — the ✕ and the agent's own words ARE the failure surface.
  await expect(failure.getByRole("alert")).toBeVisible();
  await expect(failure.getByRole("button")).toHaveCount(0);
  // …and the developer's sentence never reaches the reader (§16 law 3).
  await expect(failure).not.toContainText("DataTable");
});

/* ------------------------------------------------------------------ */
/* Round-2 additions: the cheap high-value axes the 11-test pack missed */
/* ------------------------------------------------------------------ */

const POLICY_BANNER = "Vendo is running without a policy";

test("C1 — a conversation grows no policy banner of its own", async ({ page }) => {
  // Two-sided on purpose: "no banner" alone would also pass if the banner were
  // deleted outright, or if the status probe never resolved. One per branch.
  await openScenario(page, "composer");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByRole("region", { name: POLICY_BANNER })).toHaveCount(0);

  // …and it is still a real, reachable surface where the HOST mounts it
  // (`/notice`, an unconfigured client): §6's banner is the host's call, never
  // furniture the conversation adds for itself.
  await page.goto("/notice");
  await expect(page.getByRole("region", { name: POLICY_BANNER })).toBeVisible();
});

test("H9 — collapsing the workspace is final; the stage does not re-open it", async ({ page }) => {
  await openScenario(page, "overlay-manual");
  await page.getByRole("button", { name: "AI agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  await send(dialog, BUILD_TURN);

  await expect(page.getByRole("button", { name: /Did 3 things/ })).toBeVisible({ timeout: 20_000 });

  // Opening the built view expands the split workspace…
  const panel = page.locator(".fl-overlay-panel");
  await page.getByRole("button", { name: "Expand this view" }).click();
  await expect(panel).toHaveAttribute("data-vendo-expanded", "", { timeout: 10_000 });

  // …and Collapse workspace means it. The one-shot hint ledger lives in the
  // split, so collapsing cannot re-arm the thing that opened it (H9): back to
  // chat is FINAL, not a state the stage may quietly undo a beat later.
  await page.getByRole("button", { name: "Collapse workspace" }).click();
  await expect(panel).not.toHaveAttribute("data-vendo-expanded", /.*/);
  await page.waitForTimeout(1_500);
  await expect(panel).not.toHaveAttribute("data-vendo-expanded", /.*/);
});

test("mobile 390px — the thread renders, sends, and answers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScenario(page, "composer");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  // Nothing overflows the phone: the composer sits inside the viewport.
  const box = (await composer.boundingBox())!;
  expect(box.x, "the composer starts inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "the composer ends inside the viewport").toBeLessThanOrEqual(391);
  await send(page, "Say something back");
  await expect(page.getByText("Turn complete")).toBeVisible({ timeout: 20_000 });
});
