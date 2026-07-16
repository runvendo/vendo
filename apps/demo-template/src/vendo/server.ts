import { anthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel } from "ai";
import type { ComponentCatalog } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { createVendo } from "@vendoai/vendo/server";
import { getCapsGuard, spendMeteringMiddleware } from "@/server/caps";

// PLUMBING — DO NOT MODIFY the model wrapping below per prospect. The spend
// middleware observes real token usage for the caps guard (the only thing
// bounding cost on our Anthropic key); removing it un-meters the demo.
const modelId = process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6";
const model = wrapLanguageModel({
  model: anthropic(modelId),
  middleware: spendMeteringMiddleware(getCapsGuard(), modelId),
});
const store = createStore({ dataDir: ".vendo/data" });

// CREATOR SEAM — host-component catalog. Empty in the template: the creator
// fills this with the prospect-branded components generated UI may embed
// (see apps/demo-bank/src/vendo/server.ts for worked entries). Every entry
// here must have a same-named client component in src/vendo/host-components.tsx.
const catalog: ComponentCatalog = [];

export const vendo = createVendo({
  model,
  store,
  // No login wall: every visitor is anonymous. Returning null rides the
  // umbrella's per-client anonymous principal (a signed session cookie), so
  // visitors never share threads, grants, approvals, or apps.
  principal: async () => null,
  catalog,
  policy: { file: ".vendo/policy.json" },
});
