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

/** Hour-of-day (0-24, fractional) for an ISO timestamp, fixed to Pacific so the
 *  value is deterministic regardless of the server's timezone. */
function pacificHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return Number((h + m / 60).toFixed(2));
}

function pacificTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

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
