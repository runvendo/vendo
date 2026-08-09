import { createConnectGate } from "@vendoai/actions";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { RunContext, ToolDescriptor, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { describe, expect, it } from "vitest";
import { withUniqueToolTitles } from "../src/duplicate-titles.js";

/**
 * The title-uniqueness fix opened a new hole: the verdict was memoized against
 * whatever descriptor set the FIRST call happened to see. An automation tick
 * calling descriptors(awayCtx) before any chat turn projects away the two
 * destructive tools that collide, so the collision is invisible in that set, the
 * memoized verdict is "clean", and a later ATTENDED execute short-circuits on it
 * and runs a mutating call with an ambiguous consent card.
 *
 * Uniqueness of titles is a DEPLOYMENT property, not a per-run one, so it must be
 * computed over the full unprojected tool set — which is what these tests pin,
 * through the real composed stack.
 */
const tool = (name: string, risk: ToolDescriptor["risk"], title: string): ToolDescriptor => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
  risk,
  title,
});

// Two DESTRUCTIVE tools sharing one title. Destructive is the load-bearing part:
// an unattended projection withholds exactly these, so the collision vanishes
// from the projected set.
const SURFACE: ToolDescriptor[] = [
  tool("maple_invoices_list", "read", "List invoices"),
  tool("maple_payments_send", "destructive", "Send money"),
  tool("maple_transfers_create", "destructive", "Send money"),
];

function stack(): { registry: ToolRegistry; executed: string[] } {
  const executed: string[] = [];
  const inner: ToolRegistry = {
    descriptors: async () => SURFACE,
    execute: async (call): Promise<ToolOutcome> => {
      executed.push(call.tool);
      return { status: "ok", output: {} };
    },
  };
  const guard = createGuard({ store: memoryStoreAdapter() });
  const connectGate = createConnectGate({ toolkitOf: async () => undefined, isConnected: async () => true });
  return { registry: withUniqueToolTitles(connectGate.bind(guard.bind(inner))), executed };
}

const away: Pick<RunContext, "venue" | "presence"> = { venue: "automation", presence: "away" };
const present: RunContext = {
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  sessionId: "s1",
};

describe("the title collision is a deployment property, not a per-run one", () => {
  it("refuses an attended execute EVEN AFTER an unattended projection ran first", async () => {
    const { registry, executed } = stack();

    // The automation tick. Pre-fix this silently returned [] (the collided
    // destructive tools were projected away) and cached a "clean" verdict. The
    // fix makes it throw, but the point of THIS test is the ATTENDED path, so
    // swallow the tick's error exactly as a resilient scheduler would.
    await registry.descriptors(away).catch(() => undefined);

    // Now a real user clicks. The card cannot tell the two "Send money" tools
    // apart, so the mutating call must be refused — the cached verdict must NOT
    // have been poisoned by the projected tick.
    await expect(
      registry.execute({ id: "c1", tool: "maple_payments_send", args: { amount: 5000 } }, present),
    ).rejects.toThrow(/title/i);

    // The load-bearing assertion: nothing ran.
    expect(executed).toEqual([]);
  });

  it("refuses an attended enumeration after the same unattended projection", async () => {
    const { registry } = stack();
    await registry.descriptors(away).catch(() => undefined);

    await expect(registry.descriptors(present)).rejects.toThrow(/title/i);
  });

  it("catches the collision on the very first call even when that call is unattended", async () => {
    // The scan sees the full set regardless of the projection asked for, so the
    // automation tick itself fails rather than appearing healthy.
    const { registry } = stack();

    await expect(registry.descriptors(away)).rejects.toThrow(/title/i);
  });

  it("still passes a clean deployment through both doors after a projection", async () => {
    const executed: string[] = [];
    const clean: ToolDescriptor[] = [
      tool("maple_invoices_list", "read", "List invoices"),
      tool("maple_payments_send", "destructive", "Send money"),
    ];
    const inner: ToolRegistry = {
      descriptors: async () => clean,
      execute: async (call) => { executed.push(call.tool); return { status: "ok", output: {} }; },
    };
    // Consent is not this suite's subject: what is pinned is that a clean
    // deployment reaches the tool at all. The blank state parks a destructive
    // call, so the host says in writing that this one may run — otherwise the
    // "clean" case would be indistinguishable from the collision case, which
    // also never executes.
    const guard = createGuard({
      store: memoryStoreAdapter(),
      policy: { rules: [{ match: { risk: "destructive" }, action: "run" }] },
    });
    const connectGate = createConnectGate({ toolkitOf: async () => undefined, isConnected: async () => true });
    const registry = withUniqueToolTitles(connectGate.bind(guard.bind(inner)));

    await registry.descriptors(away);
    const outcome = await registry.execute({ id: "c1", tool: "maple_payments_send", args: {} }, present);

    expect(outcome.status).toBe("ok");
    expect(executed).toEqual(["maple_payments_send"]);
  });
});
