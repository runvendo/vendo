import { performance } from "node:perf_hooks";
import type { CaseResult } from "./types.js";

/**
 * Linear-interpolation percentile over an unsorted sample (the "R-7" method,
 * matching NumPy's default and Excel PERCENTILE.INC). `p` is a fraction 0..1.
 * An empty sample returns 0 (callers never summarize zero-iteration runs).
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0]!;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low]!;
  if (low === high) return lowValue;
  const weight = rank - low;
  return lowValue + (sorted[high]! - lowValue) * weight;
}

export interface MeasureOptions {
  /** Discarded iterations run before measurement to warm JIT/allocators. */
  warmup: number;
  /** Measured iterations. */
  iterations: number;
  /** One unit of work; its wall-clock duration (ms) is recorded. */
  fn: (index: number) => unknown | Promise<unknown>;
}

/** Run warmup then measured iterations, returning the per-iteration durations (ms). */
export async function measure(options: MeasureOptions): Promise<number[]> {
  for (let i = 0; i < options.warmup; i += 1) await options.fn(i);
  const durations: number[] = [];
  for (let i = 0; i < options.iterations; i += 1) {
    const start = performance.now();
    await options.fn(i);
    durations.push(performance.now() - start);
  }
  return durations;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Summarize a duration sample into a named CaseResult (values rounded to µs). */
export function summarize(name: string, durations: readonly number[]): CaseResult {
  return {
    name,
    unit: "ms",
    samples: durations.length,
    p50: round(percentile(durations, 0.5)),
    p95: round(percentile(durations, 0.95)),
    min: round(durations.length === 0 ? 0 : Math.min(...durations)),
    max: round(durations.length === 0 ? 0 : Math.max(...durations)),
  };
}
