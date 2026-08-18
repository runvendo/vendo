/**
 * What `mount.tsx` does to a page in a real browser: when it says the screen is
 * ready, and whose brand the screen is wearing when it says so.
 *
 * THE SETTLE SIGNAL, which is what decides when a screen is looked at.
 *
 * Everything downstream hangs off it: the screenshot the judge grades, the text
 * the auditor answers for, and the page the probe starts pressing. A signal that
 * fires before the screen has finished painting is a benchmark measuring a
 * half-drawn page and calling it a verdict.
 *
 * Every payload paints in two frames, and nothing waits on a timer. An
 * INTERACTIVE payload (`payload.interactive` — compiled source and its queries)
 * used to be given a flat extra second, because the engine behind `PayloadView`'s
 * VM could not be waited on from outside it; `mount.tsx` now awaits that engine
 * itself before it renders anything, so the wait is earned rather than guessed.
 * These pin both halves in a real browser: the static path unchanged, and the
 * interactive tag neither hanging the page nor being silently ignored.
 *
 * That the interactive mount has done its WORK by the time it says so — the
 * screen's queries asked and their answers painted — is proven where the data
 * is, in `liveness.test.ts`, against a real compiled screen rather than the
 * minimal tag below.
 *
 * THE THEME is the other half, and it is graded: every judge note on a live
 * maple run said the vendo column's surface was accent #111111 with 6/10/16px
 * corners — the product's DEFAULT theme — while the baselines, handed the same
 * theme as prompt text, painted the world's green. So the one column running
 * the real renderer was the only one not wearing the brand, and was marked down
 * for the harness's mount. Asserted on the element that PAINTS with the token,
 * not on the variable the page sets: the renderer's surface re-emits every
 * `--vendo-*` from its own theme, so a root variable can be right and the screen
 * still default.
 */
import type { UIPayload } from "@vendoai/core";
import type { ScreenInteractive } from "@vendoai/ui/tree";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleMount, openBrowser, pageHtml, type Shooter, type Shot } from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let bundle: string;
let shooter: Shooter;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  bundle = await bundleMount();
  shooter = await openBrowser();
}, 120_000);
afterAll(async () => await shooter.close());

const STATIC: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Text", props: { text: "Alex Rivera" } }],
} as UIPayload;

/**
 * The tag exactly as the paint gate emits it — `ScreenInteractive`, not a
 * hand-shaped lookalike (`checking/floor.ts` builds `{ compiledSource, queries,
 * queryPlan }`). Typed rather than cast so the COMPILER is what holds this
 * fixture to the producer: `mount.tsx` only tests the key's presence today, so a
 * wrong shape here would pass this suite silently right up until `PayloadView`
 * boots the VM for real and reads the members.
 */
const SCREEN_INTERACTIVE: ScreenInteractive = {
  compiledSource: "return null;",
  queries: {},
  queryPlan: [],
};

/** The same screen, tagged the way the product tags one it compiled source for. */
const INTERACTIVE: UIPayload = {
  ...STATIC,
  interactive: SCREEN_INTERACTIVE,
} as UIPayload;

/** One page mounted the way a run mounts it. `visit` returns once `__settled` is
 *  set, so a page that never says it is ready never gets here — the settle is the
 *  thing under test and the wait for it is how it is put to the question. */
async function mounted(payload: UIPayload): Promise<{ shot: Shot }> {
  const visit = await shooter.visit(pageHtml(payload, world, bundle, "vendo-sonnet"));
  try {
    return { shot: await visit.shot() };
  } finally {
    await visit.close();
  }
}

describe("the settle signal", () => {
  it("a static payload paints and settles, with no grace spent on it", async () => {
    const { shot } = await mounted(STATIC);

    // `renders` is false the moment the page reports a console error, and a page
    // that never settles has "never settled" pushed into that same list — so this
    // one assertion covers both halves of the signal.
    expect(shot.renders).toBe(true);
    expect(shot.visibleText).toContain("Alex Rivera");
  }, 120_000);

  it("an interactive payload settles too, on the same two frames and no timer", async () => {
    const { shot } = await mounted(INTERACTIVE);

    // The tag neither hangs the page nor is ignored: the mount awaits the screen
    // engine before it renders, and then says it is ready on the frame it is
    // ready on. Nothing here asserts a duration — a clock reading on a shared
    // laptop reports the machine, not the product.
    expect(shot.renders).toBe(true);
    expect(shot.visibleText).toContain("Alex Rivera");
  }, 120_000);
});

/** A screen whose whole surface is one brand-filled control: the Kit's primary
 *  Button fills with `var(--vendo-color-accent)` (kit/forms/button.tsx:22). */
const BRANDED: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Button", props: { label: "Send payment" } }],
} as UIPayload;

/** A hex the world authored, as the browser reports it back. */
const rgb = (hex: string): string =>
  `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;

describe("the theme the screen wears", () => {
  it("is the world's brand, not the product's default", async () => {
    const visit = await shooter.visit(pageHtml(BRANDED, world, bundle, "vendo-sonnet"));
    try {
      const filled = await visit.page.evaluate(() =>
        getComputedStyle(document.querySelector('[data-kit="Button"]')!).backgroundColor);

      expect(filled).toBe(rgb(world.theme.colors.accent));
    } finally {
      await visit.close();
    }
  }, 120_000);
});
