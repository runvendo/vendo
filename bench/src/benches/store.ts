import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type VendoStore } from "@vendoai/store";
import { measure, summarize } from "../stats.js";
import type { CaseResult, Suite, SuiteResult } from "../types.js";

const ITERATIONS = 200;
const WARMUP = 20;

const record = (index: number) => ({
  id: `bench_${index}`,
  data: { name: `Item ${index}`, total: index * 3, tags: ["a", "b", "c"] },
  refs: { subject: "bench_user" },
});

async function benchStore(store: VendoStore, label: string): Promise<CaseResult[]> {
  const collection = store.records("bench_records");
  // Seed a page so get/list have something to hit.
  for (let i = 0; i < ITERATIONS; i += 1) await collection.put(record(i));

  const put = await measure({
    warmup: WARMUP,
    iterations: ITERATIONS,
    fn: (i) => collection.put(record(ITERATIONS + i)),
  });
  const get = await measure({
    warmup: WARMUP,
    iterations: ITERATIONS,
    fn: (i) => collection.get(`bench_${i % ITERATIONS}`),
  });
  const list = await measure({
    warmup: WARMUP,
    iterations: ITERATIONS,
    fn: () => collection.list({ refs: { subject: "bench_user" }, limit: 20 }),
  });

  return [
    summarize(`put-${label}`, put),
    summarize(`get-${label}`, get),
    summarize(`list-${label}`, list),
  ];
}

/**
 * @vendoai/store round-trips. Always runs the PGlite leg in a temp dir; also
 * runs the Postgres leg when POSTGRES_URL is set (the 02 gating convention).
 * Budgets gate the PGlite leg only — Postgres timing is environment-specific.
 */
export const storeSuite: Suite = {
  name: "store",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const cases: CaseResult[] = [];
    const notes: string[] = [];

    const dir = await mkdtemp(join(tmpdir(), "vendo-bench-store-"));
    const pglite = createStore({ dataDir: dir });
    try {
      await pglite.ensureSchema();
      cases.push(...(await benchStore(pglite, "pglite")));
    } finally {
      await pglite.close();
      await rm(dir, { recursive: true, force: true });
    }

    const url = process.env.POSTGRES_URL;
    if (url) {
      const pg = createStore({ url });
      try {
        await pg.ensureSchema();
        cases.push(...(await benchStore(pg, "postgres")));
        notes.push("Postgres leg ran (POSTGRES_URL set); not budget-gated.");
      } finally {
        await pg.close();
      }
    } else {
      notes.push("Postgres leg skipped — POSTGRES_URL not set.");
    }

    return { suite: "store", kind: "deterministic", cases, notes };
  },
};
