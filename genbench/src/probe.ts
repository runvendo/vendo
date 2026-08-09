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

export interface Fired {
  readonly name: string;
  readonly args: unknown;
}

export interface Probed {
  readonly label: string;
  /** A `[role=dialog]` stood between the press and the call, and was confirmed. */
  readonly confirmed: boolean;
  readonly calls: readonly Fired[];
}

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
    await element.click({ timeout: CLICK_MS }).catch(() => undefined);

    const dialog = visit.page.locator("[role=dialog]").first();
    const confirmed = await dialog.isVisible().catch(() => false);
    if (confirmed) {
      // The primary action sits last in a confirmation; everything before it is a
      // way out, and taking one of those would record the press as firing nothing.
      await dialog.locator(ACTIONABLE).last().click({ timeout: CLICK_MS }).catch(() => undefined);
    }

    const calls = await visit.page.evaluate(() => window.vendo.calls);
    trace.push({ label: (text || aria || "").trim() || `control ${index + 1}`, confirmed, calls });
  }
  return trace;
}
