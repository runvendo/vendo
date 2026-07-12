import { beforeEach, describe, expect, it } from "vitest";
import { createStack, resetFixture } from "./harness.js";
import {
  authorizeCode,
  exchangeCode,
  issueTokens,
  refreshToken,
  registerClient,
  VERIFIER,
} from "./support.js";

describe("OAuth consent delegation and protocol sad paths", () => {
  beforeEach(resetFixture);

  it("passes the host interactive response through verbatim", async () => {
    const stack = await createStack({ oauthMode: "interactive" });
    try {
      const registered = await registerClient(stack);
      const response = await authorizeCode(stack, registered.body.client_id);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://fixture.example/consent");
      expect(await response.text()).toBe("");
    } finally {
      await stack.close();
    }
  });

  it("rejects bad PKCE and redirect mismatch, rotates refresh, and revokes on reuse", async () => {
    const stack = await createStack();
    try {
      const registered = await registerClient(stack);
      const mismatch = await authorizeCode(stack, registered.body.client_id, {
        redirect_uri: "http://127.0.0.1/wrong-callback",
      });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.json()).toMatchObject({ error: "invalid_request" });

      // Each exchange consumes its code on presentation (single-use), so the
      // bad-PKCE attempt and the good exchange each need a fresh code.
      const mintCode = async (): Promise<string> => {
        const authorization = await authorizeCode(stack, registered.body.client_id);
        const code = new URL(authorization.headers.get("location") ?? "").searchParams.get("code");
        if (!code) throw new Error("Authorization omitted code");
        return code;
      };
      const badPkce = await exchangeCode(stack, {
        code: await mintCode(),
        client_id: registered.body.client_id,
        code_verifier: "x".repeat(43),
      });
      expect(badPkce.status).toBe(400);
      expect(await badPkce.json()).toMatchObject({ error: "invalid_grant" });

      const exchanged = await exchangeCode(stack, {
        code: await mintCode(),
        client_id: registered.body.client_id,
        code_verifier: VERIFIER,
      });
      expect(exchanged.status).toBe(200);
      const first = await exchanged.json() as { access_token: string; refresh_token: string };
      const rotatedResponse = await refreshToken(stack, first.refresh_token, registered.body.client_id);
      expect(rotatedResponse.status).toBe(200);
      const rotated = await rotatedResponse.json() as { access_token: string; refresh_token: string };
      expect(rotated.refresh_token).not.toBe(first.refresh_token);

      const reuse = await refreshToken(stack, first.refresh_token, registered.body.client_id);
      expect(reuse.status).toBe(400);
      expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
      const revoked = await fetch(stack.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${rotated.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 88, method: "tools/list", params: {} }),
      });
      expect(revoked.status).toBe(401);

      expect(await stack.sql(
        "SELECT event->'detail'->>'event' AS event FROM vendo_audit WHERE kind = 'door-auth' ORDER BY at",
      )).toEqual(expect.arrayContaining([{ event: "refresh" }, { event: "revoke" }]));
    } finally {
      await stack.close();
    }
  });
});
