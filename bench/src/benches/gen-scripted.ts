import { createApps } from "@vendoai/apps";
import { createGuard } from "@vendoai/guard";
import { measure, summarize } from "../stats.js";
import { appGenerationModel } from "../fixtures/scripted-model.js";
import { memoryStore } from "../fixtures/memory-store.js";
import { benchContext, benchTools } from "../fixtures/tools.js";
import type { Suite, SuiteResult } from "../types.js";

/**
 * create() total latency with the scripted model — the deterministic engine
 * overhead (parse → validate tree → validate app document → persist → audit),
 * i.e. everything create() does except the LLM round trip.
 */
export const genScriptedSuite: Suite = {
  name: "gen-scripted",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const store = memoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(benchTools());
    const apps = createApps({ store, guard, tools: bound, catalog: [], model: appGenerationModel() });
    const ctx = benchContext("bench_user");

    const durations = await measure({
      warmup: 10,
      iterations: 60,
      fn: () => apps.create({ prompt: "an items dashboard" }, ctx),
    });

    return {
      suite: "gen-scripted",
      kind: "deterministic",
      cases: [summarize("create", durations)],
      notes: ["Scripted model — measures engine overhead only, no LLM."],
    };
  },
};
