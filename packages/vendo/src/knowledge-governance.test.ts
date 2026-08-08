import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import {
  DEFAULT_TRIGGER_ID,
  descriptorHash,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type KnowledgeAdapter,
  type KnowledgeContext,
  type KnowledgeQuery,
  type Principal,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";

/** Knowledge k8 T5 (ENG-370, KB-COV-7) — the visibility governance proofs:
 * `internal` is unreachable from end-user principals in EVERY venue. Each leg
 * drives the venue's REAL tool path (never the adapter directly) against a
 * corpus seeded with an internal doc that matches the query, and asserts zero
 * leakage plus the venue's audit row. The MCP leg lives in fixtures/mcp-e2e
 * (the door needs its OAuth stack); the trusted-composition proof at the
 * bottom shows includeInternal works exactly where the HOST wires it. */

const INTERNAL_ID = "internal-fraud-runbook";
const INTERNAL_MARKER = "SAR checklist";
const PUBLIC_ID = "docs-escalations";

const corpus = () => [
  {
    id: PUBLIC_ID,
    kind: "docs" as const,
    visibility: "public" as const,
    title: "Escalating a dispute",
    text: "Customers can request an escalation of a dispute from the transaction detail view; escalation review takes two business days.",
    source: "help.maple.bank/disputes/escalation",
  },
  {
    id: INTERNAL_ID,
    kind: "docs" as const,
    visibility: "internal" as const,
    title: "Fraud escalation runbook (internal)",
    text: "INTERNAL: on a fraud escalation, freeze the card, page the on-call risk analyst, and file the SAR checklist within 24 hours.",
    source: "wiki.maple.internal/risk/fraud-runbook",
  },
];

/** Records every KnowledgeContext the venue path hands the adapter, so each
    leg can also pin the R5 invariant: includeInternal is NEVER set on a
    principal-carrying path. */
function spyAdapter(): KnowledgeAdapter & { contexts: KnowledgeContext[]; servedDocIds: string[] } {
  const base = memoryKnowledgeAdapter({ docs: corpus() });
  const contexts: KnowledgeContext[] = [];
  const servedDocIds: string[] = [];
  return {
    ...base,
    posture: base.posture,
    contexts,
    servedDocIds,
    async search(query: KnowledgeQuery, ctx: KnowledgeContext) {
      contexts.push(structuredClone(ctx));
      const result = await base.search(query, ctx);
      servedDocIds.push(...result.hits.map((hit) => hit.ref.docId));
      return result;
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const principal: Principal = { kind: "user", subject: "user_governance" };

async function compose(config: Partial<CreateVendoConfig> = {}): Promise<Vendo> {
  return createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store: await tempStore("vendo-knowledge-gov-"),
    ...config,
  });
}

/** A model scripted to call vendo_knowledge_search once, then reply — the
    chat venue's real tool path (agent loop → guard-bound registry). */
async function knowledgeCallingModel(): Promise<{ model: LanguageModel; prompts: string[] }> {
  const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
  const prompts: string[] = [];
  let call = 0;
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      const searching = call === 0;
      call += 1;
      return {
        stream: simulateReadableStream({
          // Spread so the chunk element type is inferred from BOTH branches:
          // handed the conditional directly, `simulateReadableStream<T>` resolves
          // `T` from the first arm alone and then rejects the second.
          chunks: [...(searching
            ? [
              { type: "tool-call" as const, toolCallId: "call_kb", toolName: "vendo_knowledge_search", input: JSON.stringify({ query: "escalation" }) },
              { type: "finish" as const, usage, finishReason: { unified: "tool-calls" as const, raw: undefined } },
            ]
            : [
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: "Done." },
              { type: "text-end" as const, id: "t1" },
              { type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: undefined } },
            ])],
        }),
      };
    },
  });
  return { model: model as unknown as LanguageModel, prompts };
}

async function auditRow(vendo: Vendo, venue: string): Promise<boolean> {
  const { events } = await vendo.guard.audit.query({ principal });
  return events.some((event) => event.kind === "tool-call" && event.tool === "vendo_knowledge_search" && event.venue === venue);
}

describe("visibility governance — venue leakage matrix (k8 T5)", () => {
  it("chat: the agent's tool call surfaces only public hits and never sets includeInternal", async () => {
    const adapter = spyAdapter();
    const { model, prompts } = await knowledgeCallingModel();
    const vendo = await compose({ model, knowledge: adapter });

    const turn = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_gov_chat",
        message: { id: "m_gov_chat", role: "user", parts: [{ type: "text", text: "How do escalations work?" }] },
      }),
    }));
    expect(turn.status).toBe(200);
    const streamed = await turn.text();

    // The tool ran (second model call carries its result) and answered from
    // the PUBLIC doc — the internal doc matching the same query never appears
    // anywhere the model or the client can see.
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).toContain(PUBLIC_ID);
    for (const surface of [prompts[1]!, streamed]) {
      expect(surface).not.toContain(INTERNAL_ID);
      expect(surface).not.toContain(INTERNAL_MARKER);
    }
    expect(adapter.contexts.length).toBeGreaterThan(0);
    for (const ctx of adapter.contexts) expect(ctx.includeInternal).toBeUndefined();
    expect(await auditRow(vendo, "chat")).toBe(true);
  });

  it("app: a live-view query binds only public hits into the opened tree", async () => {
    const adapter = spyAdapter();
    const vendo = await compose({ knowledge: adapter });
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_gov_kb",
      name: "Escalation helper",
      ui: "tree",
      tree: {
        formatVersion: VENDO_TREE_FORMAT,
        root: "root",
        nodes: [{ id: "root", component: "Text", props: { text: { $path: "/kb/hits/0/snippet" } } }],
        queries: [{ name: "kb", tool: "vendo_knowledge_search", input: { query: "escalation" } }],
      },
    };
    await vendo.store.ensureSchema();
    await vendo.store.records("vendo_apps").put({
      id: doc.id,
      data: { subject: principal.subject, enabled: true, doc },
      refs: { subject: principal.subject },
    });

    const response = await vendo.handler(new Request("https://host.test/api/vendo/apps/app_gov_kb/open"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(PUBLIC_ID);
    expect(body).not.toContain(INTERNAL_ID);
    expect(body).not.toContain(INTERNAL_MARKER);
    for (const ctx of adapter.contexts) expect(ctx.includeInternal).toBeUndefined();
    expect(await auditRow(vendo, "app")).toBe(true);
  });

  it("automation: a granted away step run reaches the tool and still sees only public docs", async () => {
    const adapter = spyAdapter();
    const vendo = await compose({ knowledge: adapter });
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_gov_auto",
      name: "Escalation digest",
      triggers: [{
        id: DEFAULT_TRIGGER_ID,
        on: { kind: "host-event", event: "gov-check" },
        // Step args are JSONata expressions — a literal query needs quotes.
        run: { kind: "steps", steps: [{ id: "kb", tool: "vendo_knowledge_search", args: { query: "'escalation'" } }] },
      }],
    };
    await vendo.store.ensureSchema();
    await vendo.store.records("vendo_apps").put({
      id: doc.id,
      data: { subject: principal.subject, enabled: true, doc },
      refs: { subject: principal.subject, trigger_kind: "host-event" },
    });
    // Away automation runs execute only under a standing grant (05 §2) — seed
    // one, exactly what enable() would have minted on approval.
    const descriptor = (await vendo.actions.descriptors()).find((entry) => entry.name === "vendo_knowledge_search");
    expect(descriptor).toBeDefined();
    await vendo.store.records("vendo_grants").put({
      id: "grt_gov_auto",
      data: {
        id: "grt_gov_auto",
        subject: principal.subject,
        tool: "vendo_knowledge_search",
        descriptorHash: descriptorHash(descriptor!),
        scope: { kind: "tool" },
        duration: "standing",
        appId: doc.id,
        source: "automation",
        grantedAt: new Date().toISOString(),
      },
      refs: { subject: principal.subject, tool: "vendo_knowledge_search", app_id: doc.id },
    });

    await vendo.emit("gov-check", {}, principal);

    expect(await auditRow(vendo, "automation")).toBe(true);
    expect(adapter.contexts.length).toBeGreaterThan(0);
    for (const ctx of adapter.contexts) expect(ctx.includeInternal).toBeUndefined();
    // The step genuinely ran and answered: run ok, and the engine served the
    // PUBLIC doc only. (Run records persist step statuses, not tool outputs,
    // so leakage is asserted at the served-hits level plus the record JSON.)
    const { runs } = await vendo.automations.runs.list({ appId: doc.id }, {
      principal,
      venue: "automation",
      presence: "present",
      sessionId: "s_gov",
    });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.status).toBe("ok");
    expect(adapter.servedDocIds).toContain(PUBLIC_ID);
    expect(adapter.servedDocIds).not.toContain(INTERNAL_ID);
    const serialized = JSON.stringify(runs);
    expect(serialized).not.toContain(INTERNAL_ID);
    expect(serialized).not.toContain(INTERNAL_MARKER);
  });
});

describe("visibility governance — trusted composition path (k8 T5)", () => {
  it("includeInternal surfaces internal docs ONLY on a direct host-wired adapter call — the tool never sets it", async () => {
    const adapter = memoryKnowledgeAdapter({ docs: corpus() });
    // The host's own backend composition (dev riders, host-registered
    // automations) calls the adapter directly and MAY set includeInternal.
    const trusted = await adapter.search({ text: "escalation" }, { principal, includeInternal: true });
    expect(trusted.hits.some((hit) => hit.ref.docId === INTERNAL_ID && hit.visibility === "internal")).toBe(true);
    // The same query through the default (end-user) context stays public-only.
    const untrusted = await adapter.search({ text: "escalation" }, { principal });
    expect(untrusted.hits.every((hit) => hit.visibility === "public")).toBe(true);
  });
});
