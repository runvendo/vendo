import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import { createStore } from "@vendoai/store";
import { createVendo } from "@vendoai/vendo/server";
import { actAsMapleUser } from "./auth";
import { mapleOAuthAdapter } from "./oauth";
import { resolveDemoPrincipal } from "./principal";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const composioApiKey = process.env.COMPOSIO_API_KEY;
const databaseUrl = process.env.VENDO_DATABASE_URL ?? process.env.DATABASE_URL;
const store = createStore(databaseUrl ? { url: databaseUrl } : { dataDir: ".vendo/data" });

export const vendo = createVendo({
  model,
  store,
  principal: resolveDemoPrincipal,
  actAs: actAsMapleUser,
  policy: { file: ".vendo/policy.json" },
  mcp: true,
  oauth: mapleOAuthAdapter,
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "slack"] })]
    : [],
});
