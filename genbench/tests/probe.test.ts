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
const screen = (body: string, handler = ""): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>control</title></head><body>
<div id="root">${body}</div>
<script>
  window.vendo = { calls: [], callTool(name, args) { window.vendo.calls.push({ name, args }); return { status: "ok", output: null }; } };
  ${handler}
  window.__settled = true;
</script>
</body></html>`;

/** The same page around the one button most of these are about. */
const fixture = (handler: string): string => screen(`<button id="go">Cancel transfer</button>`, handler);

const WIRED = fixture(`document.getElementById("go").addEventListener("click", () =>
  window.vendo.callTool("cancel_transfer", { id: "tr_1" }));`);

/** The dead one: the handler is never attached. It looks identical. */
const DEAD = fixture("");

/**
 * One call at LOAD, and a dead button beside it.
 *
 * The probe recorded `after.calls` — the page's whole recorder array — for every
 * candidate, so a single refetch at load was credited to every control on the
 * screen. A dead button on a screen that fetches anything graded as wired, which
 * is precisely the failure the probe exists to catch, on precisely the screens
 * that have something to fetch.
 */
const LOADS_THEN_DEAD = fixture(`window.vendo.callTool("list_transfers", { limit: 5 });`);

/**
 * A link out of the screen.
 *
 * `a[href]` is actionable, so the probe presses it, and the page navigates away:
 * the recorder goes with it and every read after the click throws. That rejected
 * `probe()`, which rejected the whole case — the screenshot already taken was
 * discarded with it, and the column read as a contender that built nothing. The
 * harness blocks the network, so the navigation cannot even land.
 */
const LINK_OUT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>control</title></head><body>
<div id="root"><a href="https://example.com/statements">Download statements</a></div>
<script>
  window.vendo = { calls: [], callTool(name, args) { window.vendo.calls.push({ name, args }); return { status: "ok", output: null }; } };
  window.__settled = true;
</script>
</body></html>`;

/** A page that brings its own `window.vendo` and no `calls` array at all. The
 *  seam wraps whatever it finds rather than replacing it, so this is what the
 *  probe then reads — and reading `.length` off `undefined` threw. */
const FOREIGN_RECORDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>control</title></head><body>
<div id="root"><button id="go">Cancel transfer</button></div>
<script>
  window.vendo = { callTool: function () { return { status: "ok", output: null }; } };
  document.getElementById("go").addEventListener("click", function () { window.vendo.callTool("cancel_transfer", { id: "tr_1" }); });
  window.__settled = true;
</script>
</body></html>`;

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
 * A screen whose only actuator is a toggle, drawn the way the Kit draws one.
 *
 * `<span role=switch>` is Base UI's markup, and the `aria-hidden` input beside it
 * is the proxy that carries the form value — both halves are here because both
 * halves are on a real screen. The probe pressed buttons and nothing else, so
 * this whole screen recorded `pressed: 0` while its switch was correctly bound to
 * a tool, and the proxy must not become a second control now that it is pressed.
 */
const WIRED_SWITCH = screen(
  `<span id="flip" role="switch" aria-checked="false" tabindex="0">Cap the coffee budget</span>
  <input type="checkbox" aria-hidden="true" tabindex="-1">`,
  `document.getElementById("flip").addEventListener("click", function () {
    this.setAttribute("aria-checked", "true");
    window.vendo.callTool("set_budget", { category: "coffee", limit_cents: 5000 });
  });`,
);

/** The same toggle bound to nothing but its own state. Flipping it changes
 *  neither the page's text nor its element count, so a probe reading only those
 *  two would grade a switch a person can watch move as a dead control — the false
 *  failure that pressing toggles at all would otherwise have invented. */
const LOCAL_SWITCH = screen(
  `<span id="flip" role="switch" aria-checked="false" tabindex="0">Compact rows</span>`,
  `document.getElementById("flip").addEventListener("click", function () {
    this.setAttribute("aria-checked", "true");
  });`,
);

/** The browser's own checkbox, which is what a hand-written page reaches for. It
 *  carries its role implicitly rather than in an attribute, so a role-only list
 *  would miss every one of them. */
const WIRED_CHECKBOX = screen(
  `<input id="only" type="checkbox" aria-label="Only pending">`,
  `document.getElementById("only").addEventListener("change", function () {
    window.vendo.callTool("list_transfers", { limit: 5 });
  });`,
);

/** The two halves of a locked control, identical until the choice is made. */
const guarded = (handler: string): string =>
  screen(
    `<select id="category"><option value="">Pick a category</option><option value="coffee">coffee</option></select>
  <button id="go" disabled>Save cap</button>`,
    handler,
  );

/**
 * The screen the post-mortem kept failing: a button correctly disabled until a
 * choice is made.
 *
 * Nothing about it is wrong — it is `disabled` because no category is picked yet
 * — and the probe never picked one, so the button was never a candidate, nothing
 * was pressed, and a case that asked the screen to DO something scored zero wired
 * controls while a screen of always-enabled buttons that call nothing scored
 * better. The chosen value rides into the arguments, so a passing trace also says
 * the choice is what reached the tool.
 */
const GUARDED = guarded(`document.getElementById("category").addEventListener("change", function () {
    document.getElementById("go").disabled = this.value === "";
  });
  document.getElementById("go").addEventListener("click", function () {
    window.vendo.callTool("set_budget", { category: document.getElementById("category").value, limit_cents: 5000 });
  });`);

/** The same screen with nothing that ever unlocks the button: the choice is made
 *  and it stays locked. That is a screen being CAREFUL, and it goes unpressed and
 *  ungraded rather than failing for a control nobody can press. */
const LOCKED = guarded("");

/**
 * The same shape one turn further: a button correctly locked until a reason is
 * TYPED.
 *
 * `disabled={!reason.trim()}` is the other half of the post-mortem's failing
 * screens — nothing about it is wrong, and a probe that never typed recorded
 * `pressed: 0` and failed the action case the screen correctly implements. What
 * the harness types is its own, obviously, and it rides into the arguments: a
 * passing trace here says the field is wired to the tool, not decoration.
 */
const REQUIRED_TEXT = screen(
  `<textarea id="category" placeholder="Which category?"></textarea>
  <button id="go" disabled>Save cap</button>`,
  `document.getElementById("category").addEventListener("input", function () {
    document.getElementById("go").disabled = this.value.trim() === "";
  });
  document.getElementById("go").addEventListener("click", function () {
    window.vendo.callTool("set_budget", { category: document.getElementById("category").value, limit_cents: 5000 });
  });`,
);

/** The same form with nothing locked. The probe does NOT type here: a screen that
 *  asks for nothing before it acts is pressed exactly as a hasty person would
 *  press it, and what an empty box sent is the screen's own doing. */
const OPEN_FORM = screen(
  `<textarea id="category" placeholder="Which category?"></textarea>
  <button id="go">Save cap</button>`,
  `document.getElementById("go").addEventListener("click", function () {
    window.vendo.callTool("set_budget", { category: document.getElementById("category").value, limit_cents: 5000 });
  });`,
);

/**
 * The whole confirmation chain: the press opens a `[role=dialog]` with a message
 * and whichever controls the case is about, a beat after the click.
 *
 * The dialog is BUILT on the press rather than sitting hidden in the markup, the
 * way a real screen mounts one — so the page the probe counts its candidates on
 * has exactly the one button, and the dialog's own controls are never counted as
 * controls of the screen.
 *
 * `add(label, onPress)` is the only thing a case has to write: a control inside
 * the dialog, wired to what that case is about, or to nothing at all.
 */
const MESSAGE = "Cancel this transfer? It cannot be undone.";
const chain = (build: string, said = MESSAGE): string =>
  fixture(`document.getElementById("go").addEventListener("click", () =>
  setTimeout(() => {
    var dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    var message = document.createElement("p");
    message.textContent = ${JSON.stringify(said)};
    dialog.append(message);
    var add = function (label, onPress) {
      var control = document.createElement("button");
      control.textContent = label;
      if (onPress) control.addEventListener("click", onPress);
      dialog.append(control);
    };
    ${build}
    document.getElementById("root").append(dialog);
  }, 50));`);

/** A confirmation that works: one control goes through and closes it, one backs
 *  out and calls nothing. Both close the dialog, which is what makes this page
 *  the isolation proof too — pressed on one page, whichever went first would
 *  leave the other with no dialog to press in. */
const CONFIRMED = chain(`add("Keep it", function () { dialog.remove(); });
    add("Yes, cancel it", function () {
      window.vendo.callTool("cancel_transfer", { id: "tr_1" });
      dialog.remove();
    });`);

/** The same dialog with the primary wired to nothing — the class of screen that
 *  used to clear an `action` case on having opened a dialog at all. To a person
 *  it is identical to the one above right up until they press it. */
const CONFIRMED_DEAD = chain(`add("Keep it", function () { dialog.remove(); });
    add("Yes, cancel it", null);`);

/** One control and nothing else: there is no second path to read it against, so
 *  it is judged by what that one control does. */
const SOLE = chain(`add("Yes, cancel it", function () {
      window.vendo.callTool("cancel_transfer", { id: "tr_1" });
      dialog.remove();
    });`);

/** A dialog where every way out writes. It asks a question a person cannot
 *  answer with "no", which is as broken as a dialog where nothing acts. */
const NO_DECLINE = chain(`add("Cancel this one", function () {
      window.vendo.callTool("cancel_transfer", { id: "tr_1" });
    });
    add("Cancel them all", function () {
      window.vendo.callTool("cancel_transfer", { id: "tr_2" });
    });`);

/** The record the press that OPENS a dialog leaves, whatever is inside it.
 *  `innerText` is the screen as rendered, so the exact spacing between the
 *  message and the buttons is the browser's to decide; what is pinned is that the
 *  words a person reads are captured, and that the opening press itself called
 *  nothing. */
const OPENED = { label: "Cancel transfer", dialog: expect.stringContaining(MESSAGE), changed: true, calls: [] };

/** A screen where an ordinary control sits AFTER the one that confirms. Walking
 *  the dialog's paths repaints the screen several times between those two
 *  presses, and the press that follows has to be the press that would have
 *  happened anyway. */
const BESIDE = screen(
  `<button id="go">Cancel transfer</button><button id="refresh">Refresh</button>`,
  `document.getElementById("go").addEventListener("click", function () {
    var dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.textContent = "Cancel this transfer?";
    var yes = document.createElement("button");
    yes.textContent = "Yes, cancel it";
    yes.addEventListener("click", function () {
      window.vendo.callTool("cancel_transfer", { id: "tr_1" });
      dialog.remove();
    });
    var no = document.createElement("button");
    no.textContent = "Keep it";
    no.addEventListener("click", function () { dialog.remove(); });
    dialog.append(yes, no);
    document.getElementById("root").append(dialog);
  });
  document.getElementById("refresh").addEventListener("click", function () {
    window.vendo.callTool("list_transfers", { limit: 5 });
  });`,
);

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
      { label: "Cancel transfer", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
    ]);
    expect(wiredActions(trace, world).pass).toBe(true);
  });

  it("passes the same button when the call lands a beat after the click", async () => {
    const trace = await traceOf(DELAYED);

    // Read on the line after the click — as this probe did — the recorder is
    // still empty here and a wired control is graded dead. Every interactive
    // screen presses through a runtime, so every one of them looked like this.
    expect(trace).toEqual([
      { label: "Cancel transfer", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
    ]);
    expect(wiredActions(trace, world).pass).toBe(true);
  });

  it("passes a button that only changes the screen, and says that is what it did", async () => {
    const trace = await traceOf(STATE_ONLY);
    expect(trace).toEqual([{ label: "Cancel transfer", changed: true, calls: [] }]);

    const result = wiredActions(trace, world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toMatchObject({ effect: "state" });
  });

  it("fails the same button with no handler attached", async () => {
    const trace = await traceOf(DEAD);
    expect(trace).toEqual([{ label: "Cancel transfer", changed: false, calls: [] }]);

    const result = wiredActions(trace, world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ effect: "none" });
  });

  it("credits a press with the calls IT made, not with everything the page ever asked for", async () => {
    const trace = await traceOf(LOADS_THEN_DEAD);

    // One control, one press, and it did nothing: the load-time fetch was on the
    // recorder before the button was ever touched.
    expect(trace).toEqual([{ label: "Cancel transfer", changed: false, calls: [] }]);
    expect(wiredActions(trace, world).pass).toBe(false);
    expect(wiredActions(trace, world).bindings[0]).toMatchObject({ effect: "none" });
  });

  /**
   * Every species of control, and what one of them is guarded behind — a choice
   * to make (2026-08-17) or a reason to type (2026-08-18).
   *
   * The probe pressed buttons, so it was grading reachability-by-probe rather
   * than wiring: a switch bound to a tool and a button disabled until a select
   * has a value both recorded `pressed: 0`, while the dead always-enabled button
   * above — which calls nothing at all — recorded a press and a verdict. The
   * screens below are the shapes that costs, and the two it must NOT buy: a
   * control that stays locked is still never pressed, and a form the screen never
   * locked is still pressed as it stands.
   */
  describe("presses every species, and gives a locked one what it asks for", () => {
    it("presses a switch, grades it by the tool it called, and counts it once", async () => {
      const trace = await traceOf(WIRED_SWITCH);

      // One entry, not two: the `aria-hidden` proxy input beside the switch is
      // the same control, and pressing both would grade it twice.
      expect(trace).toEqual([
        {
          label: "Cap the coffee budget",
          changed: true,
          calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }],
        },
      ]);
      expect(wiredActions(trace, world, ["action"]).pass).toBe(true);
    });

    it("passes a toggle that only flips itself, on the evidence that it flipped", async () => {
      const trace = await traceOf(LOCAL_SWITCH);

      // Nothing about the page's text or its element count moved — what moved is
      // the switch, and that is a live local control, not a dead one.
      expect(trace).toEqual([{ label: "Compact rows", changed: true, calls: [] }]);
      expect(wiredActions(trace, world).bindings[0]).toMatchObject({ effect: "state" });
    });

    it("presses the browser's own checkbox too", async () => {
      const trace = await traceOf(WIRED_CHECKBOX);

      expect(trace).toEqual([
        { label: "Only pending", changed: true, calls: [{ name: "list_transfers", args: { limit: 5 } }] },
      ]);
      expect(wiredActions(trace, world).pass).toBe(true);
    });

    it("sets the choice a locked control is waiting for, then presses it", async () => {
      const trace = await traceOf(GUARDED);

      // One control, not two: a `<select>` is what the screen ASKS for, not an
      // actuator, so it is set and never graded. `changed: false` is the other
      // half of that — the screen moving under the choice belongs to the choice,
      // and crediting it to the press would make a dead button look alive.
      expect(trace).toEqual([
        {
          label: "Save cap",
          changed: false,
          calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }],
        },
      ]);
      expect(wiredActions(trace, world, ["action"]).pass).toBe(true);
    });

    it("types into the field a locked control is waiting for, then presses it", async () => {
      const trace = await traceOf(REQUIRED_TEXT);

      // The harness's own value, on the trace beside the press it bought and in
      // the arguments that press sent: whoever reads this cannot mistake it for
      // data the screen had, and a call carrying it is the wire, proven.
      expect(trace).toEqual([
        {
          label: "Save cap",
          changed: false,
          filled: [{ field: "Which category?", value: "probe input" }],
          calls: [{ name: "set_budget", args: { category: "probe input", limit_cents: 5000 } }],
        },
      ]);
      expect(wiredActions(trace, world, ["action"]).pass).toBe(true);
    });

    it("types nothing at a form that is not locked, and presses it as it stands", async () => {
      const trace = await traceOf(OPEN_FORM);

      // Pressed empty, and the empty value is what reached the tool. That is the
      // honest reading of a screen that guards nothing — the judge grades the
      // call it really makes — and the trace records no fill because none happened.
      expect(trace).toEqual([
        { label: "Save cap", changed: false, calls: [{ name: "set_budget", args: { category: "", limit_cents: 5000 } }] },
      ]);
      expect(trace[0]).not.toHaveProperty("filled");
    });

    it("leaves a control that stays locked unpressed, rather than failing a careful screen", async () => {
      const trace = await traceOf(LOCKED);

      expect(trace).toEqual([]);
      expect(wiredActions(trace, world)).toEqual({ pass: true, pressed: 0, bindings: [] });
    });
  });

  /**
   * The two pages that used to take the whole case down with them, both graded
   * rather than thrown: a link that leaves the screen, and a page that brings a
   * recorder of its own shape. Neither is a screen the benchmark should refuse to
   * score — one navigates, one is wired — and neither is worth a lost screenshot.
   */
  it("survives a control that navigates off the screen, and still reports it", async () => {
    const trace = await traceOf(LINK_OUT);

    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ label: "Download statements", calls: [] });
    // It went somewhere, so it is a live local control rather than a dead one.
    expect(wiredActions(trace, world).bindings[0]).toMatchObject({ effect: "state" });
  });

  it("reads a page whose own recorder keeps no calls as having called nothing", async () => {
    const trace = await traceOf(FOREIGN_RECORDER);

    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ label: "Cancel transfer", calls: [] });
  });

  /**
   * The confirmation chain, pressed through (2026-08-17).
   *
   * The probe used to stop at the dialog and record its words, so a confirmation
   * wired to NOTHING and one that really acts left the identical record — and an
   * `action` case cleared its bar on the opening alone. That made "pressing
   * approve fires approve_refund" an unprovable rubric line for every action
   * that lives behind a confirmation, and last night's audit found several such
   * lines failed by every column.
   *
   * So every control inside the dialog is pressed now, one per fresh page. Which
   * one is the approval is still not the probe's to say — "Cancel" in a dialog
   * about cancelling means the opposite of "Cancel" beside it — it presses them
   * all and records what each did, and the judge reads the words.
   */
  describe("presses every way out of a confirmation, one per fresh page", () => {
    it("records both paths of a working confirmation, and what each one called", async () => {
      const trace = await traceOf(CONFIRMED);

      // Both controls close the dialog, so this is the isolation proof as well
      // as the wiring one: pressed on a shared page, whichever went first would
      // have left the other with no dialog to press in, and one of these two
      // records would be empty.
      expect(trace).toEqual([
        {
          ...OPENED,
          inside: [
            { label: "Keep it", changed: true, calls: [] },
            { label: "Yes, cancel it", changed: true, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
          ],
        },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.pass).toBe(true);
      expect(result.acted).toBe("confirmation");
    });

    it("fails an action case whose confirmation is wired to nothing", async () => {
      const trace = await traceOf(CONFIRMED_DEAD);

      // The same dialog, the same words, the same opening press — and the paths
      // are where the two pages finally differ.
      expect(trace).toEqual([
        {
          ...OPENED,
          inside: [
            { label: "Keep it", changed: true, calls: [] },
            { label: "Yes, cancel it", changed: false, calls: [] },
          ],
        },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.acted).toBeUndefined();
      expect(result.why).toContain("nothing inside its confirmation asked the host to change anything");

      // The press that OPENED it is still a live local control, and the dialog's
      // own buttons are still not controls of the screen: the candidates are
      // counted on the untouched page, where the dialog does not exist yet.
      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0]).toMatchObject({ effect: "state" });
    });

    it("judges a confirmation with one control by that control alone", async () => {
      const trace = await traceOf(SOLE);

      expect(trace[0]!.inside).toEqual([
        { label: "Yes, cancel it", changed: true, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
      ]);
      // No decline to look for, because there is nothing else in the dialog to
      // be one.
      expect(wiredActions(trace, world, ["action"]).acted).toBe("confirmation");
    });

    it("fails a confirmation with no way to decline", async () => {
      const trace = await traceOf(NO_DECLINE);

      expect(trace[0]!.inside).toEqual([
        { label: "Cancel this one", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
        { label: "Cancel them all", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_2" } }] },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.why).toContain("there is no way to decline");
    });

    it("leaves the control after it exactly the press it would have been", async () => {
      const trace = await traceOf(BESIDE);

      expect(trace).toHaveLength(2);
      expect(trace[0]!.inside).toHaveLength(2);
      // Walking the dialog repainted the screen twice; the next candidate is
      // pressed on a page that has forgotten all of it, and is credited with its
      // own call and nothing else.
      expect(trace[1]).toEqual({ label: "Refresh", changed: false, calls: [{ name: "list_transfers", args: { limit: 5 } }] });
      expect(wiredActions(trace, world, ["action"]).pass).toBe(true);
    });

    it("caps a dialog of fine print instead of letting it become the trace", async () => {
      const trace = await traceOf(chain(`add("Yes, cancel it", null);`, "x".repeat(900)));

      expect(trace[0]!.dialog).toBe("x".repeat(500));
    });
  });
});
