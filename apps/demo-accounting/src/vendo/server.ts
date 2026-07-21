import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import { vendoAutoJudge } from "@vendoai/guard";
import { createVendo } from "@vendoai/vendo/server";
import { cadenceAuth } from "./auth";
import { cadenceRegistry } from "./registry";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const judgeModelName = process.env.VENDO_JUDGE_MODEL;
const composioApiKey = process.env.COMPOSIO_API_KEY;
const judge = judgeModelName ? vendoAutoJudge({ model: anthropic(judgeModelName) }) : undefined;

export const vendo = createVendo({
  model,
  // One preset fills all three identity seams (09-vendo §2.1) — the shipped
  // supabase() preset, hybrid HS256 + ES256/JWKS like ../server/session.ts;
  // see ./auth for the Cadence-specific configuration.
  auth: cadenceAuth,
  // The shared registry (01 §14): the server reads only the data fields;
  // <VendoRoot> takes the same object and reads only component references.
  catalog: cadenceRegistry,
  // Gate candidate config (v4 final gate, 2026-07-21): the measured stack is
  // v4 create contract + end pass ON. Configuration selection, not tuning.
  apps: {
    pipeline: { promptRewrite: true, endPass: true },
    // Gate observability only — server-log per-stage diagnostics so the run
    // ledger can report end-pass adoption and repair engagement per prompt.
    onPipeline: (event) => console.log("[vendo pipeline]", JSON.stringify(event)),
  },
  policy: { file: ".vendo/policy.json" },
  ...(judge ? { judge } : {}),
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "googlecalendar", "slack"] })]
    : [],
});
