/**
 * The negative control for `wiredActions`.
 *
 * A screen that names a tool in its document and a screen that actually calls one
 * are the same screen to any static scan — the whole reason this check moved into
 * a browser. So the pages below differ by one thing only: what the button's
 * handler does. If the dead one ever passes, this check is measuring nothing.
 *
 * Two of them call no tool on purpose, which is what a drill-down row, a tab and
 * a wizard's Next do: they move the screen. One moves its text, one moves only
 * its aria state, and the dead one moves nothing.
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
<div id="root"><button id="go">Cancel transfer</button><p id="panel">Pending</p></div>
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

/** Calls nothing, and is wired anyway: pressing it swaps what the screen says. */
const STATEFUL = fixture(`document.getElementById("go").addEventListener("click", () =>
  document.getElementById("panel").textContent = "Sent to Ada Lovelace");`);

/** The same, moving no text at all — a tab whose panels read alike still reports
 *  which one is showing, and that is the whole change. */
const ARIA_ONLY = fixture(`document.getElementById("go").setAttribute("aria-expanded", "false");
document.getElementById("go").addEventListener("click", () =>
  document.getElementById("go").setAttribute("aria-expanded", "true"));`);

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
      { label: "Cancel transfer", confirmed: false, changedView: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
    ]);
    const result = wiredActions(trace, world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toMatchObject({ kind: "tool", tool: "cancel_transfer" });
  });

  it("fails the same button with no handler attached", async () => {
    const trace = await traceOf(DEAD);
    expect(trace).toEqual([{ label: "Cancel transfer", confirmed: false, changedView: false, calls: [] }]);
    const result = wiredActions(trace, world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ kind: "dead" });
  });

  it("passes a control that calls nothing and changes what the screen shows", async () => {
    const trace = await traceOf(STATEFUL);
    expect(trace).toEqual([{ label: "Cancel transfer", confirmed: false, changedView: true, calls: [] }]);
    const result = wiredActions(trace, world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toMatchObject({ kind: "state", where: "Cancel transfer" });
  });

  it("sees a change carried only by aria state", async () => {
    const trace = await traceOf(ARIA_ONLY);
    expect(trace).toEqual([{ label: "Cancel transfer", confirmed: false, changedView: true, calls: [] }]);
    expect(wiredActions(trace, world).pass).toBe(true);
  });
});
