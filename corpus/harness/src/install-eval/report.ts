import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FixtureRunMetrics } from "./score.js";

/**
 * Install-eval report: one matrix row per fixture (like the v2
 * generalization matrix), per-fixture failure detail below it, and the
 * spec's iron rule in the footer — a new failure mode is only "fixed" once
 * it has a doctor error code and a verify page section.
 */

export interface InstallEvalReportDocument {
  version: 1;
  generatedAt: string;
  runId: string;
  mode: "live" | "dry-run";
  model: string;
  promptSource: string;
  prompt: string;
  fixtures: FixtureRunMetrics[];
  summary: {
    fixtureCount: number;
    doctorGreen: number;
    cleanRuns: number;
  };
}

export const REPORT_FOOTER_RULE =
  "Rule (spec 2026-07-19 §Testing): every NEW failure mode this eval surfaces gets a doctor "
  + "error code and a verify page section BEFORE it may be called fixed. No code + no verify "
  + "anchor = still broken.";

export function buildInstallEvalReport(input: {
  generatedAt: string;
  runId: string;
  mode: "live" | "dry-run";
  model: string;
  promptSource: string;
  prompt: string;
  fixtures: readonly FixtureRunMetrics[];
}): InstallEvalReportDocument {
  const cleanRuns = input.fixtures.filter(
    (fixture) => fixture.doctor.green && fixture.askedBeforeAccount.pass && fixture.violations.length === 0,
  ).length;
  return {
    version: 1,
    generatedAt: input.generatedAt,
    runId: input.runId,
    mode: input.mode,
    model: input.model,
    promptSource: input.promptSource,
    prompt: input.prompt,
    fixtures: [...input.fixtures],
    summary: {
      fixtureCount: input.fixtures.length,
      doctorGreen: input.fixtures.filter((fixture) => fixture.doctor.green).length,
      cleanRuns,
    },
  };
}

function escapeCell(text: string): string {
  return text.replaceAll(/\r?\n/g, " ").replaceAll("|", "\\|");
}

function yesNo(pass: boolean): string {
  return pass ? "yes" : "NO";
}

export function renderInstallEvalMarkdown(doc: InstallEvalReportDocument): string {
  const lines = [
    "# Agent install eval",
    "",
    `Generated: ${doc.generatedAt}`,
    `Mode: ${doc.mode}${doc.mode === "dry-run" ? " (canned transcript — no agent was invoked; doctor not run)" : ""}`,
    `Model: ${doc.model}`,
    `Prompt source: ${doc.promptSource} (read at runtime; drift-proof)`,
    "",
    `Summary: ${doc.summary.doctorGreen}/${doc.summary.fixtureCount} doctor-green; `
      + `${doc.summary.cleanRuns}/${doc.summary.fixtureCount} clean (green + asked + zero violations).`,
    "",
    "| Fixture | Doctor green | Turns (budget) | Asked before account | Ask gate | Violations | Cost (USD) | Duration |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const fixture of doc.fixtures) {
    const doctor = fixture.doctor.green
      ? "yes"
      : `NO (${fixture.doctor.failingCodes.join(", ") || "no codes"})`;
    const turns = `${fixture.turns}/${fixture.turnBudget}${fixture.withinTurnBudget ? "" : " OVER"}${fixture.agentExit.timedOut ? " (timed out)" : ""}`;
    const violations = fixture.violations.length === 0
      ? "none"
      : fixture.violations.map((violation) => violation.id).join(", ");
    lines.push(`| ${fixture.fixture} | ${escapeCell(doctor)} | ${turns} | ${yesNo(fixture.askedBeforeAccount.pass)} | ${fixture.askGate} | ${escapeCell(violations)} | ${fixture.costUsd === null ? "—" : fixture.costUsd.toFixed(2)} | ${fixture.durationMs === null ? "—" : `${Math.round(fixture.durationMs / 1000)}s`} |`);
  }

  for (const fixture of doc.fixtures) {
    const problems: string[] = [];
    if (!fixture.doctor.green) {
      problems.push(`- doctor: ${fixture.doctor.failingCodes.join(", ") || "not green"}${fixture.doctor.detail ? ` — ${fixture.doctor.detail}` : ""}`);
    }
    if (!fixture.askedBeforeAccount.pass) {
      problems.push(`- account action without a preceding ask:`);
      for (const action of fixture.askedBeforeAccount.accountActions) problems.push(`  - ${action}`);
    }
    for (const violation of fixture.violations) {
      problems.push(`- ${violation.id}: ${violation.detail}`);
    }
    if (problems.length > 0) {
      lines.push("", `## ${fixture.fixture} — failure detail`, "", ...problems);
    }
  }

  lines.push("", "---", "", REPORT_FOOTER_RULE, "");
  return lines.join("\n");
}

export async function writeInstallEvalReport(
  doc: InstallEvalReportDocument,
  options: { reportsDir: string },
): Promise<{ json: string; markdown: string }> {
  await mkdir(options.reportsDir, { recursive: true });
  const base = `install-eval-${doc.runId}`;
  const json = path.join(options.reportsDir, `${base}.json`);
  const markdown = path.join(options.reportsDir, `${base}.md`);
  await writeFile(json, `${JSON.stringify(doc, null, 2)}\n`);
  await writeFile(markdown, renderInstallEvalMarkdown(doc));
  return { json, markdown };
}
