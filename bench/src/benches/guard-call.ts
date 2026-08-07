import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@vendoai/store";
import { createGuard } from "@vendoai/guard";
import { measure, summarize } from "../stats.js";
import { benchContext, benchTools } from "../fixtures/tools.js";
import type { Suite, SuiteResult } from "../types.js";

/**
 * The 05 §2 choke point: createGuard over a PGlite store, guard.bind() the
 * no-op registry, and drive N calls through the bound registry — decide →
 * execute → report (each report is an audit row written to the store). This is
 * the guard-bound tool-call wire-path proxy.
 */
export const guardCallSuite: Suite = {
  name: "guard-call",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const dir = await mkdtemp(join(tmpdir(), "vendo-bench-guard-"));
    const store = createStore({ dataDir: dir });
    try {
      await store.ensureSchema();
      const guard = createGuard({ store });
      const bound = guard.bind(benchTools());
      const ctx = benchContext("bench_user");

      const durations = await measure({
        warmup: 20,
        iterations: 200,
        fn: (i) => bound.execute({ id: `call_${i}`, tool: "host_noop", args: { i } }, ctx),
      });
      return {
        suite: "guard-call",
        kind: "deterministic",
        cases: [summarize("call", durations)],
        notes: ["decide → execute → report over a PGlite-backed guard; audit row written per call."],
      };
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
};
