/**
 * The negative control for `wiredActions`.
 *
 * A screen that names a tool in its document and a screen that actually calls one
 * are the same screen to any static scan — the whole reason this check moved into
 * a browser. So the pair below differs by one thing only: whether the button's
 * handler is attached. If the dead one ever passes, this check is measuring
 * nothing.
 *
 * A real browser, the real probe, the real grader — no doubles.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wiredActions } from "../src/floor.js";
import { probe } from "../src/probe.js";
import { openBrowser, type Shooter } from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

/** The recorder every real benchmark page carries, in its smallest honest form.
 *  `page.html` gets it from the bundled mount; this fixture declares it inline so
 *  the control is a page and not a mock. */
const fixture = (handler: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>control</title></head><body>
<div id="root"><button id="go">Cancel transfer</button></div>
<script>
  window.vendo = { calls: [], callTool(name, args) { window.vendo.calls.push({ name, args }); return { status: "ok", output: null }; } };
  ${handler}
  window.__settled = true;
</script>
</body></html>`;

const WIRED = fixture(`document.getElementById("go").addEventListener("click", () =>
  window.vendo.callTool("cancel_transfer", { id: "tr_1" }));`);

/** The dead one: the handler is never attached. It looks identical. */
const DEAD = fixture("");

/**
 * The same wired control, one turn of the event loop late.
 *
 * This is what an interactive screen is: the press goes through a runtime before
 * it reaches the host, so the call lands a beat after the click. The probe used
 * to read the recorder on the line after the click, which recorded this — a
 * perfectly wired control — as having called nothing. 50ms is long enough that no
 * ordering luck can pass it.
 */
const DELAYED = fixture(`document.getElementById("go").addEventListener("click", () =>
  setTimeout(() => window.vendo.callTool("cancel_transfer", { id: "tr_1" }), 50));`);

/**
 * A control that asks the host for nothing and is not dead.
 *
 * Every interactive screen has these — open a dialog, switch a tab, dismiss a
 * row — and the old rule failed a screen for having one. Its change is late for
 * the same reason `DELAYED`'s call is, so this also holds the DOM half of the
 * probe's wait: read synchronously, the screen has not moved yet either.
 */
const STATE_ONLY = fixture(`document.getElementById("go").addEventListener("click", () =>
  setTimeout(() => {
    var detail = document.createElement("p");
    detail.textContent = "Transfer to Alex Rivera, arriving Tuesday";
    document.getElementById("root").append(detail);
  }, 50));`);

/**
 * The whole confirmation chain: the press opens a `[role=dialog]` with a way out
 * and a primary action, in that order, a beat after the click.
 *
 * The dialog is BUILT on the press rather than sitting hidden in the markup, the
 * way a real screen mounts one — so the page the probe counts its candidates on
 * has exactly the one button, and the dialog's own controls are never graded as
 * screens of their own.
 */
const chain = (attachPrimary: string): string =>
  fixture(`document.getElementById("go").addEventListener("click", () =>
  setTimeout(() => {
    var dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    var keep = document.createElement("button");
    keep.textContent = "Keep it";
    keep.addEventListener("click", () => dialog.remove());
    var primary = document.createElement("button");
    primary.textContent = "Yes, cancel it";
    ${attachPrimary}
    dialog.append(keep, primary);
    document.getElementById("root").append(dialog);
  }, 50));`);

const CONFIRMED = chain(`primary.addEventListener("click", () =>
      window.vendo.callTool("cancel_transfer", { id: "tr_1" }));`);

/** The same chain with the primary's handler never attached — a screen that asks
 *  "are you sure?", is told yes, and does nothing. Indistinguishable from the one
 *  above in a screenshot, and the exact thing a dialog's repaint could hide. */
const CONFIRMED_DEAD = chain("");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let shooter: Shooter;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  shooter = await openBrowser();
}, 60_000);
afterAll(async () => await shooter.close());

const traceOf = async (html: string): ReturnType<typeof probe> => {
  const visit = await shooter.visit(html);
  try {
    return await probe(visit);
  } finally {
    await visit.close();
  }
};

describe("the click probe grades what a browser actually does", () => {
  it("passes a button whose handler calls a real tool with valid arguments", async () => {
    const trace = await traceOf(WIRED);
    expect(trace).toEqual([
      { label: "Cancel transfer", confirmed: false, changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
    ]);
    expect(wiredActions(trace, world).pass).toBe(true);
  });

  it("passes the same button when the call lands a beat after the click", async () => {
    const trace = await traceOf(DELAYED);

    // Read on the line after the click — as this probe did — the recorder is
    // still empty here and a wired control is graded dead. Every interactive
    // screen presses through a runtime, so every one of them looked like this.
    expect(trace).toEqual([
      { label: "Cancel transfer", confirmed: false, changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
    ]);
    expect(wiredActions(trace, world).pass).toBe(true);
  });

  it("passes a button that only changes the screen, and says that is what it did", async () => {
    const trace = await traceOf(STATE_ONLY);
    expect(trace).toEqual([{ label: "Cancel transfer", confirmed: false, changed: true, calls: [] }]);

    const result = wiredActions(trace, world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toMatchObject({ effect: "state" });
  });

  it("fails the same button with no handler attached", async () => {
    const trace = await traceOf(DEAD);
    expect(trace).toEqual([{ label: "Cancel transfer", confirmed: false, changed: false, calls: [] }]);

    const result = wiredActions(trace, world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ effect: "none" });
  });

  /**
   * The confirmation chain, both ways, and the one case where a screen that moved
   * is still dead.
   *
   * A dialog opening is a visible change, so the state-only rule on its own would
   * pass a screen that asks "are you sure?", is told yes, and calls nothing — the
   * precise failure the probe replaced a static scan to catch. Being followed
   * through is what separates the two: the pair below differs only by whether the
   * primary action has a handler.
   */
  it("passes a confirmation whose primary action calls a real tool", async () => {
    const trace = await traceOf(CONFIRMED);
    expect(trace).toEqual([
      {
        label: "Cancel transfer",
        confirmed: true,
        changed: true,
        calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }],
      },
    ]);

    const result = wiredActions(trace, world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toMatchObject({ effect: "tool", tool: "cancel_transfer" });
  });

  it("fails a confirmation that was followed through and still called nothing", async () => {
    const trace = await traceOf(CONFIRMED_DEAD);

    // The screen DID move — the dialog is on it — so this is the one press that
    // changed something and is dead anyway.
    expect(trace).toEqual([{ label: "Cancel transfer", confirmed: true, changed: true, calls: [] }]);

    const result = wiredActions(trace, world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ effect: "none" });

    // The dialog's own buttons were never graded as controls of their own: the
    // candidates are counted on the untouched page, where the dialog does not
    // exist yet. That is why a "Keep it" dismiss cannot be caught by the rule
    // above — the probe only ever presses a dialog's LAST control.
    expect(trace).toHaveLength(1);
  });
});
