/**
 * The settle signal, which is what decides when a screen is looked at.
 *
 * Everything downstream hangs off it: the screenshot the judge grades, the text
 * the auditor answers for, and the page the probe starts pressing. A signal that
 * fires before the screen has finished painting is a benchmark measuring a
 * half-drawn page and calling it a verdict.
 *
 * A static payload paints in two frames and always has. An INTERACTIVE payload
 * (`payload.interactive` — compiled source and its queries) has a runtime to boot
 * inside `PayloadView` first, so `mount.tsx` gives it a grace before it says it is
 * settled. These pin both halves in a real browser: the static path unchanged,
 * and the interactive tag neither hanging the page nor being silently ignored.
 *
 * THE SEAM: the grace is flat because there is nothing to race it against yet.
 * When `PayloadView` boots the VM and can say when it has painted, that signal
 * replaces the wait and the grace becomes its ceiling — and this file is where
 * that change is proven.
 */
import type { UIPayload } from "@vendoai/core";
import type { ScreenInteractive } from "@vendoai/ui/tree";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleMount, openBrowser, pageHtml, type Shooter, type Shot } from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

/** `VM_BOOT_MS` in `src/mount.tsx`. A browser entry cannot be imported from node
 *  — its first statement reads the document — so the number is written twice and
 *  only ever asserted as a FLOOR: a busy machine can be slower than the grace,
 *  never faster, so nothing here can report a bug the product does not have. */
const VM_BOOT_MS = 1_000;

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

/** One page mounted the way a run mounts it, and how long it took to say it was
 *  ready. `visit` returns once `__settled` is set, so the elapsed time IS the
 *  wait the shot and the probe are made to take. */
async function mounted(payload: UIPayload): Promise<{ shot: Shot; waitedMs: number }> {
  const started = Date.now();
  const visit = await shooter.visit(pageHtml(payload, world, bundle, "vendo-sonnet"));
  const waitedMs = Date.now() - started;
  try {
    return { shot: await visit.shot(), waitedMs };
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

  it("an interactive payload still settles, and is given the boot grace first", async () => {
    const { shot, waitedMs } = await mounted(INTERACTIVE);

    expect(shot.renders).toBe(true);
    // The tag is not ignored: the grace was actually taken. Without it, an
    // interactive screen would be shot and pressed on whatever the VM had
    // managed to paint by the second frame — which is nothing.
    expect(waitedMs).toBeGreaterThanOrEqual(VM_BOOT_MS);
  }, 120_000);
});
