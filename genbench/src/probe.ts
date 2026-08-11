import type { Page } from "@playwright/test";
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

/** Everything a person can press. A disabled control is not actionable, so it is
 *  not a candidate — grading it would fail a screen for being careful. */
const ACTIONABLE = "button:not([disabled]), [role=button]:not([aria-disabled=true]), a[href]";

/** A press that never lands says "fired nothing", which is the verdict either
 *  way; this only stops one stuck control from spending the case's whole budget. */
const CLICK_MS = 5_000;

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

export interface Fired {
  readonly name: string;
  readonly args: unknown;
}

export interface Probed {
  readonly label: string;
  /** A `[role=dialog]` stood between the press and the call, and was confirmed. */
  readonly confirmed: boolean;
  /** The press visibly moved the screen — a dialog opened, a tab switched, a row
   *  was dismissed. What tells a control that only changes local state apart from
   *  one that is dead, since neither asks the host for anything. */
  readonly changed: boolean;
  readonly calls: readonly Fired[];
}

/** What the screen is, in the three cheapest numbers that answer "did that press
 *  do anything": what it has asked the host for, how much text it is showing, and
 *  how many elements are showing it.
 *
 *  One reader for both sides of a press, so what the wait below watched for and
 *  what the trace records can never disagree about what changed. */
interface Look {
  readonly calls: readonly Fired[];
  readonly text: number;
  readonly elements: number;
}

/** Nothing evaluated in the page may be a NAMED function: tsx compiles this file
 *  with esbuild's keepNames, which wraps one in a `__name` helper that exists in
 *  node and not in the page — see the longer note in `render.ts`. */
const look = async (page: Page): Promise<Look> =>
  await page.evaluate(() => ({
    calls: window.vendo.calls,
    text: document.body.innerText.length,
    elements: document.querySelectorAll("*").length,
  }));

/** The wait a press earns: until it asks the host for something it had not asked
 *  for, or until the screen it is on is no longer the screen it was pressed on.
 *  A press that does neither spends the whole bound and is read as it stands,
 *  which is the honest verdict for a dead control. */
const settle = async (page: Page, before: Look): Promise<void> => {
  const was = { calls: before.calls.length, text: before.text, elements: before.elements };
  await page
    .waitForFunction(
      (mark: typeof was) =>
        window.vendo.calls.length > mark.calls
        || document.body.innerText.length !== mark.text
        || document.querySelectorAll("*").length !== mark.elements,
      was,
      { timeout: EFFECT_MS },
    )
    .catch(() => undefined);
};

export async function probe(visit: Visit): Promise<Probed[]> {
  const trace: Probed[] = [];
  const candidates = await visit.page.locator(ACTIONABLE).count();
  for (let index = 0; index < candidates; index += 1) {
    // The shot was taken on a page nobody had touched yet, so the first candidate
    // already has its fresh screen and only the later ones need one.
    if (index > 0) await visit.reset();
    const element = visit.page.locator(ACTIONABLE).nth(index);
    const text = await element.innerText().catch(() => "");
    const aria = await element.getAttribute("aria-label").catch(() => null);
    const before = await look(visit.page);
    await element.click({ timeout: CLICK_MS }).catch(() => undefined);
    await settle(visit.page, before);

    // Read after the press has landed, so a confirmation the runtime paints a
    // frame late is still a confirmation and not a control that did nothing.
    const dialog = visit.page.locator("[role=dialog]").first();
    const confirmed = await dialog.isVisible().catch(() => false);
    if (confirmed) {
      // Measured from the screen WITH the dialog on it, not from before the
      // press: the dialog opening already moved the page, so a wait against the
      // earlier state would be satisfied before the confirm had done anything.
      const opened = await look(visit.page);
      // The primary action sits last in a confirmation; everything before it is a
      // way out, and taking one of those would record the press as firing nothing.
      await dialog.locator(ACTIONABLE).last().click({ timeout: CLICK_MS }).catch(() => undefined);
      await settle(visit.page, opened);
    }

    const after = await look(visit.page);
    trace.push({
      label: (text || aria || "").trim() || `control ${index + 1}`,
      confirmed,
      changed: after.text !== before.text || after.elements !== before.elements,
      calls: after.calls,
    });
  }
  return trace;
}
