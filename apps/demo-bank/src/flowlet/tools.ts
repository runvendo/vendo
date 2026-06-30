/**
 * The demo agent's in-process tools, assembled per request.
 *
 *  - Beat 1: `get_transactions` reads Maple's store so the agent can fill the
 *    TimeOfDayClock (and find specific charges).
 *  - Beat 3 adds the rule-setter (Phase 4).
 *
 * These run server-side inside the same Next process, so they read the
 * repositories directly rather than self-calling the HTTP API.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { listTransactions } from "@/server/transactions";
import { pacificHour, pacificTimeLabel } from "./time";
import { addRule } from "./rules-store";

const getTransactions = tool({
  description:
    "Read the user's recent Maple transactions. Returns merchant, amount in dollars, " +
    "the time of day (hour 0-24 and a label), category and descriptor. Use this to " +
    "build time-of-day spending views and to locate a specific charge.",
  inputSchema: z.object({
    limit: z.number().optional().describe("Max transactions to return (default 40)."),
  }),
  execute: async ({ limit }) => {
    const { data } = listTransactions({ limit: limit ?? 40 });
    return data.map((t) => ({
      id: t.id,
      merchant: t.merchant,
      descriptor: t.descriptor,
      amountDollars: Math.round(Math.abs(t.amount)) / 100,
      direction: t.amount < 0 ? "debit" : "credit",
      hour: pacificHour(t.timestamp),
      time: pacificTimeLabel(t.timestamp),
      category: t.category,
    }));
  },
});

const setRule = tool({
  description:
    "Set a standing natural-language rule that fires automatically when a matching " +
    "transaction appears (e.g. 'post to Slack #general whenever I order late-night " +
    "delivery'). Do NOT post to Slack yourself — the rule does it when a charge matches. " +
    "Capture both the human-readable description and a structured trigger.",
  inputSchema: z.object({
    description: z.string().describe("Human-readable rule, e.g. 'Post to #general on any late-night delivery order'."),
    channel: z.string().optional().describe("Slack channel name (no #). Default 'general'."),
    trigger: z.object({
      lateNightOnly: z.boolean().optional().describe("Only fire for charges between 12am and 5am."),
      categories: z.array(z.string()).optional().describe("Maple categories to match, e.g. ['dining']."),
      keywords: z.array(z.string()).optional().describe("Merchant/descriptor keywords, e.g. ['doordash','uber eats','delivery','grubhub']."),
    }),
  }),
  execute: async ({ description, channel, trigger }) => {
    const rule = addRule({ description, channel, trigger });
    return {
      ok: true,
      ruleId: rule.id,
      description: rule.description,
      channel: rule.channel,
      summary: `Active. Any matching charge now posts to #${rule.channel}.`,
    };
  },
});

export function demoTools(): ToolSet {
  return {
    get_transactions: getTransactions,
    set_rule: setRule,
  };
}
