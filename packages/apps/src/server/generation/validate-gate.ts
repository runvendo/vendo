/**
 * The builder's validate gate — blueprint §7.1 item 4: validate must pass before
 * the builder reports done.
 *
 * The `validate` verb was already registered, already on the claude-code harness's
 * surface (`toolSurface` withholds only `vendo_make`), and already taught by the
 * building-apps skill — "use it after every edit; it is faster and surer than
 * re-reading your own work". Whether the model actually called it was the model's
 * business. A builder that skipped it reported success over a broken app, and the
 * only thing that noticed was the paint seam declining to paint, which from the
 * model's side is silence.
 *
 * This closes it WITHOUT a second validate: the gate calls the same verb through
 * `turn.tools.call`, so it lands in the one guarded, audited, mirrored path like
 * any other tool call. There is no privileged side door and no second
 * implementation of the floor.
 *
 * `{ appId }` is the only door: a screen's mechanical half is the component
 * gauntlet, which already ran as its paint gate on the way in
 * (`AppFloor.component`), so what is left here is the judging pass over the
 * STORED screen.
 *
 * FAIL-OPEN, everywhere. A validate that could not run is not a finding: treating
 * it as one would spend the builder's fix round repairing an app nobody said was
 * broken, and could end a turn because a guard happened to be busy. Loud for the
 * operator, silent for the user.
 */
import {
  safeErrorMessage,
  type AppId,
  type TurnTools,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  type Finding,
} from "../../contract/index.js";
import { hotPathAppId } from "./render-seam.js";

/** The verb's name on the one registry (`@vendoai/vendo` `vendo-verbs.ts`). */
export const VALIDATE_TOOL = "validate";

/** One screen that did not pass, and why. */
export interface AppValidationFailure {
  /** The workspace path the screen was written to. */
  path: string;
  appId: AppId;
  /** Everything `validate` reported — warnings included. Only a `block` is what
   *  made this a failure, but the builder is told all of it. */
  findings: readonly Finding[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFinding = (value: unknown): value is Finding =>
  isRecord(value)
  && (value["severity"] === "block" || value["severity"] === "warn")
  && typeof value["message"] === "string";

/** An `app.tsx` path, or undefined for anything else. */
const appDocumentAt = (path: string): AppId | undefined =>
  path.endsWith(`/${SCREEN_FILE}`) ? hotPathAppId(path) : undefined;

/** One `validate` call, or undefined for every way it could not reach a verdict —
 *  each of which is reported to the OPERATOR and to nobody else. */
async function askValidate(
  tools: Pick<TurnTools, "call">,
  appId: AppId,
): Promise<readonly Finding[] | undefined> {
  const result = await tools.call(VALIDATE_TOOL, { appId });
  if (result.status !== "ok") {
    console.error(
      `[vendo] could not validate ${appId} before finishing the turn, so this app was not gated — `
      + (result.status === "denied" ? result.reason : result.error.message),
    );
    return undefined;
  }
  const output = result.output;
  if (!isRecord(output) || typeof output["ok"] !== "boolean") {
    console.error(`[vendo] validate answered in a shape the gate cannot read, so ${appId} was not gated`);
    return undefined;
  }
  // A WARN IS A REPAIR TOO — read exactly like `judgeScreen` (screen-agent.ts)
  // reads the same tool's answer. `ok` is only "no blocker"; a screen the
  // reviewer graded `warn` (a host's own design rule, an ask rule) still has
  // findings, and a caller of this gate — a host's own harness, `validateApps`
  // in `HarnessAdapters` — must see everything the built-in loop already acts
  // on, or it is fixing less than the loop is.
  return Array.isArray(output["findings"]) ? output["findings"].filter(isFinding) : [];
}

/**
 * Run `validate` over every screen among `paths` and report the ones that did not
 * pass.
 *
 * An empty answer means "nothing to repair" — which includes every case where the
 * gate could not reach a verdict.
 */
export async function validateWrittenApps(input: {
  /** The turn's tools. The `validate` verb is on every composed surface. */
  tools: Pick<TurnTools, "call">;
  /** The paths this turn wrote, as a sync reports them. Non-app paths are ignored,
   *  so a caller can hand over everything it changed. */
  paths: readonly string[];
  /**
   * ALSO face the AI reviewer — the mandatory pass, for a caller standing at the
   * end of a finished screen rather than mid-write.
   *
   * The reviewer is the only check that can see invented data, a dishonest tool
   * use, or a headline that contradicts its own rows, and until now it ran only
   * when the writing model chose to call `validate({appId})`. A bills dashboard
   * double-counted two overlapping queries into an $11,216 headline over ~$6,276 of
   * real bills (demo-bank, 2026-08-06); every mechanical check passed and the one
   * check that could have caught it was never asked.
   *
   * It runs on `validate({appId})`, which composes the gauntlet and the reviewer
   * with the app's own query results behind it — and only on a screen that
   * already PAINTED, because a row-scoped door has nothing to find otherwise. So
   * the reviewer is spent exactly once, on exactly the screens a person is about
   * to keep, and this flag is what gates a screen's whole trip through the verb.
   */
  review?: boolean;
}): Promise<AppValidationFailure[]> {
  const failures: AppValidationFailure[] = [];
  for (const path of input.paths) {
    const appId = appDocumentAt(path);
    if (appId === undefined || input.review !== true) continue;
    try {
      const judged = await askValidate(input.tools, appId);
      if (judged !== undefined && judged.length > 0) failures.push({ path, appId, findings: judged });
    } catch (error) {
      console.error(
        `[vendo] the validate gate could not judge ${path}, so ${appId} was not gated — ${safeErrorMessage(error)}`,
      );
    }
  }
  return failures;
}

/**
 * The failures as one instruction a builder can act on, or undefined when there is
 * nothing to fix — so a clean turn costs no extra round.
 *
 * The findings go over VERBATIM. A finding's message is already a teaching sentence
 * that names the real alternative ("the real fields are: …"), written to be
 * repaired from; rewriting it here would only lose the part that teaches.
 */
export function repairInstruction(failures: readonly AppValidationFailure[]): string | undefined {
  if (failures.length === 0) return undefined;
  const lines = failures.map(({ path, findings }) => [
    `${path}:`,
    ...findings.map(({ where, message }) => (where === undefined ? `  - ${message}` : `  - ${where} ${message}`)),
  ].join("\n"));
  return [
    "Before this turn can finish: `validate` does not pass on the screen(s) you wrote.",
    "Fix each of these, then write the file again. Change nothing else.",
    "",
    ...lines,
  ].join("\n");
}
