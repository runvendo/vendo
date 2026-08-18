import type { Locator, Page } from "@playwright/test";
import type { Visit } from "./render.js";

/**
 * The click probe — identical for every contender, because the page is the only
 * thing that differs.
 *
 * It presses everything a person could press and records what each press asks
 * the host to do, through the one recorder every page answers with
 * (`window.vendo.callTool`). A screen that LOOKS wired and a screen that IS
 * wired are indistinguishable from the artifact alone; they are not
 * indistinguishable here.
 */

/**
 * Every SPECIES of control a person can press, by the role it answers to.
 *
 * Buttons alone was the whole list, and that graded reachability-by-probe rather
 * than wiring: a screen whose only actuators are toggles — each one correctly
 * bound to a tool — was read as a screen with nothing to press and scored
 * `pressed: 0`, while a screen of always-enabled buttons that call nothing scored
 * better for being button-shaped. Roles rather than tags, because a role is the
 * one thing the Kit's markup (`<span role=switch>`, Base UI's) and a hand-written
 * page's (`<input type=checkbox>`) have in common; the two native inputs are here
 * because they carry their role implicitly rather than in an attribute.
 */
const SPECIES = [
  "button",
  "[role=button]",
  "a[href]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=menuitem]",
  "input[type=checkbox]",
  "input[type=radio]",
];

/** A control hidden from assistive tech is the SAME control as the one beside it:
 *  Base UI pairs the switch and the radio a person presses with an `aria-hidden`
 *  proxy input that carries the form value, so pressing both would press one
 *  control twice and count it twice. */
const SHOWN = ":not([aria-hidden=true])";

/** What can be pressed as the screen stands. A disabled control is not actionable,
 *  so it is not pressed — grading it would fail a screen for being careful — but
 *  it is no longer invisible either: see `CHOICE`. */
const ACTIONABLE = SPECIES.map((species) => `${species}${SHOWN}:not([disabled]):not([aria-disabled=true])`).join(", ");

/** Every control of every species in document order, whatever state it is in. One
 *  index space, so a control that was locked when the page was counted is still
 *  the same control after the choice that unlocks it. */
const CONTROLS = SPECIES.map((species) => `${species}${SHOWN}`).join(", ");

/**
 * The preconditions the probe satisfies: what the screen is ASKING for before it
 * will take a press — a choice, and an answer.
 *
 * "Pick an agent, then press Assign" is a correctly built screen, and it was
 * failing — the probe never touched the chooser, so the button stayed disabled,
 * nothing was pressed, and a case that asked the screen to DO something scored
 * zero wired controls. So the chooser gets set, only to an option the screen
 * itself offers.
 */
const CHOICE = "select:not([disabled])";

/**
 * The same shape one turn further: "type a reason, then press Deny".
 *
 * The probe used to type nothing at all, because a value the harness invented is
 * data no screen claimed, riding into a tool call the judge then grades as the
 * screen's own. `TYPED` is what resolves that — it is obviously the harness's, it
 * goes on the trace beside the press it enabled, and a tool call carrying it is
 * proof the field is wired to the tool rather than decoration. A field the screen
 * disabled or froze is not a field it is asking for, exactly as with a chooser.
 */
const ENTRY = ["input[type=text]", "input:not([type])", "textarea"]
  .map((field) => `${field}:not([disabled]):not([readonly])`)
  .join(", ");

/** One fixed string, never a random or a clock-shaped one: two runs of the same
 *  screen must type the same thing, and what the harness typed has to be
 *  recognisable as the harness's wherever the trace is read. */
const TYPED = "probe input";

/** What "switched on" looks like whoever drew the control — `aria-checked` where
 *  the page paints its own toggle, `:checked` where it uses the browser's. */
const ON = "[aria-checked=true], :checked";

/** A press that never lands says "fired nothing", which is the verdict either
 *  way; this only stops one stuck control from spending the case's whole budget.
 *  A choice that never lands is bounded by the same number for the same reason. */
const CLICK_MS = 5_000;

/** How long a locked control gets to WAKE once the screen has what it asked for.
 *  A screen re-renders a beat after a choice, exactly as a press lands a beat
 *  after a click, and reading `disabled` on the line after would call a control
 *  that is about to open dead. Spent only on a control that stays locked. */
const WAKE_MS = 1_000;

/**
 * How long a press gets to LAND before what it did is read off the page.
 *
 * A press used to be read on the line after the click, which is only correct
 * while a handler calls the host synchronously. An interactive screen routes the
 * same press through its runtime — a millisecond or two, but a turn of the event
 * loop either way — so the synchronous read saw an empty recorder and graded a
 * live control dead. This is the bound on a STUCK control, not the expected
 * wait: the wait ends the moment the press does anything at all.
 */
const EFFECT_MS = 2_000;

/** Enough of a confirmation for a judge to grade what it says, and not so much
 *  that a dialog of fine print becomes the whole trace. */
const DIALOG_CHARS = 500;

export interface Fired {
  readonly name: string;
  readonly args: unknown;
}

/** One field the HARNESS answered for the screen, and what it put there. */
export interface Filled {
  readonly field: string;
  readonly value: string;
}

/**
 * One way out of a confirmation, pressed on its own fresh page.
 *
 * Which control confirms is still not the probe's business — it presses ALL of
 * them, one per path, and records what each did. Which one the words call
 * "Confirm" is a judgement, and the judge makes it off the dialog's text.
 */
export interface Path {
  readonly label: string;
  /** The dialog closed, or the screen moved under it. */
  readonly changed: boolean;
  readonly calls: readonly Fired[];
}

export interface Probed {
  readonly label: string;
  /** The visible text of a `[role=dialog]` the press opened. What the dialog SAYS
   *  is evidence only the judge can read, so it is carried verbatim. Absent when
   *  none opened. */
  readonly dialog?: string;
  /** Every control inside that dialog, each pressed once, each on a page that
   *  reached the dialog again from scratch (2026-08-17).
   *
   *  The opening used to be the whole record, and a dialog whose buttons are
   *  wired to nothing was then indistinguishable from one that acts — both
   *  cleared an `action` case's bar on having opened. So a rubric line like
   *  "pressing approve fires approve_refund" could never be evidenced for any
   *  action that lives behind a confirmation, and every column failed those lines.
   *  Present exactly when `dialog` is; empty when the dialog had nothing
   *  pressable in it, which is itself the verdict on that dialog. */
  readonly inside?: readonly Path[];
  /** The fields the harness filled to get this press, and with what. Present
   *  exactly when it filled any: the screen did not have this data, so every
   *  reader of the trace — the judge included — is told where it came from before
   *  it grades a call that carries it. */
  readonly filled?: readonly Filled[];
  /** The press visibly moved the screen — a dialog opened, a tab switched, a row
   *  was dismissed, a toggle flipped. What tells a control that only changes local
   *  state apart from one that is dead, since neither asks the host for anything. */
  readonly changed: boolean;
  readonly calls: readonly Fired[];
}

/** What the screen is, in the four cheapest numbers that answer "did that press
 *  do anything": what it has asked the host for, how much text it is showing, how
 *  many elements are showing it, and how many of its controls are on.
 *
 *  One reader for both sides of a press, so what the wait below watched for and
 *  what the trace records can never disagree about what changed. */
interface Look {
  readonly calls: readonly Fired[];
  readonly text: number;
  readonly elements: number;
  /** How many of the screen's controls are switched on. A toggle that flips
   *  changes neither the text nor the element count, so by those two alone a
   *  switch a person can see move was a control that did nothing — the false
   *  failure that pressing toggles at all would otherwise have invented. */
  readonly on: number;
}

/** Nothing evaluated in the page may be a NAMED function: tsx compiles this file
 *  with esbuild's keepNames, which wraps one in a `__name` helper that exists in
 *  node and not in the page — see the longer note in `render.ts`.
 *
 *  The recorder is read as it might not be there. A contender may define its own
 *  `window.vendo` without a `calls` array, and a link may have navigated the page
 *  off the seam entirely; both are screens that asked the host for nothing, and
 *  reading them as an exception loses the whole case instead of one press. */
const look = async (page: Page): Promise<Look> =>
  await page.evaluate(
    (on: string) => ({
      calls: window.vendo?.calls ?? [],
      text: document.body.innerText.length,
      elements: document.querySelectorAll("*").length,
      on: document.querySelectorAll(on).length,
    }),
    ON,
  );

/** The wait a press earns: until it asks the host for something it had not asked
 *  for, or until the screen it is on is no longer the screen it was pressed on.
 *  A press that does neither spends the whole bound and is read as it stands,
 *  which is the honest verdict for a dead control. */
const settle = async (page: Page, before: Look): Promise<void> => {
  // The selector rides along rather than being spelled a second time here: this
  // wait and the reading above have to agree about what "on" means.
  const was = { calls: before.calls.length, text: before.text, elements: before.elements, on: before.on, onSelector: ON };
  await page
    .waitForFunction(
      (mark: typeof was) =>
        window.vendo.calls.length > mark.calls
        || document.body.innerText.length !== mark.text
        || document.querySelectorAll("*").length !== mark.elements
        || document.querySelectorAll(mark.onSelector).length !== mark.on,
      was,
      { timeout: EFFECT_MS },
    )
    .catch(() => undefined);
};

/**
 * Everything the screen is asking for, given once, in document order: every
 * chooser set to its first REAL option, then every empty field answered.
 *
 * Option zero is usually the placeholder — "Assign to…", value `""` — which is
 * the exact state the control was guarded against, so it is skipped. One pass and
 * no second guess: nothing here hunts for the combination that unlocks a screen,
 * because a probe that hunts returns a verdict that depends on how long it hunted.
 *
 * What it TYPED comes back, to go on the press it enabled. Only an empty field:
 * a value already in the box is the screen's own, and typing over it would take
 * away a default the press should have carried.
 */
const supply = async (page: Page): Promise<Filled[]> => {
  const choosers = page.locator(CHOICE);
  const many = await choosers.count();
  for (let index = 0; index < many; index += 1) {
    const chooser = choosers.nth(index);
    const option = await chooser
      .evaluate((node: HTMLSelectElement) => [...node.options].find((choice) => choice.value !== "" && !choice.disabled)?.value)
      .catch(() => undefined);
    if (option !== undefined) await chooser.selectOption(option, { timeout: CLICK_MS }).catch(() => undefined);
  }
  // Visible only: a field the screen is not showing is not one it is asking for,
  // and waiting out the bound on each of them would spend the case's budget.
  const fields = page.locator(ENTRY).filter({ visible: true });
  const asked = await fields.count();
  const filled: Filled[] = [];
  for (let index = 0; index < asked; index += 1) {
    const field = fields.nth(index);
    if ((await field.inputValue().catch(() => TYPED)) !== "") continue;
    // Filled, then LEFT: `input` is what a keystroke fires and `change` is what
    // leaving the box fires, and a screen may gate on either one.
    await field
      .fill(TYPED, { timeout: CLICK_MS })
      .then(() => field.blur())
      .catch(() => undefined);
    filled.push({ field: await nameOf(field, index), value: TYPED });
  }
  return filled;
};

/** What a control is called, in the words a person reads off it — or, for a box
 *  with no words of its own, the hint written inside it. */
const nameOf = async (element: Locator, index: number): Promise<string> => {
  const text = await element.innerText().catch(() => "");
  const aria = await element.getAttribute("aria-label").catch(() => null);
  const hint = await element.getAttribute("placeholder").catch(() => null);
  return (text || aria || hint || "").trim() || `control ${index + 1}`;
};

/**
 * One press, read the same way whichever side of a dialog's edge it is on.
 *
 * A press inside a confirmation is a press: it lands late for the same reason,
 * it asks the host through the same recorder, and it moves the screen the same
 * way. Written once so the two can never be graded by different rules.
 */
const press = async (visit: Visit, element: Locator, label: string): Promise<Probed> => {
  // Read BEFORE the click, and after any precondition: what a choice moved on
  // the screen belongs to the choice, and crediting it to the press would let a
  // chooser make a dead button look like a live one.
  const before = await look(visit.page);
  await element.click({ timeout: CLICK_MS }).catch(() => undefined);
  await settle(visit.page, before);

  // Read after the press has landed, so a confirmation the runtime paints a
  // frame late is still a confirmation and not a control that did nothing.
  // `isVisible` first because it answers on a missing element instead of
  // waiting for one, which every press that opens no dialog is.
  const dialog = visit.page.locator("[role=dialog]").first();
  const said = (await dialog.isVisible().catch(() => false))
    ? (await dialog.innerText().catch(() => "")).trim().slice(0, DIALOG_CHARS)
    : undefined;

  // A press that navigated away — a link with an href — leaves no screen to
  // read: it went somewhere, which is the change, and it asked the host for
  // nothing on the way. The screen is put back for the next candidate rather
  // than the whole case being lost to one anchor.
  const after = await look(visit.page).catch(() => undefined);
  if (after === undefined) await visit.reset();
  return {
    label,
    ...(said === undefined ? {} : { dialog: said }),
    changed:
      after === undefined || after.text !== before.text || after.elements !== before.elements || after.on !== before.on,
    // Only what THIS press asked for. The recorder is the page's, not the
    // press's, so handing over the whole array credited one load-time call to
    // every control on the screen and graded a dead button as wired.
    calls: after?.calls.slice(before.calls.length) ?? [],
  };
};

/**
 * Every way out of a confirmation, one per fresh page.
 *
 * The same isolation the screen's own controls get, one level in: a path is the
 * whole walk — the screen from scratch, the precondition it asked for, the press
 * that opened the dialog, then ONE control inside it — so no in-dialog press ever
 * sees what another one did. `reopen` is that walk, handed in by the caller
 * because only the caller knows which control opened this dialog and what it
 * needed first.
 *
 * The dialog is already standing when this is called, so the first path is walked
 * rather than re-walked. Only what a person can actually press counts as a path:
 * a control that is hidden or locked inside a dialog is not a way out of it, and
 * counting one as a press that fired nothing would hand a dialog the decline it
 * does not have.
 */
const insideDialog = async (visit: Visit, reopen: () => Promise<void>): Promise<Path[]> => {
  const controls = visit.page.locator("[role=dialog]").first().locator(ACTIONABLE).filter({ visible: true });
  const many = await controls.count();
  const paths: Path[] = [];
  for (let index = 0; index < many; index += 1) {
    if (index > 0) await reopen();
    const control = controls.nth(index);
    const { label, changed, calls } = await press(visit, control, await nameOf(control, index));
    // The dialog's own words are on the press that opened it; an in-dialog press
    // that leaves it standing has not opened a second confirmation, so nothing
    // here carries one.
    paths.push({ label, changed, calls });
  }
  return paths;
};

export async function probe(visit: Visit): Promise<Probed[]> {
  const trace: Probed[] = [];
  const controls = visit.page.locator(CONTROLS);
  const candidates = await controls.count();
  // Read once, on the page nobody has touched: with nothing on the screen to set
  // or to fill there is no precondition to satisfy, so a locked control is passed
  // over where it stands instead of costing a reload to learn the same thing.
  const asks = (await visit.page.locator(`${CHOICE}, ${ENTRY}`).count()) > 0;
  // The shot was taken on a page nobody had touched yet, so the first candidate
  // already has its fresh screen — and a candidate that was passed over left the
  // screen exactly as it found it, so it does not owe the next one a reload.
  let touched = false;
  for (let index = 0; index < candidates; index += 1) {
    if (touched) await visit.reset();
    const element = controls.nth(index);
    // Whether THIS control is pressable, rather than whether the screen has a
    // pressable control somewhere.
    const live = element.and(visit.page.locator(ACTIONABLE));
    // Whether the screen had to be given what it asked for before this control
    // would take a press — which is half of the walk back to a dialog it opens.
    let gave = false;
    // And what of that the harness TYPED, which belongs on this press: it is the
    // one part of the precondition the screen did not supply itself.
    let typed: readonly Filled[] = [];
    if ((await live.count()) === 0) {
      if (!asks) continue;
      touched = true;
      typed = await supply(visit.page);
      gave = true;
      // Still locked after the screen got what it asked for: it is guarding
      // something else, and a screen being careful is not a screen with a dead
      // control. It goes unpressed and ungraded, exactly as it did before.
      const woke = await live
        .waitFor({ state: "attached", timeout: WAKE_MS })
        .then(() => true)
        .catch(() => false);
      if (!woke) continue;
    }
    touched = true;
    const label = await nameOf(element, index);
    const pressed = { ...(await press(visit, element, label)), ...(typed.length === 0 ? {} : { filled: typed }) };
    if (pressed.dialog === undefined) {
      trace.push(pressed);
      continue;
    }
    // The same walk again, for the next path inside the dialog: the screen from
    // scratch, what it asked for where this control needed it, then this control.
    // Its result is thrown away — it is how the dialog gets back on the screen,
    // not a second reading of the press that opened it.
    const reopen = async (): Promise<void> => {
      await visit.reset();
      if (gave) await supply(visit.page);
      await press(visit, element, label);
    };
    trace.push({ ...pressed, inside: await insideDialog(visit, reopen) });
  }
  return trace;
}
