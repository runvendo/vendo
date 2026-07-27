/**
 * THE VERIFIER'S LIVE MEASUREMENT (K15 T4).
 *
 * K14 published a verifier table from a REPLAY: passages reconstructed by a
 * different dense retriever, the verifier called directly instead of through
 * the tool, outcomes computed by hand. Top-document agreement with the real
 * engine was 42/94. This script is the honest version of that measurement, and
 * every claim it makes is recomputable from the records it writes:
 *
 *   0. NO score gate: the verifier reads every search that returns hits, which is
 *      what the tool now ships (K14 gated it on a calibrated band; the gated
 *      arm is kept as `agentset-verifier-live-band-gated*.json` for comparison).
 *   1. Passages come from a REAL Agentset search against a namespace ingested
 *      with the SAME corpus the 94 labels were written against
 *      (`fixtures/corpus.json`, byte-identical to the calibration's inputs).
 *   2. The path is the REAL tool path — `vendo_knowledge_search` from
 *      `createKnowledgeTools`, composed with the band and verifier a Cloud
 *      host gets from `createVendo` (packages/vendo `knowledgeToolOptions`),
 *      and the OUTCOME is whatever the tool returned. Nothing is hand-derived.
 *   3. The verifier makes a real model call on the shipped `knowledgeVerifier`
 *      slot, resolved through the same `vendoModel` ladder production uses.
 *   4. All 94 questions run: 60 answerable (golden) + 34 unanswerable
 *      (refusals with their paraphrases), labels untouched.
 *   5. Every per-question record is committed: retrieved doc ids and scores,
 *      the verdict and its stated gap, the final outcome, wall-clock latency.
 *
 * Run it three times (`LIVE_PASSES`), publish per-pass numbers AND the true
 * worst case. Spends Agentset and model money; never part of `pnpm test`.
 *
 *   AGENTSET_API_KEY=… ANTHROPIC_API_KEY=… \
 *     pnpm --filter @vendoai/corpus-harness knowledge-verifier-live
 *
 * The namespace is deleted and PROVEN gone at the end, always.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { KnowledgeDoc, RunContext, ToolOutcome } from "@vendoai/core";
import {
  createKnowledgeTools,
  entailmentVerifier,
  KNOWLEDGE_VERIFY_TIMEOUT_MS,
  KNOWLEDGE_VERIFY_TURN_BUDGET_MS,
  type KnowledgeVerdict,
  type KnowledgeVerifier,
} from "@vendoai/knowledge";
import { vendoModel } from "@vendoai/vendo/server";
import {
  agentsetClient,
  agentsetEngine,
  createNamespace,
  ingestCorpus,
  sweepNamespace,
} from "./agentset-engine.js";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "../../../..");
const EVAL_DIR = path.join(REPO, "docs/eval/knowledge");
const BANDS_DIR = path.join(EVAL_DIR, "bands");

const PASSES = Number(process.env.LIVE_PASSES ?? 3);
/** Concurrent questions. Well under Agentset's 600 rpm org-wide ceiling, and
    the same concurrency the cloud calibration probed at. */
const CONCURRENCY = 4;
/** The per-TURN verification budget under test. Unset = the shipped default
    (KNOWLEDGE_VERIFY_TURN_BUDGET_MS). Exists so the shipped number is chosen
    from a measured A/B rather than taste; every run records what it used. */
const TURN_BUDGET_MS = process.env.LIVE_TURN_BUDGET_MS === undefined
  ? undefined
  : Number(process.env.LIVE_TURN_BUDGET_MS);
/** The host's weak-score threshold. Unset = the shipped default (0), which is
    what a Cloud host runs today. Set it to measure the verifier ALONGSIDE a
    calibrated refusal bar — two independent decisions, so the measurement
    covers both configurations instead of assuming one. */
const WEAK_SCORE_THRESHOLD = process.env.LIVE_WEAK_SCORE_THRESHOLD === undefined
  ? undefined
  : Number(process.env.LIVE_WEAK_SCORE_THRESHOLD);

type GoldenItem = { id: string; question: string; expectedDocIds: string[] };
type RefusalItem = { id: string; question: string; paraphrases: string[] };

interface Probe {
  id: string;
  /** answerable = the corpus contains the answer; unanswerable = it does not. */
  label: "answerable" | "unanswerable";
  question: string;
  expectedDocIds: string[];
  /** Round 3: this probe calls the tool with `lookup: true`, exercising the
      schema-search branch (glossary/api kinds) instead of the chat→deep
      ladder. */
  lookup?: true;
}

/** One question, one pass, as the tool actually answered it. */
interface Record_ {
  pass: number;
  id: string;
  label: Probe["label"];
  question: string;
  /** Present when this record exercised the schema/lookup branch. */
  lookup?: true;
  /** Every search the tool made, in order (chat, then deep if it escalated). */
  searches: Array<{ intent: string; hits: Array<{ docId: string; score?: number }> }>;
  verifications: Array<{ verdict: "supported" | "unsupported" | "none"; gap?: string; latencyMs: number }>;
  outcome: string;
  /** The gap the tool put in the model's context on a verifier refusal. */
  message?: string;
  unverified: boolean;
  latencyMs: number;
  /** The scoring judgement, from the label and the outcome ALONE. */
  falseAnswer: boolean;
  falseRefusal: boolean;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

function probes(): Probe[] {
  const golden = readJson<{ items: GoldenItem[] }>(path.join(EVAL_DIR, "golden.json"));
  const refusals = readJson<{ items: RefusalItem[] }>(path.join(EVAL_DIR, "refusals.json"));
  return [
    ...golden.items.map((item) => ({
      id: item.id,
      label: "answerable" as const,
      question: item.question,
      expectedDocIds: item.expectedDocIds,
    })),
    // Paraphrases are separate probes, exactly as the cloud calibration
    // counted them: an unanswerable question asked three ways is three
    // chances to hand back a confident near-miss.
    ...refusals.items.flatMap((item) =>
      [item.question, ...item.paraphrases].map((question, index) => ({
        id: index === 0 ? item.id : `${item.id}~${index}`,
        label: "unanswerable" as const,
        question,
        expectedDocIds: [] as string[],
      })),
    ),
  ];
}

/** The targeted lookup pass (checker round 3): the aggregate tables above are
    query-path measurements; this is the live proof that the SCHEMA branch
    adjudicates too. Existing labelled items, labels untouched — six golden
    glossary-term questions the corpus defines, six refusal questions that ask
    for a structured fact the corpus does not hold. Base questions only, no
    paraphrases: the point is the code path, not another aggregate. */
const LOOKUP_GOLDEN = ["sc-block", "sc-wire", "sc-guard-term", "sc-principal-term", "sc-adapter-term", "sc-intent-term"];
const LOOKUP_REFUSALS = ["rf-sla", "rf-seat-pricing", "rf-refunds", "rf-soc2", "rf-gdpr", "rf-python-sdk"];

function lookupProbes(): Probe[] {
  const ids = new Set([...LOOKUP_GOLDEN, ...LOOKUP_REFUSALS]);
  const selected = probes().filter((probe) => ids.has(probe.id));
  if (selected.length !== ids.size) {
    throw new Error(`lookup probe selection matched ${selected.length}/${ids.size} ids — fixture drift, refusing to run a partial set`);
  }
  return selected.map((probe) => ({ ...probe, lookup: true as const }));
}

async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    }),
  );
  return results;
}

/** Wraps the SHIPPED verifier to record what it decided and how long it took.
    The tool calls this; the verdict recorded is therefore the verdict used —
    there is no second, private evaluation anywhere in this script. */
function recordingVerifier(inner: KnowledgeVerifier): {
  verifier: KnowledgeVerifier;
  drain(): Record_["verifications"];
} {
  let log: Record_["verifications"] = [];
  return {
    verifier: {
      async verify(input, options): Promise<KnowledgeVerdict | undefined> {
        const startedAt = Date.now();
        const verdict = await inner.verify(input, options);
        log.push({
          verdict: verdict === undefined ? "none" : verdict.supported ? "supported" : "unsupported",
          ...(verdict === undefined ? {} : { gap: verdict.gap }),
          latencyMs: Date.now() - startedAt,
        });
        return verdict;
      },
    },
    drain() {
      const drained = log;
      log = [];
      return drained;
    },
  };
}

const ctx = (): RunContext => ({
  principal: { kind: "user", subject: "knowledge-verifier-live" },
  venue: "chat",
  presence: "present",
  sessionId: "live",
});

const envelopeOf = (outcome: ToolOutcome): Record<string, unknown> =>
  (outcome as { output?: Record<string, unknown> }).output ?? {};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

async function main(): Promise<void> {
  const request = agentsetClient(process.env.AGENTSET_API_KEY);
  const corpus = readJson<{ docs: KnowledgeDoc[] }>(path.join(HERE, "fixtures/corpus.json"));
  const limit = Number(process.env.LIVE_LIMIT ?? 0);
  const lookupOnly = process.env.LIVE_LOOKUP === "1";
  const all = lookupOnly ? lookupProbes() : limit > 0 ? probes().slice(0, limit) : probes();
  if (lookupOnly) {
    console.log(`LIVE_LOOKUP=1 — targeted schema/lookup pass over ${all.length} probes (lookup: true through the same tool path)`);
  }
  if (limit > 0) {
    // A smoke run, not a measurement. Say so here AND in the artifact (the
    // record count and this flag are both in the file), so a partial run can
    // never be quoted as the 94-question result.
    console.log(`LIVE_LIMIT=${limit} — SMOKE RUN over ${all.length} probes, NOT the measurement`);
  }
  const answerable = all.filter((probe) => probe.label === "answerable").length;
  console.log(
    `corpus ${corpus.docs.length} docs · ${answerable} answerable + ${all.length - answerable} unanswerable · UNGATED (every hits-returning search is verified) · ${PASSES} passes`,
  );

  const stamp = new Date().toISOString();
  const slug = `vendo-k15-live-${stamp.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const namespaceId = await createNamespace(request, slug, `vendo k15 verifier live ${stamp}`);
  console.log(`namespace ${namespaceId}`);

  const records: Record_[] = [];
  let verifierModelLine: string | undefined;
  let sweep: Awaited<ReturnType<typeof sweepNamespace>> | undefined;
  try {
    const ingestStartedAt = Date.now();
    const docIds = await ingestCorpus(request, namespaceId, corpus.docs, (done, total) =>
      console.log(`ingested ${done}/${total} (${Math.round((Date.now() - ingestStartedAt) / 1000)}s)`),
    );

    // The composition a Cloud host gets: the calibrated band + the verifier on
    // the knowledgeVerifier slot. Both come from the shipped code, not from
    // numbers typed in here — the band is read from the committed calibration
    // artifact that packages/vendo's constant is tested against.
    const model = vendoModel(undefined, { slot: "knowledgeVerifier" });
    // The ladder announces which credential and model id it resolved, once,
    // on first use. Capture it so the artifact says WHAT answered rather than
    // leaving the reader to trust a comment.
    const log = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[vendo] model") && verifierModelLine === undefined) verifierModelLine = line;
      log(...args as []);
    };
    const engine = agentsetEngine(request, namespaceId, docIds);

    for (let pass = 1; pass <= PASSES; pass += 1) {
      const passStartedAt = Date.now();
      const passRecords = await pooled(all, CONCURRENCY, async (probe): Promise<Record_> => {
        // One tool registry per question so the per-turn state (verification
        // budget, memo) is per turn, exactly as it is in a real host where
        // each turn is one execute() call.
        const recorder = recordingVerifier(entailmentVerifier({ model }));
        const searches: Record_["searches"] = [];
        const observed = {
          ...engine,
          async search(query: Parameters<typeof engine.search>[0], searchCtx: Parameters<typeof engine.search>[1]) {
            const result = await engine.search(query, searchCtx);
            searches.push({
              intent: query.intent ?? "chat",
              hits: result.hits.map((hit) => ({
                docId: hit.ref.docId,
                ...(hit.score === undefined ? {} : { score: hit.score }),
              })),
            });
            return result;
          },
        };
        const tools = createKnowledgeTools(observed, {
          verifier: recorder.verifier,
          ...(TURN_BUDGET_MS === undefined ? {} : { verifyTurnBudgetMs: TURN_BUDGET_MS }),
          ...(WEAK_SCORE_THRESHOLD === undefined ? {} : { weakScoreThreshold: WEAK_SCORE_THRESHOLD }),
        });

        const startedAt = Date.now();
        const outcome = await tools.execute(
          {
            id: `call_${probe.id}`,
            tool: "vendo_knowledge_search",
            args: { query: probe.question, ...(probe.lookup === true ? { lookup: true } : {}) },
          },
          ctx(),
        );
        const latencyMs = Date.now() - startedAt;
        const envelope = envelopeOf(outcome);
        const result = typeof envelope.outcome === "string" ? envelope.outcome : `error:${outcome.status}`;
        // The whole scoring rule, in two lines, from the label and the tool's
        // own outcome: an unanswerable question that got an answer is a false
        // answer; an answerable one that got a refusal is a false refusal.
        return {
          pass,
          id: probe.id,
          label: probe.label,
          question: probe.question,
          ...(probe.lookup === true ? { lookup: true as const } : {}),
          searches,
          verifications: recorder.drain(),
          outcome: result,
          ...(typeof envelope.message === "string" ? { message: envelope.message } : {}),
          unverified: envelope.unverified === true,
          latencyMs,
          falseAnswer: probe.label === "unanswerable" && result === "answered",
          falseRefusal: probe.label === "answerable" && result === "insufficient-evidence",
        };
      });
      records.push(...passRecords);
      const falseAnswers = passRecords.filter((record) => record.falseAnswer).length;
      const falseRefusals = passRecords.filter((record) => record.falseRefusal).length;
      console.log(
        `pass ${pass}: false answers ${falseAnswers}/${all.length - answerable} · false refusals ${falseRefusals}/${answerable} · ${Math.round((Date.now() - passStartedAt) / 1000)}s`,
      );
    }
  } finally {
    sweep = await sweepNamespace(request, namespaceId);
    console.log(
      `sweep: delete ${sweep.deleted ? "confirmed" : "FAILED"}; listing ${sweep.listedStillContainsIt ? "STILL CONTAINS IT" : "confirms absent"} (${sweep.namespacesRemaining} namespaces remain)`,
    );
    if (!sweep.deleted || sweep.listedStillContainsIt) process.exitCode = 1;
  }

  // ---- aggregates, all recomputed from `records` ----
  const perPass = Array.from({ length: PASSES }, (_, index) => {
    const pass = index + 1;
    const rows = records.filter((record) => record.pass === pass);
    const unanswerable = rows.filter((row) => row.label === "unanswerable");
    const answerableRows = rows.filter((row) => row.label === "answerable");
    const verified = rows.flatMap((row) => row.verifications);
    const falseAnswers = unanswerable.filter((row) => row.falseAnswer);
    return {
      pass,
      falseAnswers: falseAnswers.length,
      unanswerable: unanswerable.length,
      // Why each false answer happened, in three exhaustive buckets — every
      // false answer lands in exactly one, and the test re-derives them.
      falseAnswersNeverVerified: falseAnswers.filter((row) => row.verifications.length === 0).length,
      falseAnswersNoVerdict: falseAnswers.filter((row) => row.verifications.length > 0 && row.unverified).length,
      falseAnswersVerifierSaidSupported:
        falseAnswers.filter((row) => row.verifications.length > 0 && !row.unverified).length,
      falseRefusals: answerableRows.filter((row) => row.falseRefusal).length,
      answerable: answerableRows.length,
      turnsVerified: rows.filter((row) => row.verifications.length > 0).length,
      verifications: verified.length,
      noVerdict: verified.filter((entry) => entry.verdict === "none").length,
      unverifiedResults: rows.filter((row) => row.unverified).length,
      // Cost inputs, counted not assumed: a turn can verify twice, so calls
      // per search and calls per VERIFIED search are different numbers and
      // both are published.
      verificationsPerSearch: rows.length === 0 ? 0 : verified.length / rows.length,
      verificationsPerVerifiedSearch:
        rows.filter((row) => row.verifications.length > 0).length === 0
          ? 0
          : verified.length / rows.filter((row) => row.verifications.length > 0).length,
      verifyLatencyMsP50: percentile(verified.map((entry) => entry.latencyMs), 50),
      verifyLatencyMsP95: percentile(verified.map((entry) => entry.latencyMs), 95),
      // Round 2: what verification costs a VERIFIED TURN is the sum of that
      // turn's calls — a chat→deep turn pays twice, so per-call percentiles
      // may never be published under a per-turn label.
      verifiedTurnVerifyMsP50: percentile(
        rows.filter((row) => row.verifications.length > 0)
          .map((row) => row.verifications.reduce((total, entry) => total + entry.latencyMs, 0)),
        50,
      ),
      verifiedTurnVerifyMsP95: percentile(
        rows.filter((row) => row.verifications.length > 0)
          .map((row) => row.verifications.reduce((total, entry) => total + entry.latencyMs, 0)),
        95,
      ),
      turnLatencyMsP50: percentile(rows.map((row) => row.latencyMs), 50),
      turnLatencyMsP95: percentile(rows.map((row) => row.latencyMs), 95),
    };
  });

  const artifact = {
    version: 1,
    engine: "agentset",
    kind: lookupOnly ? "verifier-live-lookup" : "verifier-live",
    generated: "by corpus/harness/src/knowledge-eval/verifier-live.ts — do not hand-edit",
    generatedAt: stamp,
    fidelity: {
      passages: "live Agentset search against a namespace ingested with fixtures/corpus.json",
      path: "vendo_knowledge_search via createKnowledgeTools, composed as packages/vendo composes it for a Cloud host",
      verifier: "entailmentVerifier on the shipped knowledgeVerifier model slot (real model calls)",
      verifierModel: verifierModelLine ?? "no model announcement — the ladder resolved nothing",
      outcomes: "read from the tool's own envelope; nothing hand-derived",
      namespaceId,
      sweep,
    },
    gating: "none — the verifier runs on every search that returns hits",
    turnBudgetMs: TURN_BUDGET_MS ?? KNOWLEDGE_VERIFY_TURN_BUDGET_MS,
    weakScoreThreshold: WEAK_SCORE_THRESHOLD ?? 0,
    perCallCapMs: KNOWLEDGE_VERIFY_TIMEOUT_MS,
    passes: PASSES,
    ...(limit > 0 ? { smokeRun: { probeLimit: limit, note: "PARTIAL — not the 94-question measurement" } } : {}),
    probes: all.length,
    perPass,
    records,
  };

  mkdirSync(BANDS_DIR, { recursive: true });
  const file = path.join(
    BANDS_DIR,
    process.env.LIVE_OUT ?? (lookupOnly ? "agentset-verifier-live-lookup.json" : "agentset-verifier-live.json"),
  );
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(REPO, file)}`);
  for (const pass of perPass) {
    console.log(
      `pass ${pass.pass}: false answers ${pass.falseAnswers}/${pass.unanswerable} · false refusals ${pass.falseRefusals}/${pass.answerable} · verified turns ${pass.turnsVerified}/${pass.answerable + pass.unanswerable} · no verdict ${pass.noVerdict} · verify p50 ${pass.verifyLatencyMsP50}ms p95 ${pass.verifyLatencyMsP95}ms`,
    );
  }
  const worstFalseAnswers = Math.max(...perPass.map((pass) => pass.falseAnswers));
  const worstFalseRefusals = Math.max(...perPass.map((pass) => pass.falseRefusals));
  console.log(`WORST CASE: false answers ${worstFalseAnswers} · false refusals ${worstFalseRefusals}`);
}

main().catch((error) => {
  console.error("LIVE RUN FAILED:", error);
  process.exit(1);
});
