import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import { vendoAutoJudge } from "@vendoai/guard";
import { createVendo } from "@vendoai/vendo/server";
import { resolveDemoPrincipal } from "./principal";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const judgeModelName = process.env.VENDO_JUDGE_MODEL;
const composioApiKey = process.env.COMPOSIO_API_KEY;
const judge = judgeModelName ? vendoAutoJudge({ model: anthropic(judgeModelName) }) : undefined;

export const vendo = createVendo({
  model,
  principal: resolveDemoPrincipal,
  policy: { file: ".vendo/policy.json" },
  ...(judge ? { judge } : {}),
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "googlecalendar"] })]
    : [],
});
