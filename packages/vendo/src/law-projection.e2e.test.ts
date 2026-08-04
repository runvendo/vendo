import { createConnectGate } from "@vendoai/actions";
import type { RunContext, ToolDescriptor, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { withUniqueToolTitles } from "./duplicate-titles.js";

/**
 * THE LAW (design §12), PRIMARY mechanism: a destructive or external tool is not
 * projected into an unattended run AT ALL.
 *
 * The execute-time refusal is only the backstop. This asserts the withholding
 * itself, and it does so through the REAL production composition —
 * `withUniqueToolTitles(connectGate.bind(guard.bind(tools)))`, exactly as
 * server.ts assembles it — because that is where it was dead: the connect gate
 * re-declared `descriptors()` and swallowed the projection context, so every
 * destructive tool stayed visible to an automation.
 */
const tool = (name: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  name,
  description: `${risk} tool`,
  inputSchema: { type: "object" },
  risk,
  title: `${name} title`,
});

const SURFACE = [
  tool("maple_invoices_list", "read"),
  tool("maple_invoice_update", "write"),
  tool("maple_payments_send", "destructive"),
];

function registry(): ToolRegistry {
  return {
    descriptors: async () => SURFACE,
    execute: async (): Promise<ToolOutcome> => ({ status: "ok", output: {} }),
  };
}

/** The one registry a deployment actually serves, assembled as server.ts does. */
function productionStack(): ToolRegistry {
  const store = memoryStoreAdapter();
  const guard = createGuard({ store });
  const connectGate = createConnectGate({
    // No tool here is a brokered connector tool, so the gate is a pass-through
    // on execute — which is exactly the point: it must also be a pass-through
    // on the PROJECTION, and it was not.
    toolkitOf: async () => undefined,
    isConnected: async () => true,
  });
  return withUniqueToolTitles(connectGate.bind(guard.bind(registry())));
}

const away: Pick<RunContext, "venue" | "presence"> = { venue: "automation", presence: "away" };
const present: Pick<RunContext, "venue" | "presence"> = { venue: "chat", presence: "present" };

describe("THE LAW's projection survives the whole production stack", () => {
  it("withholds a destructive tool from an unattended run's toolset", async () => {
    const projected = await productionStack().descriptors(away);

    expect(projected.map((d) => d.name)).not.toContain("maple_payments_send");
  });

  it("still offers reads and writes to that same unattended run", async () => {
    const projected = await productionStack().descriptors(away);

    expect(projected.map((d) => d.name)).toEqual(["maple_invoices_list", "maple_invoice_update"]);
  });

  it("offers everything when a person is present", async () => {
    const projected = await productionStack().descriptors(present);

    expect(projected).toHaveLength(3);
  });

  it("offers everything when no context is given, so unrelated callers are unaffected", async () => {
    expect(await productionStack().descriptors()).toHaveLength(3);
  });
});
