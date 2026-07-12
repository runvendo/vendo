import { createApps } from "@vendoai/apps";
import { createGuard } from "@vendoai/guard";
import { measure, summarize } from "../stats.js";
import { appGenerationModel } from "../fixtures/scripted-model.js";
import { memoryStore } from "../fixtures/memory-store.js";
import { benchContext, benchTools } from "../fixtures/tools.js";
import type { Suite, SuiteResult } from "../types.js";

/**
 * @vendoai/apps at the API seam: createApps over a memory store + guard-bound
 * registry + scripted model. Measures open() (validate + guard-resolved query
 * fetch) and call() (a guard-bound host-tool call). The HTTP wire routes (09)
 * live in the umbrella built in a parallel wave, so v0-perf measures at the
 * API seam; HTTP-layer p95 gets added when the umbrella lands.
 */
export const appsApiSuite: Suite = {
  name: "apps-api",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const store = memoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(benchTools());
    const apps = createApps({ store, guard, tools: bound, catalog: [], model: appGenerationModel() });
    const ctx = benchContext("bench_user");

    const app = await apps.create({ prompt: "an items dashboard" }, ctx);

    const open = await measure({
      warmup: 10,
      iterations: 100,
      fn: () => apps.open(app.id, ctx),
    });
    const call = await measure({
      warmup: 10,
      iterations: 100,
      fn: (i) => apps.call(app.id, "host_noop", { i }, ctx),
    });

    return {
      suite: "apps-api",
      kind: "deterministic",
      cases: [summarize("open", open), summarize("call", call)],
      notes: ["Measured at the API seam; HTTP wire routes (09) land with the umbrella."],
    };
  },
};
