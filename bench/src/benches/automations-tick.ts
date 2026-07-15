import { createAutomations } from "@vendoai/automations";
import { createGuard } from "@vendoai/guard";
import type { AppsRuntime } from "@vendoai/apps";
import type { AppDocument, Principal, ToolRegistry } from "@vendoai/core";
import { measure, summarize } from "../stats.js";
import { memoryStore } from "../fixtures/memory-store.js";
import type { CaseResult, Suite, SuiteResult } from "../types.js";

/**
 * @vendoai/automations at the tick/emit seam. Measures the per-invocation SCAN + read
 * overhead the P0 fix targets: `tick` fetches only schedule-triggered apps (indexed
 * trigger_kind ref) and batches every schedule cursor in one query instead of scanning
 * every app for every subject and doing an N+1 cursor get; `emit` fetches only the
 * subject's host-event apps. Apps are seeded so nothing is due / nothing matches, so the
 * measurement is pure dispatch overhead, free of run-execution noise.
 */

const OWNER = "bench_owner";
const SCHEDULE_APPS = 60;
const HOST_EVENT_APPS = 200;
const ITERATIONS = 100;
const WARMUP = 10;

// A minimal registry + apps port: the seeded apps never fire (schedules are not due, the
// emitted event matches nothing), so neither is actually invoked by these cases.
const benchTools = (): ToolRegistry => ({
  async descriptors() { return []; },
  async execute() { return { status: "ok", output: {} }; },
});
const benchApps = (): AppsRuntime => ({ call: async () => ({ status: "ok", output: {} }) } as unknown as AppsRuntime);

const scheduleDoc = (index: number): AppDocument => ({
  format: "vendo/app@1",
  id: `app_sched_${index}`,
  name: `Scheduled ${index}`,
  // Never due within a tick: every-1h with a cursor freshly set on the first (warmup) tick.
  trigger: { on: { kind: "schedule", every: "1h" }, run: { kind: "agentic", prompt: "noop" } },
});

const hostEventDoc = (index: number): AppDocument => ({
  format: "vendo/app@1",
  id: `app_host_${index}`,
  name: `HostEvent ${index}`,
  trigger: { on: { kind: "host-event", event: "bench.never" }, run: { kind: "agentic", prompt: "noop" } },
});

async function seed(store: ReturnType<typeof memoryStore>): Promise<void> {
  const put = (doc: AppDocument): Promise<unknown> => store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: OWNER, enabled: true, doc },
    refs: { subject: OWNER, trigger_kind: doc.trigger?.on.kind ?? "" },
  });
  for (let i = 0; i < SCHEDULE_APPS; i += 1) await put(scheduleDoc(i));
  for (let i = 0; i < HOST_EVENT_APPS; i += 1) await put(hostEventDoc(i));
}

export const automationsTickSuite: Suite = {
  name: "automations-tick",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const store = memoryStore();
    const guard = createGuard({ store });
    const automations = createAutomations({ apps: benchApps(), tools: benchTools(), guard, store });
    await seed(store);

    const principal: Principal = { kind: "user", subject: OWNER };

    const tick = await measure({
      warmup: WARMUP,
      iterations: ITERATIONS,
      fn: () => automations.tick(),
    });
    const emit = await measure({
      warmup: WARMUP,
      iterations: ITERATIONS,
      fn: () => automations.emit("bench.no-match", { at: Date.now() }, principal),
    });

    const cases: CaseResult[] = [
      summarize("tick", tick),
      summarize("emit", emit),
    ];
    return {
      suite: "automations-tick",
      kind: "deterministic",
      cases,
      notes: [`${SCHEDULE_APPS} schedule + ${HOST_EVENT_APPS} host-event apps for one owner; nothing due/matching.`],
    };
  },
};
