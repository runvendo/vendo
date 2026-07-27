/**
 * The published verifier numbers must recompute from the committed records.
 *
 * K14's table was a summary nobody could check against a raw run: the passages
 * were reconstructed, the outcomes hand-computed, and the artifact carried the
 * conclusion rather than the evidence. This suite is the structural fix. It
 * reads the committed live-run artifact and re-derives every aggregate from
 * the per-question records, then checks that the headline numbers in
 * docs/eval/KNOWLEDGE.md are those same numbers. Doctoring a summary, or
 * letting the doc drift off the data, is a red test.
 *
 * Offline and deterministic — it calls nothing, it only recomputes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const ARTIFACT = path.join(REPO, "docs/eval/knowledge/bands/agentset-verifier-live.json");
const DOC = path.join(REPO, "docs/eval/KNOWLEDGE.md");

interface LiveRecord {
  pass: number;
  label: "answerable" | "unanswerable";
  outcome: string;
  unverified: boolean;
  latencyMs: number;
  verifications: Array<{ verdict: "supported" | "unsupported" | "none"; latencyMs: number }>;
  falseAnswer: boolean;
  falseRefusal: boolean;
}

interface LivePass {
  pass: number;
  falseAnswers: number;
  unanswerable: number;
  falseRefusals: number;
  answerable: number;
  turnsVerified: number;
  verifications: number;
  noVerdict: number;
  unverifiedResults: number;
}

const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
  passes: number;
  perPass: LivePass[];
  records: LiveRecord[];
  fidelity: { sweep: { deleted: boolean; listedStillContainsIt: boolean } };
  smokeRun?: unknown;
};
const doc = readFileSync(DOC, "utf8");

describe("the live verifier run (K15 T4) — the artifact is the evidence", () => {
  it("is a whole run: 94 labelled questions × 3 passes, none dropped", () => {
    expect(artifact.smokeRun).toBeUndefined();
    expect(artifact.passes).toBe(3);
    expect(artifact.records).toHaveLength(94 * 3);
    for (let pass = 1; pass <= 3; pass += 1) {
      const rows = artifact.records.filter((record) => record.pass === pass);
      expect(rows.filter((record) => record.label === "answerable")).toHaveLength(60);
      expect(rows.filter((record) => record.label === "unanswerable")).toHaveLength(34);
    }
  });

  it("proves the test namespace was swept", () => {
    expect(artifact.fidelity.sweep.deleted).toBe(true);
    expect(artifact.fidelity.sweep.listedStillContainsIt).toBe(false);
  });

  it("scores each question from its LABEL and the tool's own outcome, nothing else", () => {
    for (const record of artifact.records) {
      expect(record.falseAnswer).toBe(record.label === "unanswerable" && record.outcome === "answered");
      expect(record.falseRefusal).toBe(record.label === "answerable" && record.outcome === "insufficient-evidence");
    }
  });

  it("marks every no-verdict turn unverified, and no other turn", () => {
    // The fail-open contract, observed on live traffic: a turn whose
    // verification produced nothing says so; a turn that got a verdict does
    // not claim it could not check.
    for (const record of artifact.records) {
      expect(record.unverified).toBe(record.verifications.some((entry) => entry.verdict === "none"));
    }
  });

  it("re-derives every per-pass aggregate from the records", () => {
    for (const summary of artifact.perPass) {
      const rows = artifact.records.filter((record) => record.pass === summary.pass);
      const verifications = rows.flatMap((record) => record.verifications);
      expect({
        falseAnswers: rows.filter((record) => record.falseAnswer).length,
        unanswerable: rows.filter((record) => record.label === "unanswerable").length,
        falseRefusals: rows.filter((record) => record.falseRefusal).length,
        answerable: rows.filter((record) => record.label === "answerable").length,
        turnsVerified: rows.filter((record) => record.verifications.length > 0).length,
        verifications: verifications.length,
        noVerdict: verifications.filter((entry) => entry.verdict === "none").length,
        unverifiedResults: rows.filter((record) => record.unverified).length,
      }).toEqual({
        falseAnswers: summary.falseAnswers,
        unanswerable: summary.unanswerable,
        falseRefusals: summary.falseRefusals,
        answerable: summary.answerable,
        turnsVerified: summary.turnsVerified,
        verifications: summary.verifications,
        noVerdict: summary.noVerdict,
        unverifiedResults: summary.unverifiedResults,
      });
    }
  });
});

const perPassHeadline = [...artifact.perPass].sort((a, b) => a.pass - b.pass);

describe("docs/eval/KNOWLEDGE.md quotes the runs it has", () => {
  const perPass = perPassHeadline;
  const worstFalseAnswers = Math.max(...perPass.map((pass) => pass.falseAnswers));
  const worstFalseRefusals = Math.max(...perPass.map((pass) => pass.falseRefusals));

  it("states each pass's false-answer count", () => {
    for (const pass of perPass) {
      expect(doc).toContain(`${pass.falseAnswers}/${pass.unanswerable}`);
    }
  });

  it("states the TRUE worst case, never a wider range than was observed", () => {
    const pct = (count: number, total: number) => Math.round((count / total) * 100);
    expect(doc).toContain(
      `**${worstFalseAnswers}/${perPass[0]!.unanswerable} — ${pct(worstFalseAnswers, perPass[0]!.unanswerable)}%**`,
    );
    expect(doc).toContain(
      `**${worstFalseRefusals}/${perPass[0]!.answerable} — ${pct(worstFalseRefusals, perPass[0]!.answerable)}%**`,
    );
    // The withdrawn K14 claim must not read as a live result anywhere.
    const claimLines = doc.split("\n").filter((line) => line.includes("47% → 3%"));
    for (const line of claimLines) expect(line).toMatch(/WITHDRAWN|replay/i);
  });

  it("says plainly whether the spec's bar is met", () => {
    expect(doc).toContain("Does the spec's zero-false-answer bar hold? No.");
  });

  it("states the band's routing share the records show", () => {
    expect(doc).toContain(`${perPass[0]!.turnsVerified}/94`);
  });
});

describe("the second run of the shipped configuration is reported too", () => {
  // Reporting the kinder of two runs of the same configuration is the exact
  // shape of the K14 failure, so the sibling artifact is committed and its
  // per-pass counts must appear in the doc as well.
  const second = JSON.parse(
    readFileSync(path.join(REPO, "docs/eval/knowledge/bands/agentset-verifier-live-run1.json"), "utf8"),
  ) as { perPass: LivePass[]; records: LiveRecord[] };

  it("is a whole run", () => {
    expect(second.records).toHaveLength(94 * 3);
  });

  it("has its false-answer counts in the table", () => {
    for (const pass of second.perPass) {
      expect(doc).toContain(`${pass.falseAnswers}/${pass.unanswerable}`);
    }
  });

  it("does not quietly beat the headline run: the WORST of both is what the doc calls worst", () => {
    const worstOfBoth = Math.max(
      ...second.perPass.map((pass) => pass.falseAnswers),
      ...perPassHeadline.map((pass) => pass.falseAnswers),
    );
    expect(worstOfBoth).toBe(Math.max(...perPassHeadline.map((pass) => pass.falseAnswers)));
  });
});
