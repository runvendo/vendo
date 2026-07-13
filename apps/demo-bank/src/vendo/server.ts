import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import { createVendo } from "@vendoai/vendo/server";
import { resolveDemoPrincipal } from "./principal";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const composioApiKey = process.env.COMPOSIO_API_KEY;

export const vendo = createVendo({
  model,
  principal: resolveDemoPrincipal,
  policy: { file: ".vendo/policy.json" },
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "slack"] })]
    : [],
});
