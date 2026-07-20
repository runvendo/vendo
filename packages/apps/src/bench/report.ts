/**
 * W1-bench (docs/verification/w1-bench) — per-arm aggregation, significance,
 * and markdown/JSON artifact writing. Raw per-sample records are persisted so
 * every number in VERDICTS.md is reproducible.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WireMetrics } from "./metrics.js";
import type { Judgement } from "./judge.js";

export interface Sample {
  prompt: string;
  wire: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  genError?: string;
  metrics: WireMetrics;
  judge: Judgement;
}

export interface ArmSummary {
  arm: string;
  n: number;
  compileOkRate: number;
  meanRefErrors: number;
  refErrorFreeRate: number;
  meanBindingShapeErrors: number;
  declaredUnusedRate: number;
  formatMissRate: number;
  meanFormatMiss: number;
  fabricationRate: number;
  answersAskRate: number;
  meanQuality: number;
  qualityStdev: number;
  p50OutputTokens: number;
  p50LatencyMs: number;
  errorRate: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const p50 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export const summarize = (arm: string, samples: Sample[]): ArmSummary => {
  const ok = samples.filter((s) => !s.genError);
  return {
    arm,
    n: samples.length,
    compileOkRate: rate(ok.map((s) => s.metrics.compileOk)),
    meanRefErrors: mean(ok.map((s) => s.metrics.refErrors)),
    refErrorFreeRate: rate(ok.map((s) => s.metrics.refErrors === 0 && s.metrics.compileOk)),
    meanBindingShapeErrors: mean(ok.map((s) => s.metrics.bindingShapeErrors)),
    declaredUnusedRate: rate(ok.map((s) => s.metrics.declaredButUnused > 0)),
    formatMissRate: rate(ok.map((s) => s.metrics.formatMiss > 0)),
    meanFormatMiss: mean(ok.map((s) => s.metrics.formatMiss)),
    fabricationRate: rate(ok.map((s) => s.judge.fabricated)),
    answersAskRate: rate(ok.map((s) => s.judge.answersAsk)),
    meanQuality: mean(ok.map((s) => s.judge.quality)),
    qualityStdev: stdev(ok.map((s) => s.judge.quality)),
    p50OutputTokens: p50(ok.map((s) => s.outputTokens)),
    p50LatencyMs: p50(ok.map((s) => s.ms)),
    errorRate: rate(samples.map((s) => Boolean(s.genError))),
  };
};

/** Welch-style significance of the quality-mean difference between two arms.
 *  Returns |difference| and whether it exceeds the combined standard error ×2
 *  (~95%). A coarse but honest "outside noise?" gate for small n. */
export const qualityDiffOutsideNoise = (a: Sample[], b: Sample[]): { diff: number; se: number; outside: boolean } => {
  const qa = a.filter((s) => !s.genError).map((s) => s.judge.quality);
  const qb = b.filter((s) => !s.genError).map((s) => s.judge.quality);
  const diff = mean(qa) - mean(qb);
  const va = qa.length > 1 ? stdev(qa) ** 2 / qa.length : 0;
  const vb = qb.length > 1 ? stdev(qb) ** 2 / qb.length : 0;
  const se = Math.sqrt(va + vb);
  return { diff, se, outside: Math.abs(diff) > 2 * se && se > 0 };
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number) => x.toFixed(2);

export const armTableRows = (rows: ArmSummary[]): string => {
  const header = `| arm | n | compile-ok | ref-error-free | mean ref-err | mean binding-err | declared-unused | format-miss | fabrication | answers-ask | mean quality (sd) | p50 out-tok | p50 latency |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|`;
  const body = rows
    .map((r) =>
      `| ${r.arm} | ${r.n} | ${pct(r.compileOkRate)} | ${pct(r.refErrorFreeRate)} | ${f2(r.meanRefErrors)} | ${f2(r.meanBindingShapeErrors)} | ${pct(r.declaredUnusedRate)} | ${pct(r.formatMissRate)} | ${pct(r.fabricationRate)} | ${pct(r.answersAskRate)} | ${f2(r.meanQuality)} (${f2(r.qualityStdev)}) | ${r.p50OutputTokens} | ${(r.p50LatencyMs / 1000).toFixed(1)}s |`,
    )
    .join("\n");
  return `${header}\n${body}`;
};

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/apps/src/bench -> repo root
export const RAW_DIR = join(HERE, "../../../../docs/verification/w1-bench/raw");

export const writeRaw = (name: string, data: unknown): string => {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
};
