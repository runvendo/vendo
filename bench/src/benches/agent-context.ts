import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "@vendoai/agent";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import type { RunContext, ToolRegistry } from "@vendoai/core";
import { measure, summarize } from "../stats.js";
import type { CaseResult, Suite, SuiteResult } from "../types.js";

/**
 * @vendoai/agent context seam over a real PGlite store. Measures `threads.list`, which the
 * fix slims: a stored title + a messages-less list projection let the listing derive titles
 * without loading every thread's full message array. Each seeded thread carries a chunky
 * messages array so the before/after difference (full messages vs. title-only) is visible.
 */

const THREADS = 150;
const MESSAGES_PER_THREAD = 30;
const SUBJECT = "bench_reader";
const ITERATIONS = 60;
const WARMUP = 10;

const emptyTools = (): ToolRegistry => ({
  async descriptors() { return []; },
  async execute() { return { status: "ok", output: {} }; },
});

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
      const guard = createGuard({ store });
      const agent = createAgent({ model: idleModel(), tools: emptyTools(), guard, store });
      const ctx: RunContext = {
        principal: { kind: "user", subject: SUBJECT },
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
        fn: () => agent.threads.list(ctx),
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
