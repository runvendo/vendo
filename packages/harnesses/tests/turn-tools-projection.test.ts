/**
 * The two things `turn.tools` owes a harness that ISN'T `vendo()`.
 *
 * Both are read through the REAL guard's bound registry (`createGuard(...).bind`),
 * not a double, because both bugs were about what the runtime asks the registry
 * for — a double that answers the same thing either way could not see them.
 *
 * 1. **`inputSchema` reaches the listing.** Build contract §1.1's amendment
 *    2026-07-30 put it on `ToolListing` precisely because "every in-process
 *    harness must hand schemas to its model; JSON Schema is the interchange". A
 *    listing without it leaves a third-party harness guessing argument shapes.
 * 2. **THE LAW's projection applies.** `guard.bind(...).descriptors(ctx)` filters
 *    destructive tools out of an unattended run (design §12: they are "not
 *    projected into an automation run at all"). Asking for `descriptors()` with
 *    no ctx returns EVERYTHING, so an automation was shown a destructive tool and
 *    only found out when the call came back denied.
 */
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { createGuard } from "@vendoai/guard";
import { describe, expect, it } from "vitest";
import type { ToolDescriptor, ToolListing, ToolRegistry } from "@vendoai/core";
import { createTurnTools } from "../src/turn-tools.js";
import { ctx } from "../src/test-doubles.test-util.js";

const descriptor = (name: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  name,
  title: `Do ${name}`,
  description: `the ${name} tool`,
  inputSchema: {
    type: "object",
    properties: { amount: { type: "number" }, to: { type: "string" } },
    required: ["amount"],
    additionalProperties: false,
  },
  risk,
});

const HOST: ToolDescriptor[] = [
  descriptor("maple_invoices_list", "read"),
  descriptor("maple_money_send", "destructive"),
];

/** The real chain the composition root builds: host tools → `guard.bind`. */
function guardBound(): { tools: ToolRegistry; guard: ReturnType<typeof createGuard> } {
  const guard = createGuard({ store: memoryStoreAdapter() });
  const host: ToolRegistry = {
    async descriptors() {
      return structuredClone(HOST);
    },
    async execute() {
      return { status: "ok", output: {} };
    },
  };
  return { tools: guard.bind(host), guard };
}

const listing = async (
  interactive: boolean,
  runCtx = ctx(),
  toolSurface?: Parameters<typeof createTurnTools>[0]["toolSurface"],
): Promise<ToolListing[]> => {
  const { tools, guard } = guardBound();
  const turnTools = createTurnTools({
    registry: tools,
    guard,
    ctx: runCtx,
    interactive,
    mirror: () => undefined,
    ...(toolSurface === undefined ? {} : { toolSurface }),
  });
  try {
    return await turnTools.list();
  } finally {
    turnTools.dispose();
  }
};

describe("turn.tools.list() — what a harness needs to call a tool at all", () => {
  it("carries each tool's JSON Schema (contract §1.1, amendment 2026-07-30)", async () => {
    const listed = await listing(true);
    const send = listed.find((entry) => entry.name === "maple_money_send");
    expect(send?.inputSchema).toEqual({
      type: "object",
      properties: { amount: { type: "number" }, to: { type: "string" } },
      required: ["amount"],
      additionalProperties: false,
    });
  });

  it("still carries name, title, description and risk", async () => {
    const listed = await listing(true);
    expect(listed.find((entry) => entry.name === "maple_invoices_list")).toMatchObject({
      name: "maple_invoices_list",
      title: "Do maple_invoices_list",
      description: "the maple_invoices_list tool",
      risk: "read",
    });
  });
});

describe("turn.tools.list() — THE LAW's projection (design §12)", () => {
  it("offers the destructive tool when a person is present", async () => {
    const listed = await listing(true);
    expect(listed.map((entry) => entry.name)).toContain("maple_money_send");
  });

  it("does NOT offer a destructive tool to an automation run", async () => {
    const listed = await listing(false, ctx({ venue: "automation", presence: "away" }));
    expect(listed.map((entry) => entry.name)).toEqual(["maple_invoices_list"]);
  });

  it("still withholds it from an unattended run on an UNCURATED surface", async () => {
    // §1's `toolSurface` is the harness's say over CURATION, never over the law:
    // `curated: false` skips the loadout, and the ctx projection above it runs
    // regardless. A harness asking for everything must not be handed more than
    // its ctx projects.
    const listed = await listing(false, ctx({ venue: "automation", presence: "away" }), { curated: false });
    expect(listed.map((entry) => entry.name)).toEqual(["maple_invoices_list"]);
  });

  it("does NOT offer a destructive tool when nobody is present in a chat venue", async () => {
    // `presence: "away"` alone is enough — `isUnattended` reads either signal.
    const listed = await listing(false, ctx({ presence: "away" }));
    expect(listed.map((entry) => entry.name)).toEqual(["maple_invoices_list"]);
  });
});
