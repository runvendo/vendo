import { appendFile } from "node:fs/promises";
import { DETERMINISTIC_SUITES, SUITES, suiteByName } from "./benches/index.js";
import { findBreaches, findUnmatchedCeilings, loadBudgets } from "./budgets.js";
import { buildReport, checkSummary, failureSummary, suiteTables, textSummary } from "./report.js";
import type { Suite, SuiteResult } from "./types.js";

interface Args {
  suites: string[];
  json: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const suites: string[] = [];
  let json = false;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--check") check = true;
    else if (arg === "--suite" || arg === "-s") {
      const value = argv[i + 1];
      if (value !== undefined) {
        suites.push(...value.split(","));
        i += 1;
      }
    } else if (arg.startsWith("--suite=")) {
      suites.push(...arg.slice("--suite=".length).split(","));
    }
  }
  return { suites: suites.map((s) => s.trim()).filter(Boolean), json, check };
}

function resolveSuites(args: Args): Suite[] {
  if (args.suites.length === 0) {
    // No selection: deterministic suites (the fast, CI-safe default).
    return DETERMINISTIC_SUITES;
  }
  if (args.suites.includes("all")) return SUITES;
  const resolved: Suite[] = [];
  for (const name of args.suites) {
    const suite = suiteByName(name);
    if (suite === undefined) {
      throw new Error(
        `unknown suite "${name}". Available: ${SUITES.map((s) => s.name).join(", ")}, all`,
      );
    }
    resolved.push(suite);
  }
  return resolved;
}

async function writeStepSummary(markdown: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) await appendFile(path, `${markdown}\n`);
}

async function main(currentSuite: { name?: string }): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let selected = resolveSuites(args);

  if (args.check) {
    // Only deterministic suites are budget-gated; drop any live ones from --check.
    selected = selected.filter((s) => s.kind === "deterministic");
  }

  const results: SuiteResult[] = [];
  for (const suite of selected) {
    currentSuite.name = suite.name;
    process.stderr.write(`running ${suite.name}...\n`);
    results.push(await suite.run());
  }
  currentSuite.name = undefined;

  if (args.check) {
    const budgets = await loadBudgets();
    const breaches = findBreaches(results, budgets);
    // Gate integrity: on a full-set check (the CI path), every ceiling key must
    // match a measured case, or a renamed/deleted suite silently un-gates
    // itself. A partial `--check --suite <name>` run skips this by design.
    const fullSet = args.suites.length === 0 || args.suites.includes("all");
    const unmatched = fullSet ? findUnmatchedCeilings(results, budgets) : [];
    const summary = checkSummary(results, breaches, unmatched);
    await writeStepSummary(summary);
    process.stdout.write(`${summary}\n`);
    if (breaches.length > 0 || unmatched.length > 0) {
      process.stderr.write(
        `\n${breaches.length} budget breach(es), ${unmatched.length} unmatched ceiling key(s).\n`,
      );
      process.exit(1);
    }
    return;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(buildReport(results), null, 2)}\n`);
  } else {
    process.stdout.write(`${textSummary(results)}\n`);
  }
  await writeStepSummary(suiteTables(results));
}

const currentSuite: { name?: string } = {};
main(currentSuite).catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  // A thrown suite is an infra/harness failure — still leave a step summary
  // behind so the CI job page isn't blank.
  await writeStepSummary(failureSummary(currentSuite.name, error)).catch(() => undefined);
  process.exit(1);
});
