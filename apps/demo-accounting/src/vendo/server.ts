import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import { vendoAutoJudge } from "@vendoai/guard";
import { createVendo } from "@vendoai/vendo/server";
import { actAsCadenceUser } from "./auth";
import { resolveDemoPrincipal } from "./principal";
import { cadenceRegistry } from "./registry";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const judgeModelName = process.env.VENDO_JUDGE_MODEL;
const composioApiKey = process.env.COMPOSIO_API_KEY;
const judge = judgeModelName ? vendoAutoJudge({ model: anthropic(judgeModelName) }) : undefined;

export const vendo = createVendo({
  model,
  // Hand-wired trio, NOT `auth: supabase()`: Cadence verifies BOTH the legacy
  // HS256 project secret and GoTrue's ES256 JWKS (../server/session.ts,
  // `supabase start` >= v2.71 signs logins with the latter). The shipped
  // `auth: supabase()` preset (packages/vendo/src/auth-presets/supabase.ts)
  // only verifies HS256 sessions — no JWKS support yet — so it would silently
  // reject any Cadence login signed with the newer key. Known preset gap, not
  // a Cadence bug; see docs/superpowers/plans/2026-07-18-init-lane-handoff.md.
  // `actAsCadenceUser` (./auth) still mints real HS256 Supabase away tokens
  // for the away/MCP seam through the SAME preset (its actAs half never
  // touches session verification); only the inbound present-mode session
  // check stays hand-rolled (./auth's resolveCadencePrincipal).
  principal: resolveDemoPrincipal,
  actAs: actAsCadenceUser,
  // The shared registry (01 §14): the server reads only the data fields;
  // <VendoRoot> takes the same object and reads only component references.
  catalog: cadenceRegistry,
  policy: { file: ".vendo/policy.json" },
  ...(judge ? { judge } : {}),
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "googlecalendar", "slack"] })]
    : [],
});
