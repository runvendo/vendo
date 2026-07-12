import { beforeEach, describe, expect, it } from "vitest";
import { createStack, resetFixture, SUBJECT } from "./harness.js";
import { connectWithSdk } from "./support.js";

describe("host revocation kills an MCP session", () => {
  beforeEach(resetFixture);

  it("rejects the next call, removes server session state, and audits revocation", async () => {
    const stack = await createStack();
    try {
      const connected = await connectWithSdk(stack);
      try {
        expect((await connected.client.listTools()).tools.length).toBeGreaterThan(0);
        const sessionId = connected.transport.sessionId;
        expect(sessionId).toMatch(/^mcps_/);
        stack.revoked.add(SUBJECT);

        // The exact error class is SDK-internal (the client's auth provider
        // may re-run OAuth — the token endpoint never consults principal(),
        // so re-auth "succeeds" and the repeat 401 surfaces as a transport
        // error). The contract's semantics are what we assert: the call
        // fails, the session is dead server-side, and revocation is audited.
        await expect(connected.client.callTool({
          name: "host_invoices_list",
          arguments: {},
        })).rejects.toThrow();
        expect(await stack.sql(
          "SELECT kind, venue FROM vendo_audit WHERE kind = 'door-auth' AND event->'detail'->>'event' = 'revoke'",
        )).toEqual([{ kind: "door-auth", venue: "mcp" }]);

        stack.revoked.delete(SUBJECT);
        const token = connected.provider.savedTokens?.access_token;
        if (!token || !sessionId) throw new Error("SDK session did not retain token and session id");
        const deadSession = await fetch(stack.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list", params: {} }),
        });
        expect(deadSession.status).toBe(404);
      } finally {
        await connected.close();
      }
    } finally {
      await stack.close();
    }
  });
});
