import { createAnthropic } from "@ai-sdk/anthropic";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  entailmentVerifier,
  inVerifyBand,
  KNOWLEDGE_VERIFY_TIMEOUT_MS,
  structuralChunker,
  type KnowledgeVerifier,
} from "@vendoai/knowledge";
import { defaultWorkspaceRoot, loadFixtureCorpus, type FixtureCorpus } from "./data.js";

/**
 * Knowledge K14 T4 — the measured proof.
 *
 * The claim under test: inside the band, a cheap model reading the passages
 * beats the score. The baseline is the cloud calibration's own finding — at
 * the shipped bar 0.7211, 16 of 34 unanswerable questions get a confident
 * answer (47%) and 7 of 60 answerable ones are refused (12%).
 *
 * WHAT IS REAL AND WHAT IS REPLAYED (read this before quoting a number):
 * - Real: the questions and the corpus are the byte-identical files the live
 *   Agentset run used, and every question's band placement comes from that
 *   run's measured deep-intent top score (bands/agentset-deep-scores.json).
 * - Real: the verifier is the shipped one, on the shipped judge-slot model.
 * - Replayed: the PASSAGES. The committed measurements record scores and the
 *   top document, not the returned text, and this repo cannot reach Agentset
 *   (no key, and the client lives in vendo-web). So the passage set is
 *   reconstructed by dense retrieval over the same corpus with the house
 *   chunker, and the report states how often that retriever's top document
 *   agrees with Agentset's — plus the same headline numbers computed on the
 *   agreeing subset alone, which is the sensitivity check on this substitution.
 *
 * Run (spends real model money; never part of pnpm test):
 *   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… \
 *     pnpm --filter @vendoai/corpus-harness knowledge-verifier-replay
 */

/** The shipped cloud calibration (packages/vendo/src/server.ts). */
const SHIPPED_BAR = 0.7211;
const BAND = { low: 0.6735, high: 0.7835 };

/** The tool's own citation sizing (agent-tools.ts): five hits, 280 chars. */
const MAX_HITS = 5;
const MAX_SNIPPET_CHARS = 280;

const EMBED_MODEL = "text-embedding-3-small";
/** The family's cheap judge pick on the Anthropic rung (dev-creds/model.ts). */
const VERIFIER_MODEL = "claude-haiku-4-5";
/** Concurrency for the verification pass. Latency is reported per call; the
    provider parallelises, so this bounds wall clock without distorting it
    much — stated in the report rather than hidden. */
const CONCURRENCY = 4;

interface ScoreRow {
  id: string;
  population: "answerable" | "unanswerable";
  question: string;
  topScore: number;
  topDocId: string;
  topIsExpected: boolean;
  expectedDocIds: string[];
}

interface Passage {
  docId: string;
  chunkId: string;
  title?: string;
  snippet: string;
}

interface ReplayRow extends ScoreRow {
  placement: "below" | "band" | "above";
  /** The replay retriever's top document, for the fidelity check. */
  replayTopDocId: string;
  agreesWithAgentset: boolean;
  passages: Passage[];
  /** undefined outside the band, or when the verifier gave no verdict. */
  supported?: boolean;
  verifyMs?: number;
  /** The tool outcome each policy produces for this question. */
  baselineAnswered: boolean;
  verifiedAnswered: boolean;
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index]! * b[index]!;
  return dot; // OpenAI embeddings are unit-normalised, so the dot product IS cosine.
};

async function embed(texts: string[], apiKey: string): Promise<number[][]> {
  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += 96) {
    const batch = texts.slice(start, start + 96);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    });
    if (!response.ok) throw new Error(`embeddings failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
    for (const item of body.data.sort((a, b) => a.index - b.index)) out.push(item.embedding);
  }
  return out;
}

/** The retrievable unit: one chunk of one PUBLIC document. The eval principal
    never sets includeInternal, so internal fixture docs are invisible here
    exactly as they are to the agent. */
function retrievableChunks(corpus: FixtureCorpus): Array<Passage & { text: string }> {
  const units: Array<Passage & { text: string }> = [];
  for (const doc of corpus.docs) {
    if (doc.visibility === "internal") continue;
    for (const chunk of structuralChunker.chunk(doc)) {
      units.push({
        docId: doc.id,
        chunkId: chunk.chunkId,
        ...(doc.title === undefined ? {} : { title: doc.title }),
        snippet: chunk.text.length <= MAX_SNIPPET_CHARS ? chunk.text : `${chunk.text.slice(0, MAX_SNIPPET_CHARS)}…`,
        text: `${doc.title ?? ""}\n${chunk.heading ?? ""}\n${chunk.text}`.trim(),
      });
    }
  }
  return units;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
};

/** false answers / false refusals for one policy, as counts and rates. */
function rates(rows: ReplayRow[], answered: (row: ReplayRow) => boolean) {
  const unanswerable = rows.filter((row) => row.population === "unanswerable");
  const answerable = rows.filter((row) => row.population === "answerable");
  const falseAnswers = unanswerable.filter(answered).length;
  const falseRefusals = answerable.filter((row) => !answered(row)).length;
  return {
    falseAnswers,
    falseAnswerRate: falseAnswers / unanswerable.length,
    falseRefusals,
    falseRefusalRate: falseRefusals / answerable.length,
    unanswerable: unanswerable.length,
    answerable: answerable.length,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

export interface ReplayResult {
  rows: ReplayRow[];
  report: Record<string, unknown>;
}

export async function runVerifierReplay(options: {
  workspaceRoot?: string;
  openaiKey: string;
  anthropicKey: string;
  log?: (line: string) => void;
}): Promise<ReplayResult> {
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot;
  const log = options.log ?? ((line: string) => console.log(line));
  const bandsDir = path.join(workspaceRoot, "docs", "eval", "knowledge", "bands");

  const scores = JSON.parse(await readFile(path.join(bandsDir, "agentset-deep-scores.json"), "utf8")) as {
    scores: ScoreRow[];
    source: Record<string, unknown>;
  };
  const corpus = await loadFixtureCorpus();
  const units = retrievableChunks(corpus);
  log(`corpus: ${corpus.docs.length} docs → ${units.length} retrievable chunks · questions: ${scores.scores.length}`);

  // Retrieval reconstruction, cached so a re-run costs nothing.
  const cachePath = path.join(workspaceRoot, "evidence", "verifier-replay-retrieval.json");
  let retrieved: Record<string, Passage[]>;
  try {
    retrieved = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, Passage[]>;
    log(`retrieval: reusing cache (${Object.keys(retrieved).length} questions)`);
  } catch {
    log(`retrieval: embedding ${units.length} chunks + ${scores.scores.length} questions (${EMBED_MODEL})`);
    const chunkVectors = await embed(units.map((unit) => unit.text), options.openaiKey);
    const questionVectors = await embed(scores.scores.map((row) => row.question), options.openaiKey);
    retrieved = {};
    scores.scores.forEach((row, index) => {
      const query = questionVectors[index]!;
      retrieved[row.id] = units
        .map((unit, unitIndex) => ({ unit, score: cosine(query, chunkVectors[unitIndex]!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_HITS)
        .map(({ unit }) => ({
          docId: unit.docId,
          chunkId: unit.chunkId,
          ...(unit.title === undefined ? {} : { title: unit.title }),
          snippet: unit.snippet,
        }));
    });
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(retrieved, null, 2)}\n`);
  }

  // The cap is measured, not assumed: run with a generous one to see the
  // uncensored latency distribution, then set the shipped default from it.
  // A call that hits the cap yields no verdict and falls open, so the report
  // counts those too (verifier.noVerdict).
  const timeoutMs = Number(process.env["VERIFY_TIMEOUT_MS"] ?? KNOWLEDGE_VERIFY_TIMEOUT_MS);
  const verifier: KnowledgeVerifier = entailmentVerifier({
    model: createAnthropic({ apiKey: options.anthropicKey })(VERIFIER_MODEL),
    timeoutMs,
  });

  const banded = scores.scores.filter((row) => inVerifyBand(row.topScore, BAND));
  log(`band: ${banded.length}/${scores.scores.length} questions land inside [${BAND.low}, ${BAND.high}] — those pay a verification`);

  // A model verdict is not deterministic, so one pass would be a claim about
  // one sample. The report carries every pass and their spread; the headline
  // is the range, never the best of them.
  const passes = Number(process.env["REPLAY_PASSES"] ?? 3);
  const runs: ReplayRow[][] = [];
  for (let pass = 0; pass < passes; pass += 1) {
    runs.push(await verifyPass(scores.scores));
    const latest = rates(runs[pass]!, (row) => row.verifiedAnswered);
    log(`pass ${pass + 1}/${passes}: false answers ${latest.falseAnswers}/${latest.unanswerable} · false refusals ${latest.falseRefusals}/${latest.answerable}`);
  }
  const rows = runs[0]!;

  async function verifyPass(source: ScoreRow[]): Promise<ReplayRow[]> {
    return mapLimit(source, CONCURRENCY, async (row): Promise<ReplayRow> => {
      const passages = retrieved[row.id] ?? [];
      const placement = inVerifyBand(row.topScore, BAND)
        ? "band"
        : row.topScore < BAND.low
          ? "below"
          : "above";
      const baselineAnswered = row.topScore >= SHIPPED_BAR;

      let supported: boolean | undefined;
      let verifyMs: number | undefined;
      if (placement === "band") {
        const started = Date.now();
        supported = await verifier.supported({ question: row.question, passages });
        verifyMs = Date.now() - started;
      }

      // The shipped policy: above the band answer, below refuse, inside take
      // the verdict — and with no verdict, fall open to the threshold.
      const verifiedAnswered = placement === "above"
        ? true
        : placement === "below"
          ? false
          : supported ?? baselineAnswered;

      return {
        ...row,
        placement,
        replayTopDocId: passages[0]?.docId ?? "",
        agreesWithAgentset: passages[0]?.docId === row.topDocId,
        passages,
        ...(supported === undefined ? {} : { supported }),
        ...(verifyMs === undefined ? {} : { verifyMs }),
        baselineAnswered,
        verifiedAnswered,
      };
    });
  }

  const latencies = runs.flat().map((row) => row.verifyMs).filter((value): value is number => value !== undefined);
  const agreeing = rows.filter((row) => row.agreesWithAgentset);
  const answerableRows = rows.filter((row) => row.population === "answerable");
  const noVerdict = runs.flat().filter((row) => row.placement === "band" && row.supported === undefined);
  const perPass = runs.map((pass) => rates(pass, (row) => row.verifiedAnswered));
  const spread = (pick: (value: ReturnType<typeof rates>) => number) => {
    const values = perPass.map(pick);
    return { min: Math.min(...values), max: Math.max(...values) };
  };

  const report = {
    version: 1,
    engine: "agentset",
    kind: "verifier-replay",
    generated: "by corpus/harness/src/knowledge-eval/verifier-replay.ts",
    fidelity: {
      note: "Band placement and the questions are the live Agentset run's; the passages are reconstructed by dense retrieval over the identical corpus (see the module doc). The two retrievers pick DIFFERENT top documents about half the time but are right about equally often, which is the fidelity that matters: the replay is not an easier corpus.",
      retriever: EMBED_MODEL,
      topDocAgreementWithAgentset: agreeing.length / rows.length,
      agreeingQuestions: agreeing.length,
      totalQuestions: rows.length,
      agentsetTopDocInReplayTop5: rows.filter((row) => row.passages.some((passage) => passage.docId === row.topDocId)).length,
      /** Retrieval quality against the golden set's expected documents, the
          like-for-like comparison with the live run's own sanity numbers. */
      replayTop1Correct: answerableRows.filter((row) => row.expectedDocIds.includes(row.passages[0]?.docId ?? "")).length,
      replayRecallAt5: answerableRows.filter((row) => row.passages.some((passage) => row.expectedDocIds.includes(passage.docId))).length,
      agentsetTop1Correct: answerableRows.filter((row) => row.topIsExpected).length,
      answerableQuestions: answerableRows.length,
    },
    verifier: {
      model: VERIFIER_MODEL,
      timeoutMs,
      concurrency: CONCURRENCY,
      passes,
      /** Verifications that crossed the cap or came back unusable, over all
          passes — each one fell open to the threshold. */
      noVerdict: noVerdict.length,
    },
    band: { ...BAND, shippedBar: SHIPPED_BAR },
    cost: {
      bandHits: rows.filter((row) => row.placement === "band").length,
      bandHitRate: rows.filter((row) => row.placement === "band").length / rows.length,
      verifications: latencies.length,
      latencyMsP50: percentile(latencies, 50),
      latencyMsP95: percentile(latencies, 95),
      latencyMsMax: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
    before: rates(rows, (row) => row.baselineAnswered),
    after: {
      /** Pass 1, kept whole for inspection; the spread below is the claim. */
      ...perPass[0]!,
      falseAnswersAcrossPasses: spread((value) => value.falseAnswers),
      falseAnswerRateAcrossPasses: spread((value) => value.falseAnswerRate),
      falseRefusalsAcrossPasses: spread((value) => value.falseRefusals),
      falseRefusalRateAcrossPasses: spread((value) => value.falseRefusalRate),
      perPass,
    },
    sensitivityOnAgreeingSubset: {
      note: "The same two policies over only the questions where the replay retriever's top document matches Agentset's — the subset where the reconstructed evidence is demonstrably the real evidence.",
      before: rates(agreeing, (row) => row.baselineAnswered),
      after: rates(agreeing, (row) => row.verifiedAnswered),
    },
    source: scores.source,
  };

  return { rows, report };
}

async function main(): Promise<void> {
  const openaiKey = process.env["OPENAI_API_KEY"];
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (!openaiKey || !anthropicKey) {
    console.error("OPENAI_API_KEY (retrieval reconstruction) and ANTHROPIC_API_KEY (the verifier) are both required.");
    process.exit(1);
  }
  const { rows, report } = await runVerifierReplay({ openaiKey, anthropicKey });
  const workspaceRoot = defaultWorkspaceRoot;
  const out = path.join(workspaceRoot, "docs", "eval", "knowledge", "bands", "agentset-verifier-replay.json");
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  await mkdir(path.join(workspaceRoot, "evidence"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "evidence", "verifier-replay-rows.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${path.relative(workspaceRoot, out)}`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
