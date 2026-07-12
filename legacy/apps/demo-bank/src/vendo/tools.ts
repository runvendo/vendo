/**
 * The demo agent's in-process tools, assembled per request.
 *
 *  - `get_transactions` reads Maple's store so the agent can fill the
 *    TimeOfDayClock (and find specific charges).
 *
 * These run server-side inside the same Next process, so they read the
 * repositories directly rather than self-calling the HTTP API.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { listTransactions } from "@/server/transactions";
import { pacificHour, pacificTimeLabel } from "./time";

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

export function demoTools(): ToolSet {
  return {
    get_transactions: getTransactions,
  };
}
