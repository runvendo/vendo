/**
 * The whole agent: a name, instructions, and one tool it can call.
 *
 * Nothing else is configured — no store, no sandbox, no harness. Left unset,
 * an agent thinks in this process and persists its threads and audit rows
 * automatically, so this file runs in an empty Node project.
 */
import { agent, tool } from "@vendoai/agents";
import { z } from "zod";

/** Stand-in for your own database or API call. */
const ORDERS: Record<string, { status: string; eta: string }> = {
  "A-1001": { status: "shipped", eta: "2026-08-21" },
  "A-1002": { status: "packing", eta: "2026-08-24" },
};

export const support = agent({
  name: "support",
  instructions:
    "You are Acme's support agent. Look an order up before you answer about it, "
    + "and say so plainly when an order id is not one of ours.",
  tools: [
    tool({
      name: "order_status",
      // The model reads this to decide whether to call the tool, so it is required.
      description: "Look up one Acme order by id and return its shipping status and ETA.",
      // Your grade, and it is final. Leave it off and the tool is ungraded,
      // which the guard asks a person about every time — the first chat()
      // would come back `interrupted` with nothing run.
      risk: "read",
      inputSchema: z.object({ orderId: z.string().describe("An Acme order id, like A-1001") }),
      execute: ({ orderId }) => ORDERS[orderId] ?? { error: `no order ${orderId}` },
    }),
  ],
});
