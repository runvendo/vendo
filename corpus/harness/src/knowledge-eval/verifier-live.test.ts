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
  searches: Array<{ intent: string; hits: Array<{ docId: string; score?: number }> }>;
  verifications: Array<{ verdict: "supported" | "unsupported" | "none"; latencyMs: number }>;
  falseAnswer: boolean;
  falseRefusal: boolean;
}

interface LivePass {
  pass: number;
  falseAnswers: number;
  unanswerable: number;
  falseAnswersNeverVerified: number;
  falseAnswersNoVerdict: number;
  falseAnswersVerifierSaidSupported: number;
  falseRefusals: number;
  answerable: number;
  turnsVerified: number;
  verifications: number;
  noVerdict: number;
  unverifiedResults: number;
  verificationsPerSearch: number;
  verificationsPerVerifiedSearch: number;
  verifyLatencyMsP50: number;
  verifyLatencyMsP95: number;
  turnLatencyMsP50: number;
  turnLatencyMsP95: number;
}

/** The run script's percentile, duplicated so the test derives rather than
    trusts (nearest-rank, floor). */
const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
  passes: number;
  perPass: LivePass[];
  records: LiveRecord[];
  gating?: string;
  fidelity: { sweep: { deleted: boolean; listedStillContainsIt: boolean } };
  smokeRun?: unknown;
};
const doc = readFileSync(DOC, "utf8");

describe("the live verifier run (K15 T4) — the artifact is the evidence", () => {
  it("is a whole run: 94 labelled questions per pass, none dropped", () => {
    expect(artifact.smokeRun).toBeUndefined();
    expect(artifact.records).toHaveLength(94 * artifact.passes);
    for (let pass = 1; pass <= artifact.passes; pass += 1) {
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

  it("marks a turn unverified exactly when something went unchecked", () => {
    // The fail-open contract, observed on live traffic. Two ways a turn can go
    // unchecked: a verification came back with no verdict, or the per-turn
    // budget ran out before the second one could start (the tool skips rather
    // than spend a request that cannot finish). Both must be marked; a turn
    // where every search got a verdict must NOT be.
    for (const record of artifact.records) {
      const searchesWithHits = record.searches.filter((entry) => entry.hits.length > 0).length;
      const noVerdict = record.verifications.some((entry) => entry.verdict === "none");
      const skipped = record.verifications.length < searchesWithHits;
      expect(record.unverified).toBe(noVerdict || skipped);
    }
  });

  it("re-derives EVERY published per-pass aggregate from the records", () => {
    // Every field the doc can quote is re-derived here. A summary that drifts
    // from its own records — the K14 failure — is a red test.
    for (const summary of artifact.perPass) {
      const rows = artifact.records.filter((record) => record.pass === summary.pass);
      const verifications = rows.flatMap((record) => record.verifications);
      const verifiedTurns = rows.filter((record) => record.verifications.length > 0);
      const falseAnswers = rows.filter((record) => record.falseAnswer);
      expect({
        falseAnswers: falseAnswers.length,
        unanswerable: rows.filter((record) => record.label === "unanswerable").length,
        falseAnswersNeverVerified: falseAnswers.filter((r) => r.verifications.length === 0).length,
        falseAnswersNoVerdict: falseAnswers.filter((r) => r.verifications.length > 0 && r.unverified).length,
        falseAnswersVerifierSaidSupported:
          falseAnswers.filter((r) => r.verifications.length > 0 && !r.unverified).length,
        falseRefusals: rows.filter((record) => record.falseRefusal).length,
        answerable: rows.filter((record) => record.label === "answerable").length,
        turnsVerified: verifiedTurns.length,
        verifications: verifications.length,
        noVerdict: verifications.filter((entry) => entry.verdict === "none").length,
        unverifiedResults: rows.filter((record) => record.unverified).length,
        verificationsPerSearch: verifications.length / rows.length,
        verificationsPerVerifiedSearch:
          verifiedTurns.length === 0 ? 0 : verifications.length / verifiedTurns.length,
        verifyLatencyMsP50: percentile(verifications.map((entry) => entry.latencyMs), 50),
        verifyLatencyMsP95: percentile(verifications.map((entry) => entry.latencyMs), 95),
        turnLatencyMsP50: percentile(rows.map((record) => record.latencyMs), 50),
        turnLatencyMsP95: percentile(rows.map((record) => record.latencyMs), 95),
      }).toEqual({
        falseAnswers: summary.falseAnswers,
        unanswerable: summary.unanswerable,
        falseAnswersNeverVerified: summary.falseAnswersNeverVerified,
        falseAnswersNoVerdict: summary.falseAnswersNoVerdict,
        falseAnswersVerifierSaidSupported: summary.falseAnswersVerifierSaidSupported,
        falseRefusals: summary.falseRefusals,
        answerable: summary.answerable,
        turnsVerified: summary.turnsVerified,
        verifications: summary.verifications,
        noVerdict: summary.noVerdict,
        unverifiedResults: summary.unverifiedResults,
        verificationsPerSearch: summary.verificationsPerSearch,
        verificationsPerVerifiedSearch: summary.verificationsPerVerifiedSearch,
        verifyLatencyMsP50: summary.verifyLatencyMsP50,
        verifyLatencyMsP95: summary.verifyLatencyMsP95,
        turnLatencyMsP50: summary.turnLatencyMsP50,
        turnLatencyMsP95: summary.turnLatencyMsP95,
      });
    }
  });

  it("accounts for every false answer: the three causes are exhaustive", () => {
    // The published decomposition must add up. The first version of it did
    // not — it mixed the run's total no-verdicts into the false-answer subset
    // and the buckets summed to less than the total.
    for (const summary of artifact.perPass) {
      expect(
        summary.falseAnswersNeverVerified
        + summary.falseAnswersNoVerdict
        + summary.falseAnswersVerifierSaidSupported,
      ).toBe(summary.falseAnswers);
    }
  });

  it("verifies EVERY search that returned hits — no score gate survived", () => {
    // F1: the shipped tool no longer gates the check on a band. Any turn whose
    // first search returned hits must carry at least one verification.
    for (const record of artifact.records) {
      const firstSearchHits = record.searches[0]?.hits.length ?? 0;
      if (firstSearchHits > 0) expect(record.verifications.length).toBeGreaterThan(0);
    }
  });
});

const perPassHeadline = [...artifact.perPass].sort((a, b) => a.pass - b.pass);

describe("docs/eval/KNOWLEDGE.md quotes the runs it has", () => {
  const perPass = perPassHeadline;

  it("states each pass's false-answer count", () => {
    for (const pass of perPass) {
      expect(doc).toContain(`${pass.falseAnswers}/${pass.unanswerable}`);
    }
  });

  it("never quotes the withdrawn K14 claim as a live result", () => {
    const claimLines = doc.split("\n").filter((line) => line.includes("47% → 3%"));
    expect(claimLines.length).toBeGreaterThan(0);
    for (const line of claimLines) expect(line).toMatch(/WITHDRAWN|replay/i);
  });

  it("quotes the shipped configuration's decomposition, row by row", () => {
    // Each cause has its own row in the doc's decomposition table; the row
    // must carry this run's number for it.
    const row = (needle: string): string => {
      const line = doc.split("\n").find((candidate) => candidate.startsWith(`| ${needle}`));
      expect(line, `no decomposition row starting "| ${needle}"`).toBeDefined();
      return line!;
    };
    for (const pass of perPass) {
      expect(row("Never verified")).toContain(String(pass.falseAnswersNeverVerified));
      expect(row("No verdict")).toContain(String(pass.falseAnswersNoVerdict));
      expect(row("The verifier read")).toContain(String(pass.falseAnswersVerifierSaidSupported));
    }
  });

  it("quotes a cost that counts the second verifier call", () => {
    // A turn can verify twice, so calls-per-search is not the share of
    // searches that verified. The doc must quote the measured call count.
    expect(perPass[0]!.verificationsPerSearch).toBeGreaterThan(1);
    expect(doc).toContain(perPass[0]!.verificationsPerSearch.toFixed(2));
  });

  it("says plainly whether the spec's bar is met", () => {
    expect(doc).toContain("Does the spec's zero-false-answer bar hold? No.");
  });

  it("states the share of searches the check actually read", () => {
    expect(doc).toContain(`${perPass[0]!.turnsVerified}/94`);
  });
});

describe("every committed run is reported, not just the kind ones", () => {
  // Publishing the friendlier of several runs is the exact shape of the K14
  // failure. Every committed artifact's false-answer counts must appear in the
  // table, and the worst number anywhere must be the one the doc calls worst.
  const sibling = (file: string) =>
    JSON.parse(readFileSync(path.join(REPO, "docs/eval/knowledge/bands", file), "utf8")) as {
      perPass: LivePass[];
      records: LiveRecord[];
      gating?: string;
    };

  const UNGATED_RUN1 = "agentset-verifier-live-ungated-run1.json";
  const GATED = [
    "agentset-verifier-live-band-gated.json",
    "agentset-verifier-live-band-gated-run1.json",
    "agentset-verifier-live-band-gated-turn-budget-ab.json",
  ];

  it("the second ungated run is whole, and its numbers are in the table", () => {
    const run = sibling(UNGATED_RUN1);
    expect(run.records).toHaveLength(94);
    for (const pass of run.perPass) {
      expect(doc).toContain(`${pass.falseAnswers}/${pass.unanswerable}`);
    }
  });

  it("the band-gated runs are whole, and their numbers are in the table", () => {
    for (const file of GATED) {
      const run = sibling(file);
      expect(run.records.length % 94).toBe(0);
      for (const pass of run.perPass) {
        expect(doc).toContain(`${pass.falseAnswers}/${pass.unanswerable}`);
      }
    }
  });

  it("states the worst pass of EACH configuration, never the kinder one", () => {
    const unanswerable = artifact.perPass[0]!.unanswerable;
    const worstOf = (runs: Array<{ perPass: LivePass[] }>) =>
      Math.max(...runs.flatMap((run) => run.perPass.map((pass) => pass.falseAnswers)));
    for (const worst of [worstOf([artifact, sibling(UNGATED_RUN1)]), worstOf(GATED.map(sibling))]) {
      expect(doc).toContain(`**${worst}/${unanswerable} — ${Math.round((worst / unanswerable) * 100)}%**`);
    }
  });

  it("keeps the gated runs labelled as gated, so neither config is quoted as the other", () => {
    for (const file of GATED) expect(file).toContain("band-gated");
    expect(artifact.gating).toMatch(/^none/);
  });
});
