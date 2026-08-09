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
 * `{ document }`, not `{ appId }`, deliberately. A file that did not pass has no
 * store row — the seam refuses to author an app it would not paint — so `appId`
 * would answer not-found on exactly the case the gate exists for. The wire text is
 * what was written, and it is what `validate` was built to check "before committing
 * it".
 *
 * FAIL-OPEN, everywhere. A validate that could not run is not a finding: treating
 * it as one would spend the builder's fix round repairing an app nobody said was
 * broken, and could end a turn because a guard happened to be busy. Loud for the
 * operator, silent for the user.
 */
import { safeErrorMessage, type AppId, type Finding, type TurnTools, type WorkspaceFs } from "@vendoai/core";
import { hotPathAppId } from "./render-seam.js";

/** The verb's name on the one registry (`@vendoai/vendo` `vendo-verbs.ts`). */
export const VALIDATE_TOOL = "validate";

/** One app document that did not pass, and why. */
export interface AppValidationFailure {
  /** The workspace path the document was read back from. */
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

/** An `app.vendo` path, or undefined for anything else. A `plan.vendo` is a
 *  skeleton rather than an app document — there is nothing to validate yet. */
const appDocumentAt = (path: string): AppId | undefined =>
  path.endsWith("/app.vendo") ? hotPathAppId(path) : undefined;

/** One `validate` call, or undefined for every way it could not reach a verdict —
 *  each of which is reported to the OPERATOR and to nobody else. */
async function askValidate(
  tools: Pick<TurnTools, "call">,
  appId: AppId,
  args: { document: string } | { appId: AppId },
): Promise<readonly Finding[] | undefined> {
  const result = await tools.call(VALIDATE_TOOL, args);
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
  if (output["ok"]) return [];
  return Array.isArray(output["findings"]) ? output["findings"].filter(isFinding) : [];
}

/**
 * Run `validate` over every app document among `paths` and report the ones that did
 * not pass.
 *
 * An empty answer means "nothing to repair" — which includes every case where the
 * gate could not reach a verdict.
 */
export async function validateWrittenApps(input: {
  /** The turn's tools. The `validate` verb is on every composed surface. */
  tools: Pick<TurnTools, "call">;
  /** Read back what LANDED, rather than trusting a remembered argument — the same
   *  reason the render seam re-reads before it paints. */
  workspace: Pick<WorkspaceFs, "readFile">;
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
   * It runs on the SECOND door — `validate({appId})`, which composes the floor and
   * the reviewer with the app's own query results behind it — and only on a
   * document that already passed the mechanical half, for two reasons: a screen
   * that does not pass the floor is not a finished screen, and a document that
   * never painted has no row for the row-scoped door to find. So the reviewer is
   * spent exactly once, on exactly the screens a person is about to keep.
   */
  review?: boolean;
}): Promise<AppValidationFailure[]> {
  const failures: AppValidationFailure[] = [];
  for (const path of input.paths) {
    const appId = appDocumentAt(path);
    if (appId === undefined) continue;
    try {
      const document = await input.workspace.readFile(path);
      const mechanical = await askValidate(input.tools, appId, { document });
      if (mechanical === undefined) continue;
      if (mechanical.length > 0) {
        failures.push({ path, appId, findings: mechanical });
        continue;
      }
      if (input.review !== true) continue;
      const judged = await askValidate(input.tools, appId, { appId });
      if (judged !== undefined && judged.length > 0) failures.push({ path, appId, findings: judged });
    } catch (error) {
      console.error(
        `[vendo] the validate gate could not read ${path} back, so ${appId} was not gated — ${safeErrorMessage(error)}`,
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
    "Before this turn can finish: `validate` does not pass on the app document(s) you wrote.",
    "Fix each of these, then write the file again. Change nothing else.",
    "",
    ...lines,
  ].join("\n");
}
