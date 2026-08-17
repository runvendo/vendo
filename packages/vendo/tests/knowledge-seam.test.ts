import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { type Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { screenDocument, screenSource } from "./screen-fixture.js";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // "No adapter ⇒ no tool" is only true of an UNCONFIGURED host: since #623
  // the seam also resolves the Cloud engine from VENDO_API_KEY, so a real key
  // in the ambient env would otherwise decide what this file observes. The
  // key rung has its own matrix in knowledge-resolution.test.ts.
  vi.stubEnv("VENDO_API_KEY", "");
});

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const principal: Principal = { kind: "user", subject: "user_knowledge" };

async function compose(config: Partial<CreateVendoConfig> = {}): Promise<Vendo> {
  return createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store: await tempStore("vendo-knowledge-seam-"),
    ...config,
  });
}

describe("knowledge adapter seam (K1)", () => {
  it("composes vendo_knowledge_search exactly when a knowledge adapter is configured", async () => {
    const withKnowledge = await compose({
      knowledge: memoryKnowledgeAdapter({
        docs: [{
          id: "doc-1",
          kind: "docs",
          visibility: "public",
          title: "Transfers",
          text: "Transfers settle in one business day.",
          source: "docs/transfers.md",
        }],
      }),
    });
    const names = (await withKnowledge.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("vendo_knowledge_search");

    const descriptor = (await withKnowledge.actions.descriptors())
      .find((candidate) => candidate.name === "vendo_knowledge_search");
    expect(descriptor?.risk).toBe("read");
  });

  it("does not expose vendo_knowledge_search when no adapter is configured", async () => {
    const bare = await compose();
    const names = (await bare.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).not.toContain("vendo_knowledge_search");
  });
});

/** Knowledge k8 (ENG-368) — the prompt index + usage guidance rides chat
 * turns exactly when the adapter composes, and its bytes never move between
 * turns at a fixed sync state (prompt-cache stability is a hard criterion). */
describe("knowledge prompt index (k8)", () => {
  async function systemPromptOfTurn(vendo: Vendo, prompts: Array<Array<{ role: string; content: unknown }>>, threadId: string): Promise<string> {
    const turn = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        message: { id: `m_${threadId}_${prompts.length}`, role: "user", parts: [{ type: "text", text: "Hello" }] },
      }),
    }));
    expect(turn.status).toBe(200);
    await turn.text();
    const system = prompts.at(-1)?.find((message) => message.role === "system");
    expect(system).toBeDefined();
    return typeof system!.content === "string" ? system!.content : JSON.stringify(system!.content);
  }

  async function mockModel(): Promise<{ model: LanguageModel; prompts: Array<Array<{ role: string; content: unknown }>> }> {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(structuredClone(prompt) as never);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Hi." },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                usage: {
                  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 0, text: 0, reasoning: 0 },
                },
                finishReason: { unified: "stop", raw: undefined },
              },
            ],
          }),
        };
      },
    });
    return { model: model as unknown as LanguageModel, prompts };
  }

  it("rides chat turns byte-stable at a FIXED sync state and REFRESHES when the sync manifest changes", async () => {
    // A real .vendo dir: the resolver fingerprints .vendo/knowledge-manifest.json
    // (sync writes it LAST), and reads .vendo/knowledge.json for sources.
    const { mkdtemp: makeTemp, mkdir, rm: remove, writeFile } = await import("node:fs/promises");
    const root = await makeTemp(join(tmpdir(), "vendo-k8-syncstate-"));
    await mkdir(join(root, ".vendo"), { recursive: true });
    const manifest = (docs: Record<string, string>) => JSON.stringify({
      format: "vendo/knowledge-hash@1",
      docs,
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    await writeFile(join(root, ".vendo", "knowledge-manifest.json"), manifest({ "docs#a": `sha256:${"a".repeat(64)}` }));
    await writeFile(join(root, ".vendo", "knowledge.json"), JSON.stringify({
      format: "vendo/knowledge@1",
      sources: [
        { name: "help-center", glob: "docs/**/*.md", kind: "docs", visibility: "public" },
        { name: "secret-fraud-runbooks", glob: "internal/**/*.md", kind: "docs", visibility: "internal" },
      ],
    }));
    const originalCwd = process.cwd();
    process.chdir(root);
    cleanups.push(async () => {
      process.chdir(originalCwd);
      await remove(root, { recursive: true, force: true });
    });

    const adapter = memoryKnowledgeAdapter({
      docs: [
        { id: "doc-1", kind: "docs", visibility: "public", title: "Transfers", text: "Transfers settle in one business day.", source: "docs/transfers.md" },
        { id: "doc-2", kind: "glossary", visibility: "public", title: "APY", text: "Annual percentage yield.", source: "docs/apy.md" },
      ],
    });
    const { model, prompts } = await mockModel();
    const vendo = await compose({ models: { default: model }, knowledge: adapter });

    const first = await systemPromptOfTurn(vendo, prompts, "thr_k8_stability");
    expect(first).toContain("Knowledge\n");
    expect(first).toContain("2 documents");
    expect(first).toContain("vendo_knowledge_search");
    expect(first).toContain("lookup:true");
    expect(first).toContain("readMore:{docId}");
    // P0 (ENG-370): the PUBLIC source is named; the internal source's NAME
    // never reaches an end-user prompt.
    expect(first).toContain("help-center");
    expect(first).not.toContain("secret-fraud-runbooks");

    // Half 1 — FIXED sync state: an upsert without a manifest rewrite (no
    // sync completed) must NOT move the prompt bytes (prompt-cache stability).
    await adapter.upsert?.([{ id: "doc-3", kind: "api", visibility: "public", title: "POST /wires", text: "Creates a wire.", source: "api/wires.md" }]);
    const second = await systemPromptOfTurn(vendo, prompts, "thr_k8_stability");
    expect(second).toBe(first);

    // Half 2 — a SYNC lands (manifest rewritten): the index refreshes to the
    // new counts, then is byte-stable at the new state.
    await writeFile(join(root, ".vendo", "knowledge-manifest.json"), manifest({
      "docs#a": `sha256:${"a".repeat(64)}`,
      "docs#b": `sha256:${"b".repeat(64)}`,
    }));
    const third = await systemPromptOfTurn(vendo, prompts, "thr_k8_stability");
    expect(third).toContain("3 documents");
    expect(third).not.toBe(first);
    const fourth = await systemPromptOfTurn(vendo, prompts, "thr_k8_stability");
    expect(fourth).toBe(third);
  });

  it("is absent when no knowledge adapter is composed", async () => {
    const { model, prompts } = await mockModel();
    const vendo = await compose({ models: { default: model } });
    const prompt = await systemPromptOfTurn(vendo, prompts, "thr_k8_absent");
    expect(prompt).not.toContain("Knowledge\n");
    expect(prompt).not.toContain("vendo_knowledge_search");
  });
});

/** Knowledge k8 T1 (ENG-368) — venue-app reachability: a generated app's
 * server-side live-view query invokes vendo_knowledge_search through the real
 * app path (wire route → open() → query resolver → guard-bound registry,
 * venue stamped "app" at call.ts). Refs stay preserved in the outcome —
 * citations INSIDE generated app UIs remain deferred (ENG-369 ruling). */
describe("venue-app reachability (k8 T1)", () => {
  it("resolves a knowledge-backed live-view query at venue app, refs preserved in the bound data", async () => {
    const vendo = await compose({
      knowledge: memoryKnowledgeAdapter({
        docs: [{
          id: "doc-transfers",
          kind: "docs",
          visibility: "public",
          title: "Wire transfer limits",
          text: "Maple caps outbound wire transfers at $25,000 per business day.",
          source: "docs/transfers.md",
        }],
      }),
    });
    const doc = screenDocument("app_kb_view", {
      name: "Transfer limits helper",
      source: screenSource(`import { Stack, Text, useQuery } from "@vendo/screen";

export default function TransferLimits() {
  const kb = useQuery("vendo_knowledge_search", { query: "wire transfer limits" });
  return (
    <Stack gap={12}>
      <Text text={kb.kind + " " + kb.outcome} />
      <Text text={kb.hits[0].docId} />
      <Text text={kb.hits[0].snippet} />
    </Stack>
  );
}
`),
    });
    await vendo.store.ensureSchema();
    await vendo.store.records("vendo_apps").put({
      id: doc.id,
      data: { subject: principal.subject, enabled: true, doc },
      refs: { subject: principal.subject },
    });

    const response = await vendo.handler(new Request("https://host.test/api/vendo/apps/app_kb_view/open"));
    expect(response.status).toBe(200);
    // The answer is READ THROUGH THE RENDER: a screen's query resolves into the
    // tree it paints, so what reached the app is exactly what is on screen.
    const painted = JSON.stringify(await response.json());
    expect(painted).toContain("vendo/knowledge-result@1 answered");
    expect(painted).toContain("doc-transfers");
    expect(painted).toContain("wire transfers");

    // The call crossed the guard perimeter AS the app venue — the audit row
    // is the reachability proof, not just the bound payload.
    const events = await vendo.guard.audit.query({ principal });
    expect(events.events.some((event) =>
      event.kind === "tool-call" && event.tool === "vendo_knowledge_search" && event.venue === "app",
    )).toBe(true);
  });
});
