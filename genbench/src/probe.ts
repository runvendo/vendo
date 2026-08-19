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
 *
 * A `<select>` is one of them as of 2026-08-18, on top of being the precondition
 * `supply` satisfies below. "Pick a value and it saves" — `onChange` calling the
 * tool, with no button beside it — is a real screen, and a whole world's worth of
 * them recorded `pressed: 0` and failed for having nothing to press. It is the one
 * species whose press is not a click: see `intent`. `[role=listbox]` and
 * `[role=combobox]` stay out — a listbox is the CONTAINER of the options a person
 * picks, so pressing it fires nothing and moves nothing and would invent exactly
 * the dead control this fixes, and a combobox trigger is a `button` already.
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
  "select",
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
 *
 * A NUMBER box is one of them as of 2026-08-18, and it was the one box the probe
 * could not see. "Priority, assignee, estimate — and file it" is a form with one
 * field that is not text: the required estimate stayed empty, so the submit it
 * guards never unlocked, and `project-tracker/file-bug` recorded two choices and no
 * press that asked the host for anything. It is answered with a digit rather than
 * the string every other box gets — see `TYPED_NUMBER`.
 */
const ENTRY = ["input[type=text]", "input[type=number]", "input:not([type])", "textarea"]
  .map((field) => `${field}:not([disabled]):not([readonly])`)
  .join(", ");

/** One fixed string, never a random or a clock-shaped one: two runs of the same
 *  screen must type the same thing, and what the harness typed has to be
 *  recognisable as the harness's wherever the trace is read. */
const TYPED = "probe input";

/** And what a NUMBER box is answered with, because `TYPED` is not a number and a
 *  number box will not hold it: the letters land nowhere, the box stays empty, and
 *  the submit it guards stays locked — which is the failure that adding the box to
 *  `ENTRY` at all would otherwise have shipped unchanged. One fixed digit, for
 *  `TYPED`'s reason, and a plausible answer to whatever the field is asking for. */
const TYPED_NUMBER = "3";

/** What "switched on" looks like whoever drew the control — `aria-checked` where
 *  the page paints its own toggle, `:checked` where it uses the browser's. */
const ON = "[aria-checked=true], :checked";

/** Every chooser on the page, shown or not hidden from assistive tech — the same
 *  filter every other species gets. A `<select>` has no "on" state to count, so
 *  it needs its own read: see `Look.chosen` below. */
const SELECTS = `select${SHOWN}`;

/** Joins the values `Look.chosen` reads off every select into one string. Not a
 *  character any option value would hold, so two selects' worth of values never
 *  read as one long one that happens to match. */
const CHOSEN_SEP = String.fromCharCode(0);

/**
 * What a control ALREADY BEING the one showing looks like, on the control itself:
 * the selected tab, the item marked as where you are, the radio already on.
 *
 * Pressing one of these calls nothing and moves nothing BY DESIGN — that is
 * idempotence, not deadness — and the floor read it as a dead control, so the
 * screens that had it right were the ones convicted: the tab a `price-book` screen
 * opens on, in two columns of one run. A checkbox and a switch are deliberately
 * absent, because pressing one FLIPS it and is never a no-op. `aria-current="false"`
 * is the spelling for "not the current one", so it says what it means here too.
 */
const ALREADY =
  "[aria-selected=true], [aria-current]:not([aria-current=false]), [role=radio][aria-checked=true], input[type=radio]:checked";

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

/** The same bound on what a press REVEALED in words, for the same reason: enough
 *  of it to tell a tab that paints its category from one that lights itself up,
 *  and not so much that one press of a long table becomes the whole trace. */
const SHOWED_CHARS = 500;

export interface Fired {
  readonly name: string;
  readonly args: unknown;
  /** What the HOST did with this call, on the entry it did it to (`seam` in
   *  `render.ts`): a write is parked — `pending-approval` — and then approved a
   *  microtask later, so a guarded write is one round trip and never two presses.
   *  Absent on a read, which is answered on the spot, and on a call recorded by a
   *  page that brought its own recorder. */
  readonly status?: "ok" | "pending-approval";
  /** The id the ask and the approval are tied together by, present exactly when
   *  the host parked this call. */
  readonly approvalId?: string;
}

/** One field the HARNESS answered for the screen, and what it put there. */
export interface Filled {
  readonly field: string;
  readonly value: string;
}

/**
 * One chooser the HARNESS answered for the screen, and the option it picked — in
 * the words that option SHOWS, because those are the words a screen echoes back.
 *
 * A typed value has said `filled: [...]` since the day the probe started typing,
 * and a CHOSEN one said nothing at all, so a confirmation quoting the harness's own
 * pick read as the screen inventing a target: `project-tracker/sprint-board` lost
 * the honesty line to "CAI-153 will move to \"Backlog\"" — Backlog being the option
 * the probe had chosen one line earlier, in a trace that never mentioned it.
 */
export interface Chosen {
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
  /** The visible text of a `[role=dialog]` THIS press opened, and every control
   *  inside it — the same two fields as on a press at the top level, read the same
   *  way (2026-08-18). Carried only by a press inside a REVEAL, where the flow's
   *  last step is a confirmation: `insideDialog` strips both from the paths it
   *  returns, so the nesting the types permit is one level and the walk stops
   *  there. See `insideReveal`. */
  readonly dialog?: string;
  readonly inside?: readonly Path[];
  /** Present exactly when this press was a CHOICE — a chooser is pressed by
   *  choosing, inside a walk as much as outside one, and a call carrying the
   *  harness's pick has to say whose pick it was wherever it is read. */
  readonly chose?: readonly Chosen[];
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
  /**
   * Every control this press put on the screen that was not on it before, pressed
   * once each, in the order a person meets them (2026-08-18).
   *
   * A second step does not need a dialog to live in. "Click Open → a status picker
   * and a Save button appear in the page" is the same shape as a confirmation and
   * was recorded as `effect: "state"` and nothing else, so the controls that do the
   * work went unpressed and the action went unproven: `project-tracker`'s
   * `capacity-rebalance` and `my-issues-inbox` failed `actionProven` in the columns
   * that had them right, with the write one press past where the evidence stopped.
   *
   * The walk is the one the reveal itself asks for: the new controls are pressed in
   * document order on the page the opening press left standing, because a picker and
   * the Save beside it are one step and not two ways out of the same question.
   * Absent where a press revealed nothing, or where nothing it revealed could be
   * pressed.
   *
   * A revealed press that opens a DIALOG carries that dialog and its own walk, so
   * the depth here is reveal then dialog and stops: `insideDialog` walks no dialog a
   * press inside a dialog opened, which is the same bound `inside` has always had.
   */
  readonly revealed?: readonly Path[];
  /** The fields the harness filled to get this press, and with what. Present
   *  exactly when it filled any: the screen did not have this data, so every
   *  reader of the trace — the judge included — is told where it came from before
   *  it grades a call that carries it. */
  readonly filled?: readonly Filled[];
  /** The choosers the harness answered to get this press, and with what — the
   *  precondition pass's, and the press's own where the control pressed was a
   *  chooser. Present exactly when it chose any, and on the trace for `filled`'s
   *  reason: a screen echoing the harness's pick back is not a screen inventing
   *  one. */
  readonly chose?: readonly Chosen[];
  /** The press visibly moved the screen — a dialog opened, a tab switched, a row
   *  was dismissed, a toggle flipped. What tells a control that only changes local
   *  state apart from one that is dead, since neither asks the host for anything. */
  readonly changed: boolean;
  /**
   * What the press put on the screen IN WORDS, bounded (2026-08-18).
   *
   * `revealed` above is the CONTROLS a press put there; this is what it SAYS. The
   * probe recorded the first and not the second, so a tab that paints a whole
   * category of rows and a tab that only lights itself up were the same entry —
   * `changed: true`, and nothing about what changed. The judge, which reads this
   * trace and not the screen mid-press, called the working one broken:
   * `trades-accounting/price-book` lost three correctness lines to "the HVAC and
   * Electrical tabs are inert per the trace", against a trace saying `changed:
   * true` for both of them.
   *
   * Present only where the record was otherwise BLIND — the press moved the screen,
   * asked the host for nothing, and opened no dialog. A press that called something
   * already says what it did, a dialog already carries its own words, and a press
   * that moved nothing has nothing to show.
   */
  readonly showed?: string;
  /** The press was a CHOICE the chooser never took (2026-08-18). The harness never
   *  got to ask the question, so nothing about this control was tested — see
   *  `choose`. Present exactly when a chooser's value had not moved after a retry;
   *  the floor grades it as neither earned nor missed, as it does `alreadyActive`,
   *  and without it a dropped choice read as a dead control. */
  readonly choiceDropped?: true;
  /** The control was ALREADY the one showing when it was pressed (`ALREADY`), so
   *  calling nothing and moving nothing is what it is supposed to do. Present
   *  exactly when it was: the floor grades such a press as neither earned nor
   *  missed, and without this it read it as a dead control. */
  readonly alreadyActive?: true;
  readonly calls: readonly Fired[];
}

/** What the screen is, in the cheapest readings that answer "did that press do
 *  anything": what it has asked the host for, how much text it is showing, how
 *  many elements are showing it, how many of its controls are on, how many are
 *  pressable, and which option every chooser currently holds.
 *
 *  One reader for both sides of a press, so what the wait below watched for and
 *  what the trace records can never disagree about what changed. */
interface Look {
  readonly calls: readonly Fired[];
  /** Everything the screen is showing, in the words a person reads. Compared by
   *  LENGTH for "did that press do anything" — which is all the wait below can
   *  afford to poll — and read line by line for `showedBy`, which is what the
   *  press put there. */
  readonly body: string;
  readonly elements: number;
  /** How many of the screen's controls are switched on. A toggle that flips
   *  changes neither the text nor the element count, so by those two alone a
   *  switch a person can see move was a control that did nothing — the false
   *  failure that pressing toggles at all would otherwise have invented. */
  readonly on: number;
  /** How many of the screen's controls a person could press right now. Unlocking
   *  the button beside a chooser moves none of the three numbers above, so by
   *  those alone the choice that opens "Pick a category, then Save cap" did
   *  nothing — the same false failure one turn on, and the one pressing choosers
   *  at all would otherwise have invented (2026-08-18). */
  readonly live: number;
  /** Every `<select>` on the page's current value, joined in document order. A
   *  chooser moving from "Open" to "Closed" changes none of the four readings
   *  above whenever the two labels happen to share a length — count, elements and
   *  `on` are untouched by a value changing at all, and `text` compares a LENGTH
   *  rather than the letters in it — so a screen that saves on choice, with
   *  nothing else on the page moving, read as a control that did nothing
   *  (2026-08-18, `project-tracker/file-bug` and `trades-accounting/log-job-expense`).
   *  A separator no option value contains keeps two selects' worth of values from
   *  reading as one long one that happens to match. */
  readonly chosen: string;
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
    (what: { on: string; live: string; selects: string; sep: string }) => ({
      calls: window.vendo?.calls ?? [],
      body: document.body.innerText,
      elements: document.querySelectorAll("*").length,
      on: document.querySelectorAll(what.on).length,
      live: document.querySelectorAll(what.live).length,
      chosen: [...document.querySelectorAll<HTMLSelectElement>(what.selects)].map((select) => select.value).join(what.sep),
    }),
    { on: ON, live: ACTIONABLE, selects: SELECTS, sep: CHOSEN_SEP },
  );

/** The wait a press earns: until it asks the host for something it had not asked
 *  for, or until the screen it is on is no longer the screen it was pressed on.
 *  A press that does neither spends the whole bound and is read as it stands,
 *  which is the honest verdict for a dead control. */
const settle = async (page: Page, before: Look): Promise<void> => {
  // The selectors ride along rather than being spelled a second time here: this
  // wait and the reading above have to agree about what "on" and "live" mean.
  const was = {
    calls: before.calls.length,
    text: before.body.length,
    elements: before.elements,
    on: before.on,
    live: before.live,
    chosen: before.chosen,
    onSelector: ON,
    liveSelector: ACTIONABLE,
    selectSelector: SELECTS,
    sep: CHOSEN_SEP,
  };
  await page
    .waitForFunction(
      (mark: typeof was) =>
        window.vendo.calls.length > mark.calls
        || document.body.innerText.length !== mark.text
        || document.querySelectorAll("*").length !== mark.elements
        || document.querySelectorAll(mark.onSelector).length !== mark.on
        || document.querySelectorAll(mark.liveSelector).length !== mark.live
        || [...document.querySelectorAll<HTMLSelectElement>(mark.selectSelector)]
            .map((select) => select.value)
            .join(mark.sep) !== mark.chosen,
      was,
      { timeout: EFFECT_MS },
    )
    .catch(() => undefined);
};

/**
 * Every control on the screen right now, each as the one string that identifies it
 * across a re-paint: what it is, what role it answers to, how it is labelled, and
 * what it says.
 *
 * Read on both sides of a press, because the difference is what that press
 * REVEALED. `textContent` rather than `innerText`, so identity does not move with
 * layout: a control the press merely re-rendered keeps its signature and is
 * correctly not new, which is what keeps a page that rebuilds its whole body on
 * every press from reading as a page where every control just appeared.
 */
const controlsOn = async (page: Page): Promise<string[]> =>
  await page
    .evaluate(
      (species: string) =>
        [...document.querySelectorAll(species)].map(
          (node) =>
            `${node.tagName}/${node.getAttribute("role") ?? ""}/${node.getAttribute("aria-label") ?? ""}/${node.textContent?.trim() ?? ""}`,
        ),
      CONTROLS,
    )
    .catch(() => []);

/**
 * What a press put on the screen in WORDS: the lines that are showing now and
 * were not showing before, bounded (2026-08-18).
 *
 * By LINE, because `innerText` already breaks a screen into the blocks a person
 * reads it in, and because a line that was on the screen before is not new however
 * far it moved — so a press that only re-orders a table shows nothing, and a press
 * that swaps a panel's whole contents shows the new panel. Trimmed on both sides
 * for the same reason `controlsOn` uses `textContent`: identity must not move with
 * layout.
 *
 * `undefined` where the press showed nothing new, which is what keeps the field off
 * a press that has nothing to say.
 */
const showedBy = (before: string, after: string): string | undefined => {
  const had = new Set(before.split("\n").map((line) => line.trim()));
  const fresh = after
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !had.has(line));
  return fresh.length === 0 ? undefined : fresh.join(" · ").slice(0, SHOWED_CHARS);
};

/** Which of the controls on the screen now were not on it before, as indices into
 *  `CONTROLS` in document order on the page as the press left it. A signature that
 *  was already there is not new however many copies of it there are now: this would
 *  rather miss a second "Save" than walk a control that was always on the screen. */
const appearedIn = (before: readonly string[], after: readonly string[]): number[] =>
  after.flatMap((control, index) => (before.includes(control) ? [] : [index]));

/** What the harness answered for the screen in one precondition pass: the choosers
 *  it set and the boxes it filled, each in the words the trace reports them by. */
interface Given {
  readonly chose: readonly Chosen[];
  readonly filled: readonly Filled[];
}

/**
 * A chooser answered, and CHECKED — because a `selectOption` that never landed is
 * silent (2026-08-18).
 *
 * Playwright will not set a control until it is visible, enabled and STILL, and on
 * a loaded machine a screen that is a frame from settling can spend that whole
 * bound without ever taking the choice. Nothing throws that the caller sees: the
 * failure is swallowed like every other press's, and the trace then reports a
 * choice the page was never given — with `changed: false` beside it, because
 * nothing moved. That is a dead control by every reading the floor has, and it is
 * the only floor failure in the 2026-08-18T21-39-10 sweep: the FIRST of
 * `project-tracker/open-issues`'s two choosers, on a screen that is correctly
 * wired, whose second chooser took its value fine one reload later.
 *
 * So the value is read back, and a choice that did not land is made once more
 * before it is believed. Once, not until it works: a probe that retries without a
 * bound returns a verdict that depends on how long it tried. `false` is the harness
 * saying it never got to ask the question — never the screen answering it.
 */
const choose = async (chooser: Locator, value: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await chooser.selectOption(value, { timeout: CLICK_MS }).catch(() => undefined);
    const now = await chooser.evaluate((node: HTMLSelectElement) => node.value).catch(() => undefined);
    if (now === value) return true;
  }
  return false;
};

/**
 * Everything the screen is asking for, given once, in document order: every
 * chooser still on its placeholder set to its first REAL option, then every empty
 * field answered.
 *
 * Option zero is usually the placeholder — "Assign to…", value `""` — which is
 * the exact state the control was guarded against, so it is skipped. One pass and
 * no second guess: nothing here hunts for the combination that unlocks a screen,
 * because a probe that hunts returns a verdict that depends on how long it hunted.
 *
 * What it TYPED comes back, to go on the press it enabled. Only an empty box, and
 * as of 2026-08-18 only an unanswered chooser, because those are the same case: a
 * value the screen is already showing is the screen's OWN, the shot everybody
 * grades shows it, and overwriting it sends the tool something no screen ever
 * displayed — a mismatch the judge reads as the screen's bug. It set every select
 * on the page, so a form defaulting priority to `high` showed `high` and sent
 * `urgent`, and was convicted for the harness's edit.
 */
const supply = async (page: Page): Promise<Given> => {
  const choosers = page.locator(CHOICE);
  const many = await choosers.count();
  const chose: Chosen[] = [];
  for (let index = 0; index < many; index += 1) {
    const chooser = choosers.nth(index);
    const option = await chooser
      .evaluate((node: HTMLSelectElement) => {
        if (node.value !== "") return undefined;
        const first = [...node.options].find((choice) => choice.value !== "" && !choice.disabled);
        return first === undefined ? undefined : { value: first.value, text: first.text };
      })
      .catch(() => undefined);
    if (option === undefined) continue;
    // Named BEFORE the choice, because a chooser's name is the option it is
    // SHOWING: read after, it would report the harness's own pick as the field
    // that pick went into.
    const field = await nameOf(chooser, index);
    // Reported only if it LANDED: a precondition the screen never received is not
    // one the trace may tell the judge about.
    if (await choose(chooser, option.value)) chose.push({ field, value: option.text });
  }
  // Visible only: a field the screen is not showing is not one it is asking for,
  // and waiting out the bound on each of them would spend the case's budget.
  const fields = page.locator(ENTRY).filter({ visible: true });
  const asked = await fields.count();
  const filled: Filled[] = [];
  for (let index = 0; index < asked; index += 1) {
    const field = fields.nth(index);
    // Whether the box is empty and what KIND of box it is, in one reading: a number
    // box takes a different answer, and asking twice is a second round trip for
    // something the first one was already looking at.
    const box = await field
      .evaluate((node: HTMLInputElement | HTMLTextAreaElement) => ({ empty: node.value === "", number: node.type === "number" }))
      .catch(() => undefined);
    if (box === undefined || !box.empty) continue;
    const value = box.number ? TYPED_NUMBER : TYPED;
    // Filled, then LEFT: `input` is what a keystroke fires and `change` is what
    // leaving the box fires, and a screen may gate on either one.
    await field
      .fill(value, { timeout: CLICK_MS })
      .then(() => field.blur())
      .catch(() => undefined);
    filled.push({ field: await nameOf(field, index), value });
  }
  return { chose, filled };
};

/** What a control is called, in the words a person reads off it — or, for a box
 *  with no words of its own, the hint written inside it. A chooser's own words are
 *  every option it holds; what a person reads off it is the one it is SHOWING, so
 *  that is its name and the six-line blob `innerText` returns is not. */
const nameOf = async (element: Locator, index: number): Promise<string> => {
  const showing = await element
    .evaluate((node: Element) => (node instanceof HTMLSelectElement ? (node.selectedOptions[0]?.text ?? "") : undefined))
    .catch(() => undefined);
  const text = showing ?? (await element.innerText().catch(() => ""));
  const aria = await element.getAttribute("aria-label").catch(() => null);
  const hint = await element.getAttribute("placeholder").catch(() => null);
  return (text || aria || hint || "").trim() || `control ${index + 1}`;
};

/**
 * What pressing this control MEANS, read off the element itself — before the
 * press, because the press is what changes both answers.
 *
 * `option` — a chooser is pressed by CHOOSING, and this is what it would choose:
 * the first real option that is not the one already showing. Re-choosing the
 * option a `<select>` is already on fires no `change` at all, so a screen that
 * saves on choice would read as a dead control; and the placeholder is no more a
 * choice here than it is in `supply`. Its `value` is what the choice is made with
 * and its `text` is what goes on the trace, because the words are what a screen
 * echoes and a `value` of `backlog` beside a confirmation reading "Backlog" is a
 * connection the judge should not have to make.
 *
 * `already` — pressing it could only repeat what the screen already shows
 * (`ALREADY`), a chooser with no option but the one it is on included.
 */
const intent = async (element: Locator): Promise<{ option?: { value: string; text: string }; already: boolean }> =>
  await element
    .evaluate((node: Element, already: string) => {
      if (!(node instanceof HTMLSelectElement)) return { already: node.matches(already) };
      const option = [...node.options].find((choice) => choice.value !== "" && !choice.disabled && !choice.selected);
      return option === undefined ? { already: true } : { option: { value: option.value, text: option.text }, already: false };
    }, ALREADY)
    .catch(() => ({ already: false }));

/**
 * Every confirmation standing on the screen right now, in the words a person
 * reads off it.
 *
 * Read on BOTH sides of a press, because a dialog that was already up is not this
 * press's. `reset()` re-paints the page inside the SAME script world, so the
 * previous document's still-live runtime can portal a toast it opened into the
 * fresh body a beat later — and the press that happens to follow was credited
 * with it. `buildlog/build-detail` lost "offers exactly one control to run it
 * again" that way: "View lint log" was recorded as opening "Build queued to run
 * again.", the retry toast from three presses earlier, and the judge correctly
 * read that as a second control that reruns the build.
 *
 * All of them rather than the first, so which one a press opened does not depend
 * on where in the document a lingering one landed — a portalled toast goes to the
 * end of the body, past the dialog the screen itself mounts. `allInnerTexts`
 * waits for nothing, which is what every press that opens no dialog needs.
 */
const dialogsOn = async (page: Page): Promise<string[]> =>
  await page
    .locator("[role=dialog]")
    .filter({ visible: true })
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.trim().slice(0, DIALOG_CHARS)))
    .catch(() => []);

/** One press, and the one thing about it a caller has to act on beyond the record:
 *  where the controls it REVEALED are, as indices into `CONTROLS` on the page the
 *  press left standing. Empty for the press that navigated away, which left no
 *  screen to compare. */
interface Pressed {
  readonly probed: Probed;
  readonly appeared: readonly number[];
}

/**
 * One press, read the same way whichever side of a dialog's edge it is on.
 *
 * A press inside a confirmation is a press: it lands late for the same reason,
 * it asks the host through the same recorder, and it moves the screen the same
 * way. Written once so the two can never be graded by different rules.
 */
const press = async (visit: Visit, element: Locator, label: string): Promise<Pressed> => {
  // Read BEFORE the click, and after any precondition: what a choice moved on
  // the screen belongs to the choice, and crediting it to the press would let a
  // chooser make a dead button look like a live one.
  const before = await look(visit.page);
  const stood = await dialogsOn(visit.page);
  const had = await controlsOn(visit.page);
  const { option, already } = await intent(element);
  // Every species is pressed by clicking, except the one that is pressed by
  // choosing. What it DID is read the same way for both — but only a choice can
  // be checked afterwards, so only a choice knows whether it landed.
  let dropped = false;
  if (option === undefined) await element.click({ timeout: CLICK_MS }).catch(() => undefined);
  else dropped = !(await choose(element, option.value));
  await settle(visit.page, before);

  // Read after the press has landed, so a confirmation the runtime paints a
  // frame late is still a confirmation and not a control that did nothing — and
  // credited to this press only if it was not already standing.
  const said = (await dialogsOn(visit.page)).find((text) => !stood.includes(text));

  // A press that navigated away — a link with an href — leaves no screen to
  // read: it went somewhere, which is the change, and it asked the host for
  // nothing on the way. The screen is put back for the next candidate rather
  // than the whole case being lost to one anchor.
  const after = await look(visit.page).catch(() => undefined);
  const appeared = after === undefined ? [] : appearedIn(had, await controlsOn(visit.page));
  if (after === undefined) await visit.reset();
  const changed =
    after === undefined
    || after.body.length !== before.body.length
    || after.elements !== before.elements
    || after.on !== before.on
    || after.live !== before.live
    || after.chosen !== before.chosen;
  // Only what THIS press asked for. The recorder is the page's, not the press's,
  // so handing over the whole array credited one load-time call to every control
  // on the screen and graded a dead button as wired.
  const calls = after?.calls.slice(before.calls.length) ?? [];
  // And what it SHOWED, recorded only where those two leave the record blind: the
  // press moved the screen, asked the host for nothing, and opened no dialog. Any
  // other press already says what it did.
  const showed =
    after !== undefined && changed && calls.length === 0 && said === undefined
      ? showedBy(before.body, after.body)
      : undefined;
  return {
    probed: {
      label,
      ...(said === undefined ? {} : { dialog: said }),
      ...(already ? { alreadyActive: true as const } : {}),
      ...(dropped ? { choiceDropped: true as const } : {}),
      // The harness's own pick, on the press it was made by, for the same reason a
      // fill is on the press it bought — and never a pick the chooser refused.
      ...(option === undefined || dropped ? {} : { chose: [{ field: label, value: option.text }] }),
      changed,
      ...(showed === undefined ? {} : { showed }),
      calls,
    },
    appeared,
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
    const { probed } = await press(visit, control, await nameOf(control, index));
    // The dialog's own words are on the press that opened it; an in-dialog press
    // that leaves it standing has not opened a second confirmation, so nothing
    // here carries one.
    paths.push({
      label: probed.label,
      changed: probed.changed,
      ...(probed.chose === undefined ? {} : { chose: probed.chose }),
      calls: probed.calls,
    });
  }
  return paths;
};

/**
 * Every control a press REVEALED, pressed in document order on the page that press
 * left standing (2026-08-18).
 *
 * The dialog walk one level out, for the second step that has no dialog to live in:
 * "press Open, and a status picker and a Save appear in the page" is the same shape
 * as a confirmation, and the probe walked into `[role=dialog]` and not into this —
 * so the controls that do the work went unpressed and the screens that had the
 * second step RIGHT were the ones that failed `actionProven`.
 *
 * In ORDER, on ONE page, which is where this parts company with the dialog walk and
 * has to: a dialog's controls are alternative ANSWERS to one question — press
 * "Confirm" and pressing "Cancel" afterwards means nothing — while a reveal's are
 * usually one FORM, and the Save at the end of it is locked until the picker before
 * it is answered. Isolating each path would have left every such Save disabled and
 * skipped, which is the failure this exists to fix. Document order is the order a
 * person meets them, it is one pass, and nothing here hunts for a combination.
 *
 * A control an earlier press in the sequence took off the screen is skipped rather
 * than pressed into thin air: a five-second click that lands on nothing would go on
 * the trace as a control that did nothing, which invents exactly the dead control
 * this walk exists to stop inventing.
 *
 * And the last step of the form is often a CONFIRMATION, so a press in here that
 * opens a dialog is walked exactly as one at the top level is (2026-08-18). The
 * probe stopped at the reveal's edge, and `project-tracker/capacity-rebalance`
 * failed `actionProven` with the whole flow right and the write one press further
 * in: "Hand off" revealed a picker and a Confirm, Confirm opened a Modal, and the
 * Modal's own button is what calls `assign_issue`. Reveal then dialog, and there it
 * stops — `insideDialog` never walks a dialog a press inside a dialog opened, so
 * the depth is two and cannot grow.
 *
 * `reopen` is the walk back to the reveal itself, handed in by the caller for
 * `insideDialog`'s reason: only the caller knows which control opened it. Getting
 * back to the DIALOG is that walk plus the presses in here that led to it, which is
 * why the sequence so far is kept.
 */
const insideReveal = async (visit: Visit, appeared: readonly number[], reopen: () => Promise<void>): Promise<Path[]> => {
  const controls = visit.page.locator(CONTROLS);
  const paths: Path[] = [];
  // The presses that got the screen here, in the order they were made. Replayed,
  // never re-read: this is how a dialog one of them opened gets back on the screen.
  // Read inside the same turn it is written, so the last entry is always this press.
  const walked: Array<{ index: number; label: string }> = [];
  for (const index of appeared) {
    const control = controls.nth(index);
    const live = control.and(visit.page.locator(ACTIONABLE)).filter({ visible: true });
    if ((await live.count()) === 0) continue;
    const label = await nameOf(control, index);
    const { probed } = await press(visit, control, label);
    walked.push({ index, label });
    paths.push({
      label: probed.label,
      changed: probed.changed,
      ...(probed.chose === undefined ? {} : { chose: probed.chose }),
      ...(probed.dialog === undefined
        ? {}
        : {
            dialog: probed.dialog,
            inside: await insideDialog(visit, async () => {
              await reopen();
              for (const step of walked) await press(visit, controls.nth(step.index), step.label);
            }),
          }),
      calls: probed.calls,
    });
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
    // And what the harness typed and chose to do it, which belongs on this press:
    // it is the part of the precondition the screen did not supply itself.
    let given: Given = { chose: [], filled: [] };
    if ((await live.count()) === 0) {
      if (!asks) continue;
      touched = true;
      given = await supply(visit.page);
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
    const { probed, appeared } = await press(visit, element, label);
    // The precondition's choices and the press's own are one list: both are the
    // harness's, and a reader asking where a value came from should not have to
    // know which turn of the probe supplied it.
    const chose = [...given.chose, ...(probed.chose ?? [])];
    const pressed = {
      ...probed,
      ...(given.filled.length === 0 ? {} : { filled: given.filled }),
      ...(chose.length === 0 ? {} : { chose }),
    };
    // The same walk again, for whichever second step this press opened: the screen
    // from scratch, what it asked for where this control needed it, then this
    // control. Its result is thrown away — it is how the screen gets back to where
    // the press left it, not a second reading of the press itself.
    const reopen = async (): Promise<void> => {
      await visit.reset();
      if (gave) await supply(visit.page);
      await press(visit, element, label);
    };
    if (probed.dialog !== undefined) {
      trace.push({ ...pressed, inside: await insideDialog(visit, reopen) });
      continue;
    }
    // A dialog and an inline reveal are never walked for the same press: a dialog's
    // controls ARE controls the press revealed, and walking them twice would press
    // each way out of a confirmation a second time under a name that says the
    // opposite about what isolation it got.
    const paths = appeared.length === 0 ? [] : await insideReveal(visit, appeared, reopen);
    trace.push(paths.length === 0 ? pressed : { ...pressed, revealed: paths });
  }
  return trace;
}
