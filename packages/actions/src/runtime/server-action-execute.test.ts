import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "@vendoai/core";
import type { ExtractedTool } from "../formats.js";
import { createActions } from "./registry.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

function serverActionTool(extras: Partial<ExtractedTool> = {}): ExtractedTool {
  return {
    name: "host_create_invoice",
    description: "server action app/actions/invoices.ts#createInvoice",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, input: { type: "object" } },
      required: ["id", "input"],
      additionalProperties: false,
    },
    risk: "write",
    binding: {
      kind: "server-action",
      module: "app/actions/invoices.ts",
      exportName: "createInvoice",
      params: ["id", "input"],
    },
    ...extras,
  };
}

describe("server-action execution", () => {
  it("dispatches in-process through the registration map with positional args", async () => {
    const action = vi.fn(async (id: string, input: { title: string }) => ({ id, title: input.title }));
    const actions = createActions({
      tools: [serverActionTool()],
      serverActions: { "app/actions/invoices.ts#createInvoice": action },
    });
    const outcome = await actions.execute(
      { id: "1", tool: "host_create_invoice", args: { input: { title: "t" }, id: "inv_1" } },
      ctx,
    );
    expect(action).toHaveBeenCalledWith("inv_1", { title: "t" });
    expect(outcome).toEqual({ status: "ok", output: { id: "inv_1", title: "t" } });
  });

  it("projects non-JSON outputs onto the JSON wire (Dates → ISO strings, undefined → null)", async () => {
    const when = new Date("2026-07-16T00:00:00.000Z");
    const actions = createActions({
      tools: [serverActionTool()],
      serverActions: { "app/actions/invoices.ts#createInvoice": async () => ({ when, missing: undefined }) },
    });
    const outcome = await actions.execute(
      { id: "1", tool: "host_create_invoice", args: { id: "inv_1", input: {} } },
      ctx,
    );
    expect(outcome).toEqual({ status: "ok", output: { when: "2026-07-16T00:00:00.000Z" } });
  });

  it("fails closed when the registration map lacks the action — no work performed", async () => {
    const stranger = vi.fn(async () => "never");
    const actions = createActions({
      tools: [serverActionTool()],
      serverActions: { "app/actions/other.ts#otherAction": stranger },
    });
    const outcome = await actions.execute(
      { id: "1", tool: "host_create_invoice", args: { id: "inv_1", input: {} } },
      ctx,
    );
    expect(stranger).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "not-implemented" },
    });
    expect((outcome as { error: { message: string } }).error.message).toContain("app/actions/invoices.ts#createInvoice");
  });

  it("fails closed when no registration map was configured at all", async () => {
    const actions = createActions({ tools: [serverActionTool()] });
    await expect(
      actions.execute({ id: "1", tool: "host_create_invoice", args: { id: "inv_1", input: {} } }, ctx),
    ).resolves.toMatchObject({ status: "error", error: { code: "not-implemented" } });
  });

  it("fails closed when the registered value is not a function", async () => {
    const actions = createActions({
      tools: [serverActionTool()],
      serverActions: { "app/actions/invoices.ts#createInvoice": "oops" as unknown as () => unknown },
    });
    await expect(
      actions.execute({ id: "1", tool: "host_create_invoice", args: { id: "inv_1", input: {} } }, ctx),
    ).resolves.toMatchObject({ status: "error", error: { code: "not-implemented" } });
  });

  it("surfaces a thrown action as a server-action-error outcome", async () => {
    const actions = createActions({
      tools: [serverActionTool()],
      serverActions: {
        "app/actions/invoices.ts#createInvoice": async () => {
          throw new Error("db down");
        },
      },
    });
    await expect(
      actions.execute({ id: "1", tool: "host_create_invoice", args: { id: "inv_1", input: {} } }, ctx),
    ).resolves.toEqual({
      status: "error",
      error: { code: "server-action-error", message: "db down" },
    });
  });

  it("refuses away execution — in-process actions ride the present session only", async () => {
    const action = vi.fn(async () => "never");
    const actions = createActions({
      tools: [serverActionTool()],
      serverActions: { "app/actions/invoices.ts#createInvoice": action },
      actAs: async () => ({ headers: {} }),
    });
    const outcome = await actions.execute(
      { id: "1", tool: "host_create_invoice", args: { id: "inv_1", input: {} } },
      { ...ctx, presence: "away" },
    );
    expect(action).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-implemented" } });
  });

  it("refuses MCP-venue execution the same way", async () => {
    const action = vi.fn(async () => "never");
    const actions = createActions({
      tools: [serverActionTool()],
      serverActions: { "app/actions/invoices.ts#createInvoice": action },
      actAs: async () => ({ headers: {} }),
    });
    const outcome = await actions.execute(
      { id: "1", tool: "host_create_invoice", args: { id: "inv_1", input: {} } },
      { ...ctx, venue: "mcp" },
    );
    expect(action).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-implemented" } });
  });
});
