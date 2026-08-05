/**
 * The checking floor: built-in fact checks plus whatever the host plugged in
 * through a pack, run in parallel over one app and flat-merged into a single
 * finding list.
 *
 * The floor is harness-independent on purpose — swap the harness and it does not
 * move. It also does not care whether whoever built the app reviewed its own
 * work: a plugged check fires either way.
 *
 * A check is untrusted code (the host's, a pack's, or a model call): one that
 * throws degrades to a `warn` naming it, so a broken check never takes the app
 * down with it.
 */
import type { FloorDependencies } from "./deps.js";
import { factChecks } from "./facts.js";
import type { Check, CheckInput, CheckingLayer, Finding } from "./types.js";

export interface CheckingLayerOptions {
  /** The host surface the fact checks measure against (catalog, tools, tool
   *  shapes). */
  deps: FloorDependencies;
  /** Checks plugged in by packs (`Pack.checks`, build contract §5). APPENDED —
   *  they can add findings, never remove or replace a built-in. */
  checks?: readonly Check[];
}

type FactCheck = Extract<Check, { run: unknown }>;

/** A judgment rule is the only thing the floor does NOT run. `kind` is optional
 *  on a fact check, so absence means "run it": a safety floor never opts a check
 *  out by omission. */
export const isJudgment = (check: Check): check is Extract<Check, { rule: string }> =>
  check.kind === "judgment";

/** The judgment rules over a set of checks, one sentence each, in registration
 *  order. Exported because the reviewer is handed exactly this list — the layer
 *  and the reviewer must never compute it two different ways. */
export const judgmentRules = (checks: readonly Check[]): string[] =>
  checks.flatMap((check) => (isJudgment(check) ? [check.rule] : []));

const isFinding = (value: unknown): value is Finding => {
  if (typeof value !== "object" || value === null) return false;
  const { severity, message, where } = value as Record<string, unknown>;
  if (severity !== "block" && severity !== "warn") return false;
  if (typeof message !== "string") return false;
  return where === undefined || typeof where === "string";
};

/** Stamp the check that produced a finding, OVERRIDING anything it wrote there.
 *  This is the one place that knows the answer for every check at once, and a
 *  check is untrusted code: self-assigned provenance is a finding attributing
 *  itself to a neighbour, which at a waive point is a privilege escalation. */
const from = (check: Check, finding: Finding): Finding => ({ ...finding, check: check.name });

const warnAbout = (check: Check, message: string): Finding => from(check, {
  severity: "warn",
  where: check.name,
  message,
});

const crashFinding = (check: Check, error: unknown): Finding => warnAbout(
  check,
  `the check "${check.name}" failed to run (${error instanceof Error ? error.message : String(error)}), so whatever it would have found is missing from this report`,
);

/**
 * What a check reported, kept to findings this floor can actually read.
 *
 * A check is untrusted code, and a malformed entry does not stop at the floor —
 * downstream readers interpolate `where` and filter on `severity`, so one
 * `undefined` in the array would kill the build the checks exist to protect.
 * Well-formed findings always survive: a real `block` is never lost to a bad
 * neighbour.
 *
 * It FILTERS rather than normalizes, deliberately. A finding carrying extra
 * properties passes through as authored: the shape is a floor, not a schema, and
 * stripping unknown fields would silently discard something a host's own check
 * meant to carry to its own reader. What matters is that the three fields every
 * consumer reads are the shapes it expects.
 */
const findingsOf = (check: Check, reported: unknown): Finding[] => {
  if (!Array.isArray(reported)) {
    return [warnAbout(check, `the check "${check.name}" did not report a list of findings, so whatever it would have found is missing from this report`)];
  }
  const findings = reported.filter(isFinding).map((finding) => from(check, finding));
  const dropped = reported.length - findings.length;
  return dropped === 0
    ? findings
    : [...findings, warnAbout(check, `the check "${check.name}" reported ${dropped} findings in a shape this floor cannot read, so whatever they said is missing from this report`)];
};

export const createCheckingLayer = ({ deps, checks = [] }: CheckingLayerOptions): CheckingLayer => {
  const all: Check[] = [...factChecks(deps), ...checks];
  const facts = all.filter((check): check is FactCheck => !isJudgment(check));
  return {
    checks: all,
    rubric: judgmentRules(all),
    run: async (input: CheckInput): Promise<Finding[]> => {
      const results = await Promise.all(facts.map(async (check) => {
        try {
          return findingsOf(check, await check.run(input));
        } catch (error) {
          return [crashFinding(check, error)];
        }
      }));
      return results.flat();
    },
  };
};
