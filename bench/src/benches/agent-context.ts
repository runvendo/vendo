import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@vendoai/store";
import { createVendo } from "@vendoai/vendo/server";
import type { LanguageModel } from "ai";
import type { Principal, RunContext } from "@vendoai/core";
import { measure, summarize } from "../stats.js";
import type { CaseResult, Suite, SuiteResult } from "../types.js";

/**
 * The thread-listing seam over a real PGlite store, driven through the door that
 * serves it: `createVendo(...).harness.threads.list`. The fix it measures slims that
 * listing — a stored title + a messages-less list projection let it derive titles without
 * loading every thread's full message array. Each seeded thread carries a chunky messages
 * array so the before/after difference (full messages vs. title-only) is visible.
 */

const THREADS = 150;
const MESSAGES_PER_THREAD = 30;
const SUBJECT = "bench_reader";
const ITERATIONS = 60;
const WARMUP = 10;

// A never-called model — this suite exercises only thread listing, not generation.
const idleModel = (): LanguageModel => ({
  specificationVersion: "v2",
  provider: "vendo-bench-idle",
  modelId: "vendo-bench-idle-v1",
  supportedUrls: {},
  async doGenerate() { throw new Error("idle model"); },
  async doStream() { throw new Error("idle model"); },
} as unknown as LanguageModel);

const message = (index: number): unknown => ({
  id: `m_${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  parts: [{ type: "text", text: `Message ${index}: ${"context ".repeat(24)}` }],
});

const seedThread = (index: number): { subject: string; messages: unknown[]; title: string } => ({
  subject: SUBJECT,
  messages: Array.from({ length: MESSAGES_PER_THREAD }, (_, m) => message(index * MESSAGES_PER_THREAD + m)),
  // Store a title so the slimmed list projection can skip the messages column.
  title: `Thread ${index} — the first user line becomes the listing title`,
});

export const agentContextSuite: Suite = {
  name: "agent-context",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const dir = await mkdtemp(join(tmpdir(), "vendo-bench-agent-"));
    const store = createStore({ dataDir: dir });
    const cases: CaseResult[] = [];
    try {
      await store.ensureSchema();
      const principal: Principal = { kind: "user", subject: SUBJECT };
      const vendo = createVendo({ models: { default: idleModel() }, principal: async () => principal, store });
      const ctx: RunContext = {
        principal,
        venue: "chat",
        presence: "present",
        sessionId: `sess_${SUBJECT}`,
      };

      for (let i = 0; i < THREADS; i += 1) {
        await store.records("vendo_threads").put({ id: `thr_bench_${i}`, data: seedThread(i) });
      }

      const list = await measure({
        warmup: WARMUP,
        iterations: ITERATIONS,
        fn: () => vendo.harness.threads.list(ctx),
      });
      cases.push(summarize("thread-list", list));
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }

    return {
      suite: "agent-context",
      kind: "deterministic",
      cases,
      notes: [`${THREADS} threads × ${MESSAGES_PER_THREAD} messages each, PGlite.`],
    };
  },
};
