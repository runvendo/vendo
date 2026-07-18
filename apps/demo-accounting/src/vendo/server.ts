import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import type { ComponentCatalog } from "@vendoai/core";
import { vendoAutoJudge } from "@vendoai/guard";
import { createVendo } from "@vendoai/vendo/server";
import { z } from "zod";
import { actAsCadenceUser } from "./auth";
import { resolveDemoPrincipal } from "./principal";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const judgeModelName = process.env.VENDO_JUDGE_MODEL;
const composioApiKey = process.env.COMPOSIO_API_KEY;
const judge = judgeModelName ? vendoAutoJudge({ model: anthropic(judgeModelName) }) : undefined;

const catalog: ComponentCatalog = [
  {
    name: "CadenceStatusBadge",
    description: "Use for a compact Cadence document, client, or workflow status label when the state should be immediately scannable.",
    propsSchema: z.object({
      text: z.string(),
      variant: z.enum(["missing", "overdue", "review", "verified", "neutral"]).optional(),
      dot: z.boolean().optional(),
    }),
    examples: ['{"text":"Needs review","variant":"review","dot":true}'],
  },
  {
    name: "CadenceDocProgress",
    description: "Use for Cadence document-collection or checklist completion when the user needs progress toward a known total.",
    propsSchema: z.object({
      value: z.number(),
      max: z.number(),
    }),
    examples: ['{"value":7,"max":10}'],
  },
  {
    name: "CadenceMissingDocsHero",
    description: "The Cadence dashboard hero card: clients with outstanding documents, an action badge, and the active-client total. Use it for who-still-owes-documents or chase-list summary requests.",
    propsSchema: z.object({
      missingCount: z.number().describe("Clients with at least one outstanding document"),
      clientCount: z.number().describe("All active clients"),
      badgeLabel: z.string().optional(),
    }),
    examples: ['{"missingCount":8,"clientCount":12}'],
  },
];

export const vendo = createVendo({
  model,
  principal: resolveDemoPrincipal,
  actAs: actAsCadenceUser,
  catalog,
  policy: { file: ".vendo/policy.json" },
  ...(judge ? { judge } : {}),
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "googlecalendar", "slack"] })]
    : [],
});
