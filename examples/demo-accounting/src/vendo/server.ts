import { composioConnector } from "@vendoai/actions";
import { vendoAutoJudge } from "@vendoai/guard";
import { createVendo, vendoModel } from "@vendoai/vendo/server";
import { cadenceAuth } from "./auth";
import { cadenceRegistry } from "./registry";

const composioApiKey = process.env.COMPOSIO_API_KEY;

export const vendo = createVendo({
  // The model slot stays UNSET (demo-refresh Part 2): the env ladder resolves
  // it — locally ANTHROPIC_API_KEY, deployed VENDO_API_KEY.
  // One preset fills all three identity seams (09-vendo §2.1) — the shipped
  // supabase() preset, hybrid HS256 + ES256/JWKS like ../server/session.ts;
  // see ./auth for the Cadence-specific configuration.
  auth: cadenceAuth,
  // The shared registry (01 §14): the server reads only the data fields;
  // <VendoRoot> takes the same object and reads only component references.
  catalog: cadenceRegistry,
  policy: { file: ".vendo/policy.json" },
  // Guard auto-judge on unconditionally (demo-refresh Part 2): run/ask/block
  // rulings on tool calls ride the vendo model family's judge lane —
  // vendo-judge on the Cloud gateway, the provider's fast pick on BYO rungs.
  judge: vendoAutoJudge({ model: vendoModel("vendo-judge") }),
  // The Cadence voice (03 §3 agent.instructions) — rides the agent prompt every turn.
  agent: {
    instructions: [
      "You are Cadence's built-in assistant for the firm's staff. Professional and precise; plain prose, no emoji.",
      "Be exact with client names, document kinds, and filing deadlines.",
      "When you render a view, let it carry the data — don't restate it in prose.",
    ].join("\n"),
  },
  // There is ONE generation pipeline now (the 2026-07-28 rebuild), so the
  // speed-core knobs this demo used to amend are gone with the lanes they chose
  // between; the island smoke-render gate is on by default.
  // BYO Composio when Cadence brings its own key; otherwise the slot stays
  // UNSET so a VENDO_API_KEY deployment composes the Cloud pair. No apps
  // scoping (2026-07-30 ruling): the dock offers every toolkit with an
  // enabled auth config on the account — new connectors need no redeploy.
  ...(composioApiKey ? { connectors: [composioConnector({ apiKey: composioApiKey })] } : {}),
});
