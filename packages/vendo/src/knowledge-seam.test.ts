import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";

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

const principal: Principal = { kind: "user", subject: "user_knowledge" };

async function compose(config: Partial<CreateVendoConfig> = {}): Promise<Vendo> {
  return createVendo({
    model: {} as LanguageModel,
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
