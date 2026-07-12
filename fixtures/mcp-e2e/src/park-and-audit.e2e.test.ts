import { beforeEach, describe, expect, it } from "vitest";
import { createStack, resetFixture, SUBJECT } from "./harness.js";
import { connectWithSdk, textOf } from "./support.js";

describe("destructive calls park at the MCP perimeter", () => {
  beforeEach(resetFixture);

  it("parks, audits, approves, and retries a destructive call", async () => {
    const stack = await createStack();
    try {
      const connected = await connectWithSdk(stack);
      try {
        const parked = await connected.client.callTool({
          name: "host_invoices_delete",
          arguments: { id: "inv_0003" },
        });
        expect(parked.isError).toBe(true);
        const approvalId = textOf(parked).match(/apr_[0-9a-f-]+/)?.[0];
        expect(approvalId).toMatch(/^apr_/);
        expect(await stack.sql(
          "SELECT id, status FROM vendo_approvals WHERE id = $1",
          [approvalId],
        )).toEqual([{ id: approvalId, status: "pending" }]);
        expect(await stack.sql(
          "SELECT tool, venue FROM vendo_audit WHERE kind = 'tool-call' AND tool = 'host_invoices_delete'",
        )).toEqual([{ tool: "host_invoices_delete", venue: "mcp" }]);
        expect(await stack.sql(
          "SELECT kind, venue FROM vendo_audit WHERE kind = 'door-auth' AND event->'detail'->>'event' = 'issue'",
        )).toEqual([{ kind: "door-auth", venue: "mcp" }]);

        await stack.guard.approvals.decide(
          approvalId!,
          { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
          { kind: "user", subject: SUBJECT },
        );
        const retried = await connected.client.callTool({
          name: "host_invoices_delete",
          arguments: { id: "inv_0003" },
        });
        expect(retried.isError).not.toBe(true);
        expect(JSON.parse(textOf(retried))).toEqual({ ok: true });
      } finally {
        await connected.close();
      }
    } finally {
      await stack.close();
    }
  });
});
