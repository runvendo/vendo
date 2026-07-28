/**
 * The checking layer: built-in fact checks plus whatever the host registered,
 * run in parallel over one app and flat-merged into a single finding list.
 *
 * A check is untrusted code (the host's, or a model call): one that throws
 * degrades to a `warn` naming it, so a broken check never takes the app down
 * with it.
 */
import { factChecks } from "./facts.js";
import type { Check, CheckInput, CheckingLayer, Finding } from "./types.js";
import type { GenerationDependencies } from "../generation/engine.js";

export interface CheckingLayerOptions {
  /** The host surface the fact checks measure against (catalog, tools, tool
   *  shapes). */
  deps: GenerationDependencies;
  /** Host-registered checks (AppsConfig.checks). APPENDED — they can add
   *  findings, never remove or replace a built-in. */
  checks?: readonly Check[];
}

const crashFinding = (check: Check, error: unknown): Finding => ({
  severity: "warn",
  where: check.name,
  message: `the check "${check.name}" failed to run (${error instanceof Error ? error.message : String(error)}), so whatever it would have found is missing from this report`,
});

export const createCheckingLayer = ({ deps, checks = [] }: CheckingLayerOptions): CheckingLayer => {
  const all = [...factChecks(deps), ...checks];
  return {
    checks: all,
    run: async (input: CheckInput): Promise<Finding[]> => {
      const results = await Promise.all(all.map(async (check) => {
        try {
          return await check.run(input);
        } catch (error) {
          return [crashFinding(check, error)];
        }
      }));
      return results.flat();
    },
  };
};
