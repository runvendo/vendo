/**
 * The checking layer's contract (generation pipeline rebuild, Task 3): one
 * plug-in shape for every kind of check the pipeline runs over a generated
 * app — the deterministic fact checks (facts.ts), the AI reviewer, and the
 * host's own checks (AppsConfig.checks). Findings are advice, not exceptions:
 * a check reports, it never throws the build away.
 */
import type { AppPlan } from "@vendoai/core";
import type { GeneratedAppDocument } from "../generation/engine.js";

/**
 * One thing wrong with a generated app. `message` is a TEACHING sentence: it
 * names what is wrong AND the real alternative ("…the real fields are: …"),
 * because its readers are a model repairing the app and a human reading the
 * refusal.
 *
 * `block` stops the app shipping as-is; `warn` rides along (the section-sized
 * failure, and every check that could not run).
 */
export interface Finding {
  severity: "block" | "warn";
  /** The locus: `document`, `node "n3" prop "rows"`, `query "invoices"`, or a
   *  check name when the finding is about the check itself. */
  where: string;
  message: string;
}

export interface CheckInput {
  app: GeneratedAppDocument;
  /** The user's own words — what the app was asked to be. */
  request: string;
  /** The plan the app was built from, when the check runs mid-pipeline; absent
   *  for checks over a finished document. */
  plan?: AppPlan;
}

export interface Check {
  name: string;
  run(input: CheckInput): Promise<Finding[]>;
}

export interface CheckingLayer {
  checks: Check[];
  run(input: CheckInput): Promise<Finding[]>;
}
