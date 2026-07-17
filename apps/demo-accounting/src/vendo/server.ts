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
    propsJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        variant: { enum: ["missing", "overdue", "review", "verified", "neutral"] },
        dot: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    examples: ['{"text":"Needs review","variant":"review","dot":true}'],
  },
  {
    name: "CadenceDocProgress",
    description: "Use for Cadence document-collection or checklist completion when the user needs progress toward a known total.",
    propsSchema: z.object({
      value: z.number(),
      max: z.number(),
    }),
    propsJsonSchema: {
      type: "object",
      properties: {
        value: { type: "number" },
        max: { type: "number" },
      },
      required: ["value", "max"],
      additionalProperties: false,
    },
    examples: ['{"value":7,"max":10}'],
  },
  {
    name: "CadenceMissingDocsHero",
    description: "The Cadence dashboard hero card: clients with outstanding documents, an action badge, and the active-client total. Use it for who-still-owes-documents or chase-list summary requests.",
    propsSchema: z.object({
      missingCount: z.number(),
      clientCount: z.number(),
      badgeLabel: z.string().optional(),
    }),
    propsJsonSchema: {
      type: "object",
      properties: {
        missingCount: { type: "number", description: "Clients with at least one outstanding document" },
        clientCount: { type: "number", description: "All active clients" },
        badgeLabel: { type: "string" },
      },
      required: ["missingCount", "clientCount"],
      additionalProperties: false,
    },
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
