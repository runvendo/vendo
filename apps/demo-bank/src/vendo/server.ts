import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import { createStore } from "@vendoai/store";
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { createVendo } from "@vendoai/vendo/server";
import { authSecret, resolveMapleSubject } from "@/server/users";
import { mapleMcpConfig } from "./mcp-config";
import { mapleRegistry } from "./registry";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const composioApiKey = process.env.COMPOSIO_API_KEY;
const databaseUrl = process.env.VENDO_DATABASE_URL ?? process.env.DATABASE_URL;
const store = createStore(databaseUrl ? { url: databaseUrl } : { dataDir: ".vendo/data" });

export const vendo = createVendo({
  model,
  // v2 spec §4 — the tier-0 paint lane runs on a fast no-think model.
  paint: { model: anthropic(process.env.VENDO_DEMO_PAINT_MODEL ?? "claude-haiku-4-5") },
  store,
  // One preset fills all three identity seams (09-vendo §2.1): the
  // request→Principal resolver, the away/MCP actAs seam, and the door's
  // OAuth adapter. `user` maps an Auth.js subject to the seeded Maple
  // identity; returning null means "not a Maple user" — the principal
  // resolves to anonymous and away/MCP minting for that subject declines.
  auth: authJs({
    secret: authSecret,
    user: (subject) => {
      const user = resolveMapleSubject(subject);
      return user ? { display: user.display, email: user.email } : null;
    },
  }),
  // The shared registry (01 §14): the server reads only the data fields;
  // <VendoRoot> takes the same object and reads only component references.
  catalog: mapleRegistry,
  // execution-v2 Waves 4+9 — the layer-2 (machines) and layer-3 (served apps)
  // experimental opt-ins are host decisions; Maple flips them via its own env
  // so demos can gate on/off. Served apps require machines, so the served
  // flag implies the machines flag here.
  apps: {
    experimentalServedApps: process.env.VENDO_EXPERIMENTAL_SERVED_APPS === "1",
    experimentalMachines: process.env.VENDO_EXPERIMENTAL_MACHINES === "1"
      || process.env.VENDO_EXPERIMENTAL_SERVED_APPS === "1",
    // Gate candidate config (v4 final gate, 2026-07-21): the measured stack is
    // v4 create contract + end pass ON. Configuration selection, not tuning.
    pipeline: { promptRewrite: true, endPass: true },
  },
  policy: { file: ".vendo/policy.json" },
  mcp: mapleMcpConfig(),
  // BYO Composio when Maple brings its own key; otherwise the slot stays
  // UNSET so a VENDO_API_KEY deployment composes the Cloud tools connector
  // (an explicit [] would read as "no connectors, ever" — the seam honors it).
  ...(composioApiKey
    ? { connectors: [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "slack"] })] }
    : {}),
});
