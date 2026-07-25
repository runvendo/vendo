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
  // Gate candidate config (rematch gate, 2026-07-25): three measured arms,
  // selected at boot by VENDO_GATE_ARM — the arm order is randomized PER
  // PROMPT (committed schedule), so per-arm commits would force a rebuild
  // between every create; one env-switched seam keeps the diff auditable.
  //   A (unset) = production defaults: pipeline {}
  //   B = { endPass: true } — current contract + data-sighted verify
  //   C = { exemplarContract: true, endPass: true }
  // Configuration selection, not tuning. REVERTED after the run.
  apps: {
    pipeline: process.env.VENDO_GATE_ARM === "C"
      ? { exemplarContract: true, endPass: true }
      : process.env.VENDO_GATE_ARM === "B"
        ? { endPass: true }
        : {},
    // Gate observability only — server-log per-stage diagnostics so the run
    // ledger can report data-verify adoption and repair engagement per prompt.
    onPipeline: (event) => console.log("[vendo pipeline]", JSON.stringify(event)),
  },
  policy: { file: ".vendo/policy.json" },
  ...(judge ? { judge } : {}),
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "googlecalendar", "slack"] })]
    : [],
});
