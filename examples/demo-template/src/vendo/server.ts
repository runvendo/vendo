import type { LanguageModelV3 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import type { ComponentCatalog } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { createVendo, vendoModel } from "@vendoai/vendo/server";
import { getCapsGuard, spendMeteringMiddleware } from "@/server/caps";

// PLUMBING — DO NOT MODIFY the model wrapping below per prospect. The spend
// middleware observes real token usage for the caps guard (the only thing
// bounding cost on the key this demo runs on) on every call made through this
// model instance — streamed chat/app-edit calls and non-streaming generate
// calls (e.g. a policy judge, automations runs) alike. Removing the wrapping,
// or constructing a second unwrapped model, un-meters the demo.
//
// The wrapped model is vendoModel(), not a raw provider call: it rides the
// credential ladder, so a deployed demo's inference goes through the
// VENDO_API_KEY model gateway (metered allowance) while a laptop with
// ANTHROPIC_API_KEY keeps talking to Anthropic directly. `@ai-sdk/anthropic`
// stays a dependency for exactly that reason — the ladder imports the
// HOST-installed provider at resolve time, so pruning it breaks both rungs
// even though nothing here names it. VENDO_DEMO_MODEL
// pins a model name, passed through VERBATIM to whichever rung resolved —
// leave it unset and each rung picks its own default. The pricing label is
// only what the spend estimator prices by; an unknown name (the "vendo"
// family) prices at the estimator's most-expensive fallback tier, which
// over-counts on purpose.
const modelId = process.env.VENDO_DEMO_MODEL;
const model = wrapLanguageModel({
  // `vendoModel` is typed `LanguageModel` (= string | LanguageModelV3) for
  // callers that pass it straight to createVendo; it only ever returns the
  // lazily-resolving model object, never a name string.
  model: (modelId === undefined ? vendoModel() : vendoModel(modelId)) as LanguageModelV3,
  middleware: spendMeteringMiddleware(getCapsGuard(), modelId ?? "vendo"),
});

// CREATOR SEAM — host-component catalog. Empty in the template: the creator
// fills this with the prospect-branded components generated UI may embed
// (see examples/demo-bank/src/vendo/server.ts for worked entries). Every entry
// here must have a same-named client component in src/vendo/host-components.tsx.
const catalog: ComponentCatalog = [];

export const vendo = createVendo({
  // The `default` SEAT (build contract §4), not the deprecated top-level
  // `model:` — a seat is a job, and everything unset borrows this one.
  models: { default: model },
  // No login wall: every visitor is anonymous. Returning null rides the
  // umbrella's per-client anonymous principal (a signed session cookie), so
  // visitors never share threads, grants, approvals, or apps.
  principal: async () => null,
  catalog,
  policy: { file: ".vendo/policy.json" },
  // Connections stay UNSET so one VENDO_API_KEY composes the Cloud broker
  // (an explicit `connectors: []` would read as "no connectors, ever" — the
  // seam honors it). connectorApps scopes that auto-composed pair, so the
  // connect dock never advertises the console's full catalog to a prospect.
  connectorApps: ["gmail", "googlecalendar", "slack"],
  // Store posture — an explicit demo decision (README "Cloud posture"). The
  // DEPLOYED demo leaves this slot unset so the VENDO_API_KEY env ladder
  // composes the Cloud HOSTED store: a demo container's filesystem is
  // ephemeral, so a container-local store would silently wipe demo state on
  // every redeploy. DEMO_STORE=local pins a local PGlite store instead — the
  // local-dev posture (.env.local), so a laptop never shares the deployed
  // demo's tenant. An explicitly passed store wins over the key default, per
  // the adapter rule.
  ...(process.env.DEMO_STORE === "local" ? { store: createStore({ dataDir: ".vendo/data" }) } : {}),
});
