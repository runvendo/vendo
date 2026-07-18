import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import type { ComponentCatalog } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { createVendo } from "@vendoai/vendo/server";
import { z } from "zod";
import { actAsMapleUser } from "./auth";
import { mapleMcpConfig } from "./mcp-config";
import { mapleOAuthAdapter } from "./oauth";
import { resolveDemoPrincipal } from "./principal";

const model = anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
const composioApiKey = process.env.COMPOSIO_API_KEY;
const databaseUrl = process.env.VENDO_DATABASE_URL ?? process.env.DATABASE_URL;
const store = createStore(databaseUrl ? { url: databaseUrl } : { dataDir: ".vendo/data" });

const mapleCategorySchema = z.enum([
  "dining",
  "groceries",
  "coffee",
  "transport",
  "subscriptions",
  "shopping",
  "income",
  "transfer",
  "housing",
  "other",
]);

const catalog: ComponentCatalog = [
  {
    name: "MapleSparkline",
    description: "The default Maple visualization for a compact financial trend, history, change over time, or monthly trend. Use it whenever the request includes one of those intents.",
    propsSchema: z.object({
      data: z.array(z.number()),
      height: z.number().optional(),
    }),
    propsJsonSchema: {
      type: "object",
      properties: {
        data: { type: "array", items: { type: "number" } },
        height: { type: "number" },
      },
      required: ["data"],
      additionalProperties: false,
    },
    examples: ['{"data":[1280,1315,1298,1360,1412],"height":32}'],
  },
  {
    name: "MapleSpendingDonut",
    description: "The default Maple visualization for spending by category, where money went, or category mix. Use it whenever the request includes one of those intents; slice amounts are dollars, not cents.",
    propsSchema: z.object({
      slices: z.array(z.object({
        category: mapleCategorySchema,
        amount: z.number(),
      })),
      size: z.number().optional(),
    }),
    propsJsonSchema: {
      type: "object",
      properties: {
        slices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { enum: mapleCategorySchema.options },
              amount: { type: "number", description: "Amount in dollars" },
            },
            required: ["category", "amount"],
            additionalProperties: false,
          },
        },
        size: { type: "number" },
      },
      required: ["slices"],
      additionalProperties: false,
    },
    examples: [
      '{"slices":[{"category":"dining","amount":342.18},{"category":"groceries","amount":286.42}],"size":200}',
    ],
  },
  {
    name: "MapleNetWorthCard",
    description: "The Maple total-balance card: animated USD total, change badge, range switcher, and an area trend of the balance history. Use it for net worth, total balance, or balance-over-time requests. Values are integer cents.",
    propsSchema: z.object({
      valueCents: z.number(),
      series: z.array(z.number()),
      changeLabel: z.string().optional(),
      initialRange: z.enum(["1W", "1M", "3M", "1Y", "All"]).optional(),
      chartHeight: z.number().optional(),
    }),
    propsJsonSchema: {
      type: "object",
      properties: {
        valueCents: { type: "number", description: "Total balance in integer cents" },
        series: { type: "array", items: { type: "number" }, description: "Balance history in integer cents" },
        changeLabel: { type: "string" },
        initialRange: { enum: ["1W", "1M", "3M", "1Y", "All"] },
        chartHeight: { type: "number" },
      },
      required: ["valueCents", "series"],
      additionalProperties: false,
    },
    examples: [
      '{"valueCents":5490715,"series":[5329117,5446991,5589669,5679262,5733114,5794065,5901309,5748395],"changeLabel":"▲ 2.3% this month"}',
    ],
  },
];

export const vendo = createVendo({
  model,
  // v2 spec §4 — the tier-0 paint lane runs on a fast no-think model.
  paint: { model: anthropic(process.env.VENDO_DEMO_PAINT_MODEL ?? "claude-haiku-4-5") },
  store,
  principal: resolveDemoPrincipal,
  actAs: actAsMapleUser,
  catalog,
  policy: { file: ".vendo/policy.json" },
  mcp: mapleMcpConfig(),
  oauth: mapleOAuthAdapter,
  connectors: composioApiKey
    ? [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "slack"] })]
    : [],
});
