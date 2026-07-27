import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type CreateVendoConfig } from "./server.js";

const ADA: Principal = { kind: "user", subject: "user_ada" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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

/** A model shell that records every prompt it is asked to stream and fails
    the call — the test only cares WHICH contract text reached the model. */
function recordingModel(prompts: string[]): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "pipeline-wire-test",
    modelId: "recorder",
    supportedUrls: {},
    async doGenerate(options: unknown) {
      prompts.push(JSON.stringify(options));
      throw new Error("recorded");
    },
    async doStream(options: unknown) {
      prompts.push(JSON.stringify(options));
      throw new Error("recorded");
    },
  } as unknown as LanguageModel;
}

async function createOnce(apps: CreateVendoConfig["apps"]): Promise<string> {
  const prompts: string[] = [];
  const vendo = createVendo({
    model: recordingModel(prompts),
    principal: async () => ADA,
    store: await tempStore("vendo-pipeline-wire-"),
    ...(apps === undefined ? {} : { apps }),
  });
  await vendo.apps
    .create({ prompt: "a spending dashboard" }, {
      principal: ADA,
      venue: "app",
      presence: "present",
      sessionId: "session_pipeline_wire",
    })
    .catch(() => undefined);
  return prompts.join("\n");
}

// The exemplar create contract's distinctive section tag; the legacy
// contract never emits it.
const V4_MARKER = "<building_great_apps>";

describe("createVendo({ apps: { pipeline } }) threads the W4/v4 flags to the engine", () => {
  it("exemplarContract reaches generation: the exemplar contract is sent to the model", async () => {
    const sent = await createOnce({ pipeline: { exemplarContract: true } });
    expect(sent).toContain(V4_MARKER);
  });

  it("without the flag the legacy contract is used", async () => {
    const sent = await createOnce(undefined);
    expect(sent).not.toContain(V4_MARKER);
    expect(sent.length).toBeGreaterThan(0);
  });
});
