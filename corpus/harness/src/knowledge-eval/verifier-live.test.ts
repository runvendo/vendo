/**
 * The published verifier numbers must recompute from the committed records.
 *
 * K14's table was a summary nobody could check against a raw run: the passages
 * were reconstructed, the outcomes hand-computed, and the artifact carried the
 * conclusion rather than the evidence. This suite is the structural fix. It
 * reads EVERY committed live-run artifact — not just the headline one (round-2
 * finding: the siblings' summaries could drift while this suite stayed green)
 * — re-derives every per-pass aggregate field by field from the per-question
 * records, then checks that the headline numbers in docs/eval/KNOWLEDGE.md are
 * those same numbers. Doctoring a summary, or letting the doc drift off the
 * data, is a red test.
 *
 * Offline and deterministic — it calls nothing, it only recomputes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const BANDS = path.join(REPO, "docs/eval/knowledge/bands");
const DOC = path.join(REPO, "docs/eval/KNOWLEDGE.md");

interface LiveRecord {
  pass: number;
  label: "answerable" | "unanswerable";
  outcome: string;
  unverified: boolean;
  latencyMs: number;
  lookup?: true;
  searches: Array<{ intent: string; hits: Array<{ docId: string; score?: number }> }>;
  verifications: Array<{ verdict: "supported" | "unsupported" | "none"; latencyMs: number }>;
  falseAnswer: boolean;
  falseRefusal: boolean;
}

/** A per-pass summary. The five artifacts were written by successive runner
    versions, so the derived fields differ per artifact; the guard recomputes
    exactly the fields each summary carries and rejects any it cannot derive. */
type LivePass = { pass: number } & Record<string, number>;

interface LiveArtifact {
  passes: number;
  gating?: string;
  band?: unknown;
  fidelity: { sweep: { deleted: boolean; listedStillContainsIt: boolean } };
  smokeRun?: unknown;
  perPass: LivePass[];
  records: LiveRecord[];
}

/** The run script's percentile, duplicated so the test derives rather than
    trusts (nearest-rank, floor). */
const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const load = (file: string): LiveArtifact =>
  JSON.parse(readFileSync(path.join(BANDS, file), "utf8")) as LiveArtifact;

/** Every committed measurement. `ungated` marks the shipped configuration —
    its extra invariants (the check reads every hits-returning search; skipped
    or verdictless turns are MARKED) do not hold for the band-gated arm, whose
    unchecked turns are exactly the evidence the gate was removed on. `shape`
    is each run's labelled probe count per pass; `lookup` marks the targeted
    schema-branch pass (round 3), which is proof of a code path, not part of
    the query-path aggregate tables. */
const ARTIFACTS: Array<{
  name: string;
  file: string;
  ungated: boolean;
  lookup: boolean;
  shape: { answerable: number; unanswerable: number };
}> = [
  { name: "ungated run 2 (headline)", file: "agentset-verifier-live.json", ungated: true, lookup: false, shape: { answerable: 60, unanswerable: 34 } },
  { name: "ungated run 1", file: "agentset-verifier-live-ungated-run1.json", ungated: true, lookup: false, shape: { answerable: 60, unanswerable: 34 } },
  { name: "band-gated run A", file: "agentset-verifier-live-band-gated.json", ungated: false, lookup: false, shape: { answerable: 60, unanswerable: 34 } },
  { name: "band-gated run B", file: "agentset-verifier-live-band-gated-run1.json", ungated: false, lookup: false, shape: { answerable: 60, unanswerable: 34 } },
  { name: "band-gated 8s A/B arm", file: "agentset-verifier-live-band-gated-turn-budget-ab.json", ungated: false, lookup: false, shape: { answerable: 60, unanswerable: 34 } },
  { name: "targeted schema/lookup pass", file: "agentset-verifier-live-lookup.json", ungated: true, lookup: true, shape: { answerable: 6, unanswerable: 6 } },
].map((entry) => ({ ...entry }));

const loaded = ARTIFACTS.map((entry) => ({ ...entry, data: load(entry.file) }));
const artifact = loaded[0]!.data; // the headline ungated run
const doc = readFileSync(DOC, "utf8");

/** Everything a per-pass summary may publish, derived from the records alone.
    A summary key with no derivation here fails the guard — nothing publishable
    may escape recomputation. */
function derivedSummary(rows: LiveRecord[]): Record<string, number> {
  const verifications = rows.flatMap((record) => record.verifications);
  const verifiedTurns = rows.filter((record) => record.verifications.length > 0);
  const verifiedTurnSums = verifiedTurns.map(
    (record) => record.verifications.reduce((total, entry) => total + entry.latencyMs, 0),
  );
  const falseAnswers = rows.filter((record) => record.falseAnswer);
  return {
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
    verificationsPerSearch: rows.length === 0 ? 0 : verifications.length / rows.length,
    verificationsPerVerifiedSearch:
      verifiedTurns.length === 0 ? 0 : verifications.length / verifiedTurns.length,
    verifyLatencyMsP50: percentile(verifications.map((entry) => entry.latencyMs), 50),
    verifyLatencyMsP95: percentile(verifications.map((entry) => entry.latencyMs), 95),
    verifiedTurnVerifyMsP50: percentile(verifiedTurnSums, 50),
    verifiedTurnVerifyMsP95: percentile(verifiedTurnSums, 95),
    turnLatencyMsP50: percentile(rows.map((record) => record.latencyMs), 50),
    turnLatencyMsP95: percentile(rows.map((record) => record.latencyMs), 95),
  };
}

for (const { name, file, ungated, lookup, shape, data } of loaded) {
  const perPassTotal = shape.answerable + shape.unanswerable;
  describe(`${name} (${file}) — the artifact is the evidence`, () => {
    it(`is a whole run: ${perPassTotal} labelled questions per pass, none dropped`, () => {
      expect(data.smokeRun).toBeUndefined();
      expect(data.perPass).toHaveLength(data.passes);
      expect(data.records).toHaveLength(perPassTotal * data.passes);
      for (let pass = 1; pass <= data.passes; pass += 1) {
        const rows = data.records.filter((record) => record.pass === pass);
        expect(rows.filter((record) => record.label === "answerable")).toHaveLength(shape.answerable);
        expect(rows.filter((record) => record.label === "unanswerable")).toHaveLength(shape.unanswerable);
      }
    });

    it("proves its test namespace was swept", () => {
      expect(data.fidelity.sweep.deleted).toBe(true);
      expect(data.fidelity.sweep.listedStillContainsIt).toBe(false);
    });

    it("scores each question from its LABEL and the tool's own outcome, nothing else", () => {
      for (const record of data.records) {
        expect(record.falseAnswer).toBe(record.label === "unanswerable" && record.outcome === "answered");
        expect(record.falseRefusal).toBe(record.label === "answerable" && record.outcome === "insufficient-evidence");
      }
    });

    it("every published per-pass field recomputes from the records — no exceptions", () => {
      for (const summary of data.perPass) {
        const rows = data.records.filter((record) => record.pass === summary.pass);
        const derived = derivedSummary(rows);
        const { pass: _pass, ...published } = summary;
        for (const key of Object.keys(published)) {
          expect(derived, `summary field "${key}" has no derivation — it cannot be audited`)
            .toHaveProperty(key);
          expect(published[key], `pass ${summary.pass} field "${key}"`).toBe(derived[key]);
        }
      }
    });

    it("accounts for every false answer when it publishes the decomposition", () => {
      // The three causes must be exhaustive. Artifacts written before the
      // decomposition existed simply do not carry the fields; the recompute
      // above still audits their false-answer totals.
      for (const summary of data.perPass) {
        if (summary.falseAnswersNeverVerified === undefined) continue;
        expect(
          summary.falseAnswersNeverVerified!
          + summary.falseAnswersNoVerdict!
          + summary.falseAnswersVerifierSaidSupported!,
        ).toBe(summary.falseAnswers);
      }
    });

    if (ungated) {
      it("verifies EVERY search that returned hits — no score gate survived", () => {
        for (const record of data.records) {
          const firstSearchHits = record.searches[0]?.hits.length ?? 0;
          if (firstSearchHits > 0) expect(record.verifications.length).toBeGreaterThan(0);
        }
      });

      it("marks a turn unverified exactly when something went unchecked", () => {
        // The fail-open contract, observed on live traffic. Two ways a turn
        // can go unchecked: a verification came back with no verdict, or the
        // per-turn budget ran out before the second one could start. Both must
        // be marked; a turn where every search got a verdict must NOT be.
        for (const record of data.records) {
          const searchesWithHits = record.searches.filter((entry) => entry.hits.length > 0).length;
          const noVerdict = record.verifications.some((entry) => entry.verdict === "none");
          const skipped = record.verifications.length < searchesWithHits;
          expect(record.unverified).toBe(noVerdict || skipped);
        }
      });

      it("says it ran ungated", () => {
        expect(data.gating).toMatch(/^none/);
      });
    }

    if (lookup) {
      it("every record went through the SCHEMA branch: lookup-flagged, one schema-intent search", () => {
        // Round 3: the live proof that `lookup: true` adjudicates. The lookup
        // branch makes exactly one search, intent "schema" — a chat or deep
        // intent here would mean the probe fell through to the query ladder
        // and proved nothing about the schema branch.
        for (const record of data.records) {
          expect(record.lookup).toBe(true);
          expect(record.searches).toHaveLength(1);
          expect(record.searches[0]!.intent).toBe("schema");
          if (record.searches[0]!.hits.length > 0) {
            expect(record.verifications.length).toBeGreaterThan(0);
          }
        }
      });

      it("is the schema branch a host gets: lookups with hits carry a real verdict or the mark", () => {
        for (const record of data.records) {
          if (record.searches[0]!.hits.length === 0) continue;
          const gotVerdict = record.verifications.some((entry) => entry.verdict !== "none");
          expect(gotVerdict || record.unverified).toBe(true);
        }
      });
    }

    if (!ungated) {
      it("is labelled band-gated, so neither configuration is quoted as the other", () => {
        expect(file).toContain("band-gated");
        expect(data.band).toBeDefined();
      });
    }
  });
}

const perPassHeadline = [...artifact.perPass].sort((a, b) => a.pass - b.pass);

describe("docs/eval/KNOWLEDGE.md quotes the runs it has", () => {
  const perPass = perPassHeadline;

  it("states each pass's false-answer count — for EVERY committed run", () => {
    for (const { data } of loaded) {
      for (const pass of data.perPass) {
        expect(doc).toContain(`${pass.falseAnswers}/${pass.unanswerable}`);
      }
    }
  });

  it("never quotes the withdrawn K14 claim as a live result", () => {
    const claimLines = doc.split("\n").filter((line) => line.includes("47% → 3%"));
    expect(claimLines.length).toBeGreaterThan(0);
    for (const line of claimLines) expect(line).toMatch(/WITHDRAWN|replay/i);
  });

  it("quotes the shipped configuration's decomposition, row by row", () => {
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
    expect(perPass[0]!.verificationsPerSearch).toBeGreaterThan(1);
    expect(doc).toContain(perPass[0]!.verificationsPerSearch!.toFixed(2));
  });

  it("says plainly whether the spec's bar is met", () => {
    expect(doc).toContain("Does the spec's zero-false-answer bar hold? No.");
  });

  it("states the share of searches the check actually read", () => {
    expect(doc).toContain(`${perPass[0]!.turnsVerified}/94`);
  });

  it("states the worst pass of EACH configuration, never the kinder one", () => {
    const unanswerable = perPass[0]!.unanswerable!;
    const worstOf = (runs: LiveArtifact[]) =>
      Math.max(...runs.flatMap((run) => run.perPass.map((pass) => pass.falseAnswers!)));
    // The lookup pass is a code-path proof over a different probe set — it is
    // quoted in its own section, never mixed into the query-path worst case.
    const ungatedRuns = loaded.filter((entry) => entry.ungated && !entry.lookup).map((entry) => entry.data);
    const gatedRuns = loaded.filter((entry) => !entry.ungated).map((entry) => entry.data);
    for (const worst of [worstOf(ungatedRuns), worstOf(gatedRuns)]) {
      expect(doc).toContain(`**${worst}/${unanswerable} — ${Math.round((worst / unanswerable) * 100)}%**`);
    }
  });

  it("quotes latency per verified TURN as the sum of that turn's calls, never per-call percentiles", () => {
    // Round-2 finding: the row labelled per "verified turn" carried per-CALL
    // p50/p95. A chat→deep turn pays for two calls; what verification costs a
    // turn is their sum. Both table rows — and the whole-tool row — must be
    // the ranges these records actually produce. The 8s A/B arm is excluded:
    // it measures a different budget and has its own table.
    const seconds = (ms: number): string => (ms / 1000).toFixed(1);
    const range = (values: number[]): string => {
      const low = seconds(Math.min(...values));
      const high = seconds(Math.max(...values));
      return low === high ? `${low}s` : `${low}-${high}s`;
    };
    const cell = (runs: LiveArtifact[], of: (rows: LiveRecord[]) => { p50: number; p95: number }): string => {
      const p50s: number[] = [];
      const p95s: number[] = [];
      for (const run of runs) {
        for (let pass = 1; pass <= run.passes; pass += 1) {
          const stats = of(run.records.filter((record) => record.pass === pass));
          p50s.push(stats.p50);
          p95s.push(stats.p95);
        }
      }
      return `p50 ${range(p50s)} · p95 ${range(p95s)}`;
    };
    const verifiedTurnSum = (rows: LiveRecord[]) => {
      const sums = rows
        .filter((record) => record.verifications.length > 0)
        .map((record) => record.verifications.reduce((total, entry) => total + entry.latencyMs, 0));
      return { p50: percentile(sums, 50), p95: percentile(sums, 95) };
    };
    const wholeTool = (rows: LiveRecord[]) => ({
      p50: percentile(rows.map((record) => record.latencyMs), 50),
      p95: percentile(rows.map((record) => record.latencyMs), 95),
    });
    const ungatedRuns = loaded.filter((entry) => entry.ungated && !entry.lookup).map((entry) => entry.data);
    const gatedRuns = loaded
      .filter((entry) => !entry.ungated && !entry.file.includes("turn-budget-ab"))
      .map((entry) => entry.data);
    for (const expected of [
      cell(ungatedRuns, verifiedTurnSum),
      cell(gatedRuns, verifiedTurnSum),
      cell(ungatedRuns, wholeTool),
      cell(gatedRuns, wholeTool),
    ]) {
      expect(doc).toContain(expected);
    }
  });
});
