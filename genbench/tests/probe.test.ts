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
import { authoredPage, openBrowser, type Shooter } from "../src/render.js";
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

/** The same wired button on a page that leaves the recorder to the HARNESS —
 *  every fixture here declares its own, and a recorder a page brought itself is
 *  one the guard never sees. `authoredPage` injects the real seam into this. */
const WIRED_ON_SEAM = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>control</title></head><body>
<div id="root"><button id="go">Cancel transfer</button></div>
<script>
  document.getElementById("go").addEventListener("click", function () {
    window.vendo.callTool("cancel_transfer", { id: "tr_1" });
  });
</script>
</body></html>`;

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

/**
 * The tab the screen opens on, beside the tab it does not.
 *
 * Pressing the selected tab calls nothing and moves nothing BY DESIGN — it is
 * already showing what it switches to — and that recorded as a dead control, so a
 * `price-book` screen correctly opened on Plumbing failed `wiredActions` for the
 * one press it had right. Two columns of one run, on the same screen.
 */
const TABS = screen(
  `<button role="tab" aria-selected="true">Plumbing</button>
  <button id="other" role="tab" aria-selected="false">Electrical</button>`,
  `document.getElementById("other").addEventListener("click", function () {
    window.vendo.callTool("list_transfers", { limit: 5 });
  });`,
);

/** The same no-op one species over: a radio already on. Pressing it cannot change
 *  what it says, so there is nothing to fire and nothing to move. */
const PICKED = screen(`<input id="monthly" type="radio" aria-label="Monthly" checked>`);

/**
 * A screen with no button at all: choosing the value IS the save.
 *
 * `<Select onChange={(e) => tools.categorize_expense(...)}>` with nothing beside it
 * is a real screen — two worlds of one run are built out of it, nine choosers and
 * zero buttons — and the probe pressed buttons, toggles and boxes, so every one of
 * them recorded `pressed: 0` and auto-failed the action case it correctly
 * implements. What the probe chooses is the first REAL option that is not the one
 * already showing: re-choosing what a select already holds fires no `change` at
 * all, so a screen with no placeholder would read as dead however well it is wired.
 */
const SAVES_ON_CHOICE = screen(
  `<select id="cap" aria-label="Coffee cap">
    <option value="1000">$10 a month</option>
    <option value="5000">$50 a month</option>
  </select>`,
  `document.getElementById("cap").addEventListener("change", function () {
    window.vendo.callTool("set_budget", { category: "coffee", limit_cents: Number(this.value) });
  });`,
);

/** The same chooser around a page that puts the value back, once or forever — the
 *  one shape a dropped choice and a refused one share, since both leave the
 *  chooser holding what it held. */
const chooser = (handler: string): string =>
  screen(
    `<select id="cap" aria-label="Coffee cap">
    <option value="1000">$10 a month</option>
    <option value="5000">$50 a month</option>
  </select>`,
    handler,
  );

/**
 * A chooser whose first answer does not stick.
 *
 * `selectOption` is silent when it fails — the failure is swallowed like every
 * other press's — so a choice that never landed was recorded as a choice that did,
 * with `changed: false` beside it because nothing had moved. That is a dead control
 * by every reading the floor has, and it convicted a correctly wired screen: the
 * only floor failure of the 2026-08-18T21-39-10 sweep was
 * `project-tracker/open-issues`'s FIRST chooser, whose twin — pressed one reload
 * later — took its value fine. The value is read back now, and a choice that did
 * not land is made once more before it is believed.
 */
const REFUSES_ONCE = chooser(`var refused = false;
  document.getElementById("cap").addEventListener("change", function () {
    if (!refused) { refused = true; this.value = "1000"; return; }
    window.vendo.callTool("set_budget", { category: "coffee", limit_cents: Number(this.value) });
  });`);

/** And one that never takes it. The retry is bounded at one, because a probe that
 *  retries until it works returns a verdict that depends on how long it tried — so
 *  this is what the harness looks like when it never got to ask the question. */
const REFUSES_ALWAYS = chooser(`document.getElementById("cap").addEventListener("change", function () {
    this.value = "1000";
  });`);

/**
 * The tab the run was actually failed on: pressing it swaps the panel beneath it.
 *
 * It asks the host for nothing and moves the screen, which recorded as
 * `changed: true` and not one word about WHAT changed — so a tab that paints a
 * whole category of rows and a tab that only lights itself up were the same entry.
 * The judge reads this trace and not the screen mid-press, and it called the
 * working one broken: `trades-accounting/price-book` lost three correctness lines
 * to "the HVAC and Electrical tabs are inert per the trace", against a trace saying
 * `changed: true` for both of them.
 */
const SWAPS_PANEL = screen(
  `<button role="tab" aria-selected="true">Plumbing</button>
  <button id="hvac" role="tab" aria-selected="false">HVAC</button>
  <p id="panel">Drain snaking</p>`,
  `document.getElementById("hvac").addEventListener("click", function () {
    document.getElementById("panel").textContent = "Rooftop units and ductwork";
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
 * The same locked button with a second chooser beside the one it waits for,
 * already holding a value the screen itself picked.
 *
 * The precondition pass set EVERY select on the page to its first real option, so
 * the shot everybody grades said "$50 a month" and the call carried $10 — and the
 * judge, comparing the two, correctly convicted the screen of the harness's edit.
 * A value the screen is already showing is the screen's own, exactly as the text
 * already in a box is.
 */
const DEFAULTED = screen(
  `<select id="category"><option value="">Pick a category</option><option value="coffee">coffee</option></select>
  <select id="cap" aria-label="Coffee cap">
    <option value="1000">$10 a month</option>
    <option value="5000" selected>$50 a month</option>
  </select>
  <button id="go" disabled>Save cap</button>`,
  `document.getElementById("category").addEventListener("change", function () {
    document.getElementById("go").disabled = this.value === "";
  });
  document.getElementById("go").addEventListener("click", function () {
    window.vendo.callTool("set_budget", {
      category: document.getElementById("category").value,
      limit_cents: Number(document.getElementById("cap").value),
    });
  });`,
);

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

/**
 * The same shape again, with the one box that is not text.
 *
 * "Priority, assignee, estimate — and file it" is a form with a required NUMBER,
 * and the probe's `ENTRY` matched text boxes only: the estimate stayed empty, the
 * submit it guards never unlocked, and `project-tracker/file-bug` recorded two
 * choices and no press that asked the host for anything. The value has to be a
 * number too — a number box will not hold `probe input` at all, so the string would
 * have left the box as empty as never touching it — which is why the call below
 * carries the digit rather than a `NaN`.
 */
const REQUIRED_NUMBER = screen(
  `<input id="estimate" type="number" placeholder="Estimate (points)">
  <button id="go" disabled>File it</button>`,
  `document.getElementById("estimate").addEventListener("input", function () {
    document.getElementById("go").disabled = this.value === "";
  });
  document.getElementById("go").addEventListener("click", function () {
    window.vendo.callTool("set_budget", {
      category: "coffee",
      limit_cents: Number(document.getElementById("estimate").value),
    });
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
 * The second step in the PAGE, with no dialog anywhere near it.
 *
 * "Press Hand off, pick an assignee, press Confirm" is a whole action, and the
 * probe walked into `[role=dialog]` and not into this — so the press that opens the
 * step was recorded as a control that changed the screen, the controls that do the
 * work went unpressed, and `project-tracker`'s `capacity-rebalance` and
 * `my-issues-inbox` failed `actionProven` in the columns that had the flow RIGHT.
 *
 * The picker and the Save are one step, not two ways out of one question: the Save
 * is locked until the picker is answered, so this page is also the proof that the
 * revealed controls are pressed in order on ONE page. Walked in isolation like a
 * dialog's paths, the Save would be disabled on its own fresh page and skipped, and
 * the write behind it would still be unprovable.
 */
const reveal = (save: string): string =>
  screen(
    `<button id="go">Set a cap</button><div id="step"></div>`,
    `document.getElementById("go").addEventListener("click", function () {
    setTimeout(function () {
      document.getElementById("step").innerHTML =
        '<select id="cap"><option value="">Pick a cap</option><option value="5000">$50 a month</option></select>'
        + '<button id="save" disabled>Save cap</button>';
      document.getElementById("cap").addEventListener("change", function () {
        document.getElementById("save").disabled = this.value === "";
      });
      ${save}
    }, 50);
  });`,
  );

const REVEALS = reveal(`document.getElementById("save").addEventListener("click", function () {
        window.vendo.callTool("set_budget", {
          category: "coffee",
          limit_cents: Number(document.getElementById("cap").value),
        });
      });`);

/** The same step with its Save wired to nothing — identical to a person right up
 *  until they press it, and the class of screen that must not start passing
 *  because the probe walked one press further. */
const REVEALS_DEAD = reveal("");

/** A step whose first control takes the step away. The walk is one pass in
 *  document order and never a hunt, so what is gone when its turn comes is
 *  skipped — recording it as a press that fired nothing would invent the dead
 *  control this walk exists to stop inventing. */
const REVEALS_DISMISS = screen(
  `<button id="go">Set a cap</button><div id="step"></div>`,
  `document.getElementById("go").addEventListener("click", function () {
    var step = document.getElementById("step");
    step.innerHTML = '<button id="drop">Not now</button><button id="save">Save cap</button>';
    document.getElementById("drop").addEventListener("click", function () { step.innerHTML = ""; });
    document.getElementById("save").addEventListener("click", function () {
      window.vendo.callTool("set_budget", { category: "coffee", limit_cents: 5000 });
    });
  });`,
);

/**
 * The inline step whose LAST control is a confirmation.
 *
 * `project-tracker/capacity-rebalance` failed `actionProven` with the whole flow
 * right: "Hand off" reveals a picker and a Confirm, Confirm opens a Modal, and the
 * Modal's own button is what calls the tool — one press past where the reveal walk
 * stopped. So a reveal's press is walked into its dialog now, exactly as a press on
 * the screen itself is.
 *
 * The way OUT is deliberately first in document order, which is where the Kit's own
 * Modal puts it — the close affordance is drawn before the footer. Pressed in one
 * pass, that "✕" closes the dialog and the control that writes is gone before its
 * turn; only the fresh page each path is given can reach it. So this page is the
 * proof that the dialog walk's isolation is really being used, and not merely
 * wired up.
 */
const HANDOFF_SAID = "Reassign this issue? It hands the issue to a different teammate.";
const handoff = (through: string): string =>
  screen(
    `<button id="go">Hand off</button><div id="step"></div>`,
    `document.getElementById("go").addEventListener("click", function () {
    var step = document.getElementById("step");
    step.innerHTML =
      '<select id="who"><option value="">Choose a teammate</option><option value="acc_savings">Maya Okafor</option></select>'
      + '<button id="confirm" disabled>Confirm</button><button id="back">Cancel</button>';
    document.getElementById("who").addEventListener("change", function () {
      document.getElementById("confirm").disabled = this.value === "";
    });
    document.getElementById("back").addEventListener("click", function () { step.innerHTML = ""; });
    document.getElementById("confirm").addEventListener("click", function () {
      var dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      var message = document.createElement("p");
      message.textContent = ${JSON.stringify(HANDOFF_SAID)};
      var close = document.createElement("button");
      close.setAttribute("aria-label", "Close");
      close.textContent = "\\u2715";
      close.addEventListener("click", function () { dialog.remove(); });
      var act = document.createElement("button");
      act.textContent = "Reassign";
      ${through}
      dialog.append(message, close, act);
      document.getElementById("root").append(dialog);
    });
  });`,
  );

const HANDS_OFF = handoff(`act.addEventListener("click", function () {
        window.vendo.callTool("set_budget", { category: "coffee", limit_cents: 5000 });
        dialog.remove();
      });`);

/** The same three presses and the same confirmation, with the one control that
 *  writes wired to nothing. Walking further must not turn this into a pass. */
const HANDS_OFF_DEAD = handoff("");

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

/**
 * A confirmation that was ALREADY on the screen when the press began.
 *
 * `reset()` re-paints the page inside the same script world, so a toast an earlier
 * candidate's press opened can be portalled into the fresh body by the previous
 * document's still-live runtime — and the press that follows was credited with it.
 * `buildlog/build-detail` lost its "offers exactly one control to run it again"
 * line that way: "View lint log" was recorded as having opened "Build queued to
 * run again.", the retry toast from three presses earlier, and the judge correctly
 * read that as a second control that reruns the build. It stands in the markup
 * here because the only thing that matters is that the words were up BEFORE this
 * press — a lingering toast and a mounted one are the same evidence.
 */
const LINGERING = screen(
  `<div role="dialog"><p>Build queued to run again.</p></div>
  <button id="go">Cancel transfer</button>`,
  `document.getElementById("go").addEventListener("click", function () {
    window.vendo.callTool("cancel_transfer", { id: "tr_1" });
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

  /**
   * The HARNESS's own recorder, not a fixture's, so the guard is in the loop
   * (2026-08-18): the seam parks a write, answers `pending-approval`, and approves
   * it a microtask later, writing both onto the entry it released. Everything the
   * judge is told about a confirmation this product actually ships comes off these
   * two fields, so the probe has to carry them out of the page — the fixtures above
   * bring their own recorder and would never show it.
   */
  it("carries what the host did with a guarded write into the trace", async () => {
    const trace = await traceOf(authoredPage(WIRED_ON_SEAM, world, "diy-sonnet"));

    expect(trace).toEqual([
      {
        label: "Cancel transfer",
        changed: false,
        calls: [{ name: "cancel_transfer", args: { id: "tr_1" }, status: "ok", approvalId: "apr_1" }],
      },
    ]);
    // The guard leaves the name and the arguments alone, which is the whole
    // reason no floor check moved with it.
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

  it("passes a button that only changes the screen, and says what it put there", async () => {
    const trace = await traceOf(STATE_ONLY);

    // And says WHAT changed, not only that something did (2026-08-18): the words
    // the press revealed are the difference between a control that paints a panel
    // and one that only lights itself up, and the judge has no other way to tell.
    expect(trace).toEqual([
      { label: "Cancel transfer", changed: true, showed: "Transfer to Alex Rivera, arriving Tuesday", calls: [] },
    ]);

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

      // Two controls, in document order: a `<select>` is what the screen ASKS for
      // AND a species in its own right (2026-08-18), so it is pressed on its own
      // page as well as set on the button's. It holds on having unlocked the
      // button — which moves none of the screen's text, elements or toggles, and
      // is why what a person can press is counted too. `changed: false` on the
      // button is the other half of that: the screen moving under the choice
      // belongs to the choice, and crediting it to the press would make a dead
      // button look alive.
      //
      // `chose` is on both (2026-08-18): the harness picked `coffee` and the call
      // carries `coffee`, and a trace that did not say so let the judge read the
      // harness's own pick as a value the screen invented.
      expect(trace).toEqual([
        { label: "Pick a category", changed: true, chose: [{ field: "Pick a category", value: "coffee" }], calls: [] },
        {
          label: "Save cap",
          changed: false,
          chose: [{ field: "Pick a category", value: "coffee" }],
          calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }],
        },
      ]);
      expect(wiredActions(trace, world, ["action"]).pass).toBe(true);
    });

    it("presses a chooser by choosing, and grades a screen that saves on the choice", async () => {
      const trace = await traceOf(SAVES_ON_CHOICE);

      // Named by the option it was SHOWING, fired with the one it moved to: the
      // two together are the "not the one already showing" rule, which is the
      // whole reason a select with no placeholder can be pressed at all. `changed`
      // is true on its own account now (2026-08-18) — the select's displayed
      // value moved from $10 to $50 — on top of the call it fired. And `chose` is
      // what says the $50 in that call is the harness's pick rather than a figure
      // the screen invented, on a screen whose shot still reads $10.
      expect(trace).toEqual([
        {
          label: "$10 a month",
          changed: true,
          chose: [{ field: "$10 a month", value: "$50 a month" }],
          calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }],
        },
      ]);
      expect(wiredActions(trace, world, ["action"]).pass).toBe(true);
    });

    /**
     * The choice is read back, so a chooser that did not take it gets asked twice.
     *
     * Nothing about `selectOption` says it failed, so the probe believed a choice
     * the page never received and recorded `changed: false` beside a value it
     * claimed to have set — a dead control by every reading the floor has, and the
     * only floor failure of the 2026-08-18T21-39-10 sweep.
     */
    it("asks a chooser twice when the first answer did not stick", async () => {
      const trace = await traceOf(REFUSES_ONCE);

      // The second answer landed, so this is an ordinary chooser press: the value
      // moved, the tool fired with it, and nothing on the trace says the harness
      // had to ask twice — which is right, because the screen answered.
      expect(trace).toEqual([
        {
          label: "$10 a month",
          changed: true,
          chose: [{ field: "$10 a month", value: "$50 a month" }],
          calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }],
        },
      ]);
      expect(wiredActions(trace, world, ["action"]).pass).toBe(true);
    });

    /** And a chooser whose value never moves after that second ask is the HARNESS
     *  reporting it never got to put the question — its own binding kind, the way
     *  an already-active control is, rather than a dead control the screen is
     *  charged for. Never `chose`, either: a value the page refused is not one the
     *  trace may tell the judge the screen was given. */
    it("blames nobody for a chooser that would not take a value at all", async () => {
      const trace = await traceOf(REFUSES_ALWAYS);

      expect(trace).toEqual([{ label: "$10 a month", changed: false, choiceDropped: true, calls: [] }]);

      const result = wiredActions(trace, world);
      expect(result.pass).toBe(true);
      expect(result.bindings[0]).toEqual({
        where: "$10 a month",
        effect: "choice-dropped",
        why: "the chooser never took the harness's value, so it was never put to the question",
      });
    });

    it("leaves a chooser that already holds a real value alone", async () => {
      const trace = await traceOf(DEFAULTED);

      // $50 is the screen's own default and it is what the call carries. Set to
      // its first option like the chooser beside it, the screen would have shown
      // one number and sent another. Only the chooser the harness DID answer is on
      // `chose`, which is the same rule read from the other end.
      expect(trace.find((probed) => probed.label === "Save cap")).toEqual({
        label: "Save cap",
        changed: false,
        chose: [{ field: "Pick a category", value: "coffee" }],
        calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }],
      });
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

    it("answers a required NUMBER box with a number, then presses what it unlocked", async () => {
      const trace = await traceOf(REQUIRED_NUMBER);

      // The digit rather than the string, because a number box holds one and not
      // the other: the value the harness supplied is on the trace under its own
      // name, and the call carries `3` rather than the `NaN` a text answer would
      // have sent — or the nothing an unfilled box would have.
      expect(trace).toEqual([
        {
          label: "File it",
          changed: false,
          filled: [{ field: "Estimate (points)", value: "3" }],
          calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 3 } }],
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

    it("leaves a control that stays locked unpressed, and never counts it as a press", async () => {
      const trace = await traceOf(LOCKED);

      // The button is the careful half — still locked after the choice, so it is
      // never pressed and never graded, and `pressed: 1` is the chooser rather
      // than it. The chooser itself is not dead: choosing "coffee" moves its own
      // displayed value from the placeholder, on the same evidence a toggle that
      // only flips itself is credited with (2026-08-18) — `effect: "state"` is
      // "the screen moved without calling a tool", and unlocking nothing else is
      // a separate, true fact this trace still carries in `pressed: 1`.
      expect(trace).toEqual([
        { label: "Pick a category", changed: true, chose: [{ field: "Pick a category", value: "coffee" }], calls: [] },
      ]);

      const result = wiredActions(trace, world);
      expect(result.pressed).toBe(1);
      expect(result.bindings).toEqual([
        { where: "Pick a category", effect: "state", why: "changed the screen without calling a tool" },
      ]);
    });
  });

  /**
   * Idempotence is not deadness (2026-08-18).
   *
   * Pressing the control that is ALREADY the active one — the tab the screen opens
   * on, the radio already picked — calls nothing and moves nothing because that is
   * what it is supposed to do. The floor read it as a dead control, so a screen
   * whose tabs work failed on the one tab a person is already looking at. It is its
   * own kind now: it neither earns a pass nor costs one, the way a screen with
   * nothing to press is vacuous rather than wrong.
   */
  describe("reads a control that is already the active one as a no-op", () => {
    it("passes the tab the screen opens on, and grades the one beside it as usual", async () => {
      const trace = await traceOf(TABS);

      expect(trace).toEqual([
        { label: "Plumbing", alreadyActive: true, changed: false, calls: [] },
        { label: "Electrical", changed: false, calls: [{ name: "list_transfers", args: { limit: 5 } }] },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.bindings[0]).toEqual({
        where: "Plumbing",
        effect: "already-active",
        why: "already-active — a no-op by design",
      });
      expect(result.pass).toBe(true);
    });

    it("reads a radio that is already on the same way", async () => {
      const trace = await traceOf(PICKED);

      expect(trace).toEqual([{ label: "Monthly", alreadyActive: true, changed: false, calls: [] }]);
      expect(wiredActions(trace, world).pass).toBe(true);
    });

    /**
     * And the tab BESIDE it says what it painted, not just that it painted
     * something (2026-08-18).
     *
     * The floor was never the problem here — a press that moves the screen has
     * always held — the JUDGE was: "called nothing, and changed the screen" is the
     * same sentence for a tab that swaps in a whole category and a tab that only
     * highlights itself, and it read the working one as inert on the run that found
     * this. So the words the press revealed are on the trace, bounded, and the line
     * a person could already read stays off it.
     */
    it("records what a tab painted, not only that the screen moved", async () => {
      const trace = await traceOf(SWAPS_PANEL);

      expect(trace).toEqual([
        { label: "Plumbing", alreadyActive: true, changed: false, calls: [] },
        { label: "HVAC", changed: true, showed: "Rooftop units and ductwork", calls: [] },
      ]);
      // "Drain snaking" is gone and "HVAC" was on the screen all along: what the
      // press SHOWED is what is there now and was not there before, by the line.
      expect(trace[1]!.showed).not.toContain("Drain snaking");
      expect(trace[1]!.showed).not.toContain("HVAC");
      expect(wiredActions(trace, world).pass).toBe(true);
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

    it("credits a press with a confirmation it opened, never with one already standing", async () => {
      const trace = await traceOf(LINGERING);

      // The words were on the screen before the click, so they are not this
      // press's evidence — and nothing inside a dialog this control never opened
      // is walked as a way out of it.
      expect(trace).toEqual([
        { label: "Cancel transfer", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
      ]);
    });
  });

  /**
   * The same walk for the second step that has no dialog to live in (2026-08-18).
   *
   * A press that reveals new pressable controls INLINE was recorded as a control
   * that changed the screen and nothing more, so a correctly wired second step went
   * unproven: two `project-tracker` screens failed `actionProven` with their write
   * one press past where the evidence stopped, in the columns that had them right.
   * The controls a press revealed are pressed now — one level deep, never
   * recursive, and in the order a person meets them rather than one per fresh page,
   * because a picker and the Save beside it are one step and not two answers to one
   * question.
   */
  describe("presses the controls a press reveals in the page", () => {
    it("proves an action whose write lives one press inside an inline step", async () => {
      const trace = await traceOf(REVEALS);

      // The chosen option is on the path that chose it, in the words it SHOWS —
      // the same reason a filled box is on the press it bought, one level in. And
      // `showed` is what the opening press put on the screen IN WORDS (2026-08-18):
      // "changed the screen" said that something appeared and never what, which is
      // the whole reason a working tab could read as an inert one.
      expect(trace).toEqual([
        {
          label: "Set a cap",
          changed: true,
          showed: "Pick a cap · $50 a month · Save cap",
          calls: [],
          revealed: [
            { label: "Pick a cap", changed: true, chose: [{ field: "Pick a cap", value: "$50 a month" }], calls: [] },
            {
              label: "Save cap",
              changed: false,
              calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }],
            },
          ],
        },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.pass).toBe(true);
      expect(result.acted).toBe("revealed");
    });

    it("fails an action case whose inline step is wired to nothing", async () => {
      const trace = await traceOf(REVEALS_DEAD);

      // The same page, the same step, the same opening press — and the paths are
      // where the two finally differ.
      expect(trace[0]!.revealed).toEqual([
        { label: "Pick a cap", changed: true, chose: [{ field: "Pick a cap", value: "$50 a month" }], calls: [] },
        { label: "Save cap", changed: false, calls: [] },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.acted).toBeUndefined();
      expect(result.why).toContain("no press ever asked the host for anything");
      // And walking one press further never invents a failure: the revealed
      // controls are not bindings, so the screen is graded on its own one press.
      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0]).toMatchObject({ effect: "state" });
    });

    it("skips a revealed control an earlier press in the step took away", async () => {
      const trace = await traceOf(REVEALS_DISMISS);

      // "Not now" empties the step, so the Save is not there when its turn comes.
      // It goes unrecorded rather than pressed into thin air — a five-second click
      // that lands on nothing would read as a control that did nothing.
      expect(trace[0]!.revealed).toEqual([{ label: "Not now", changed: true, calls: [] }]);
      expect(wiredActions(trace, world, ["action"]).acted).toBeUndefined();
    });

    it("walks into a confirmation a revealed press opened, and proves the write behind it", async () => {
      const trace = await traceOf(HANDS_OFF);

      const confirmed = trace[0]!.revealed!.find((path) => path.label === "Confirm")!;
      // The dialog's own words are on the press that opened it, one level in, and
      // both ways out of it were pressed — each on a page that walked the whole
      // step again, which is the only way the "✕" drawn before them does not take
      // the one that writes off the screen first.
      expect(confirmed.dialog).toContain(HANDOFF_SAID);
      expect(confirmed.inside).toEqual([
        // Named by the words on it — the "✕" a person actually reads — because
        // `nameOf` prefers what a control SAYS to what it is labelled.
        { label: "✕", changed: true, calls: [] },
        { label: "Reassign", changed: true, calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }] },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.pass).toBe(true);
      expect(result.acted).toBe("revealed");
    });

    it("fails the same flow when the confirmation behind the step is wired to nothing", async () => {
      const trace = await traceOf(HANDS_OFF_DEAD);

      // Identical to a person up to the last press. Both ways out were reached and
      // neither wrote, so walking two levels bought this screen nothing.
      const confirmed = trace[0]!.revealed!.find((path) => path.label === "Confirm")!;
      expect(confirmed.inside).toEqual([
        { label: "✕", changed: true, calls: [] },
        { label: "Reassign", changed: false, calls: [] },
      ]);

      const result = wiredActions(trace, world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.acted).toBeUndefined();
    });

    it("stops at the dialog a reveal opened, and never walks a dialog inside one", async () => {
      const trace = await traceOf(HANDS_OFF);

      // Reveal, then dialog, then stop: the depth is two by construction, because
      // `insideDialog` records no dialog of its own. Nothing here can grow it.
      for (const path of trace[0]!.revealed!.find((step) => step.label === "Confirm")!.inside!) {
        expect(path).not.toHaveProperty("dialog");
        expect(path).not.toHaveProperty("inside");
      }
    });

    it("does not walk a dialog twice by calling its controls a reveal", async () => {
      const trace = await traceOf(CONFIRMED);

      // A dialog's controls ARE controls the press revealed. They are walked as
      // paths of the confirmation, under the isolation that walk promises, and
      // never again as a reveal.
      expect(trace[0]!.inside).toHaveLength(2);
      expect(trace[0]).not.toHaveProperty("revealed");
    });
  });
});
