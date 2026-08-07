/** Shared shapes for the bench harness. */

export type SuiteKind = "deterministic" | "live";

/** One measured metric: percentile summary over a sample of durations (ms). */
export interface CaseResult {
  name: string;
  unit: "ms";
  samples: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

/** The outcome of running one suite. `skipped` suites carry a human reason and no cases. */
export interface SuiteResult {
  suite: string;
  kind: SuiteKind;
  cases: CaseResult[];
  skipped?: boolean;
  reason?: string;
  notes?: string[];
}

/** A registered benchmark suite. `run` performs warmup + measurement and summarizes. */
export interface Suite {
  name: string;
  kind: SuiteKind;
  run(): Promise<SuiteResult>;
}

export interface BenchReport {
  machine: string;
  date: string;
  node: string;
  suites: SuiteResult[];
}
