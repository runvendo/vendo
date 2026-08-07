import { beforeEach, describe, expect, it } from "vitest";
import { createStack, resetFixture, SUBJECT } from "./harness.js";
import { connectWithSdk, issueTokens, refreshToken, registerClient } from "./support.js";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

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
        // At least one revoke row lands with venue=mcp. There may be a second:
        // the SDK client, on the 401, re-runs OAuth and its refresh attempt
        // hits the now-revoked subject, which correctly revokes the chain too.
        const revokeRows = await stack.sql(
          "SELECT DISTINCT venue FROM vendo_audit WHERE kind = 'door-auth' AND event->'detail'->>'event' = 'revoke'",
        );
        expect(revokeRows).toEqual([{ venue: "mcp" }]);

        // Un-revoke, then present a FRESH valid token against the OLD session
        // id: authentication passes, but the session was killed server-side, so
        // the door answers 404 — proving session death independent of the token.
        stack.revoked.delete(SUBJECT);
        if (!sessionId) throw new Error("SDK session did not retain a session id");
        const freshClient = await registerClient(stack);
        const fresh = await issueTokens(stack, freshClient.body.client_id);
        const deadSession = await fetch(stack.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${fresh.body.access_token}`,
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

  it("revokes tokens through RFC 7009 with PGlite-backed family semantics", async () => {
    const stack = await createStack();
    try {
      const client = await registerClient(stack);
      const first = await issueTokens(stack, client.body.client_id);
      const rotatedResponse = await refreshToken(stack, first.body.refresh_token, client.body.client_id);
      expect(rotatedResponse.status).toBe(200);
      const rotated = await rotatedResponse.json() as TokenResponse;
      const independent = await issueTokens(stack, client.body.client_id);

      const revoked = await fetch(`${stack.endpoint}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: first.body.refresh_token,
          token_type_hint: "access_token",
          client_id: client.body.client_id,
        }),
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.text()).toBe("");
      expect(await bearerStatus(stack.endpoint, first.body.access_token)).toBe(401);
      expect(await bearerStatus(stack.endpoint, rotated.access_token)).toBe(401);
      expect((await refreshToken(stack, rotated.refresh_token, client.body.client_id)).status).toBe(400);
      expect((await refreshToken(stack, independent.body.refresh_token, client.body.client_id)).status).toBe(200);

      const families = await stack.sql<{ status: string; count: number }>(
        `SELECT data->>'status' AS status, count(*)::int AS count
         FROM vendo_mcp_grants
         WHERE data->>'kind' = 'family'
         GROUP BY data->>'status'
         ORDER BY status`,
      );
      expect(families).toEqual([
        { status: "active", count: 1 },
        { status: "revoked", count: 1 },
      ]);

      const accessOnly = await issueTokens(stack, client.body.client_id);
      const accessRevoked = await fetch(`${stack.endpoint}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: accessOnly.body.access_token,
          token_type_hint: "access_token",
          client_id: client.body.client_id,
        }),
      });
      expect(accessRevoked.status).toBe(200);
      expect(await bearerStatus(stack.endpoint, accessOnly.body.access_token)).toBe(401);
      expect((await refreshToken(stack, accessOnly.body.refresh_token, client.body.client_id)).status).toBe(200);

      const unknown = await fetch(`${stack.endpoint}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "vmrt_unknown",
          token_type_hint: "future_token_type",
          client_id: client.body.client_id,
        }),
      });
      expect(unknown.status).toBe(200);
      expect(await unknown.text()).toBe("");
    } finally {
      await stack.close();
    }
  });
});

async function bearerStatus(endpoint: string, token: string): Promise<number> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "revocation-e2e", version: "1.0.0" },
      },
    }),
  });
  return response.status;
}
