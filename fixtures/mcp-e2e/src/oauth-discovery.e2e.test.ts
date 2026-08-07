import { beforeEach, describe, expect, it } from "vitest";
import { createStack, hostTools, MCP_MOUNT, resetFixture } from "./harness.js";
import {
  authorizeCode,
  connectWithSdk,
  descriptorShape,
  exchangeCode,
  registerClient,
  textOf,
  VERIFIER,
} from "./support.js";

describe("MCP OAuth discovery and SDK round trip", () => {
  beforeEach(resetFixture);

  it("discovers, dynamically registers, authorizes, initializes, lists, and calls through the real SDK", async () => {
    const stack = await createStack();
    try {
      const challenge = await fetch(stack.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      const resourceMetadataUrl = `${stack.origin}/.well-known/oauth-protected-resource${MCP_MOUNT}`;
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${resourceMetadataUrl}"`,
      );

      const protectedResource = await fetch(resourceMetadataUrl);
      expect(protectedResource.status).toBe(200);
      expect(await protectedResource.json()).toEqual({
        resource: stack.endpoint,
        authorization_servers: [stack.endpoint],
        bearer_methods_supported: ["header"],
      });
      const authorizationMetadataUrl = `${stack.origin}/.well-known/oauth-authorization-server${MCP_MOUNT}`;
      const authorizationMetadata = await fetch(authorizationMetadataUrl);
      expect(authorizationMetadata.status).toBe(200);
      expect(await authorizationMetadata.json()).toMatchObject({
        issuer: stack.endpoint,
        authorization_endpoint: `${stack.endpoint}/authorize`,
        token_endpoint: `${stack.endpoint}/token`,
        registration_endpoint: `${stack.endpoint}/register`,
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
      });

      const coldCard = await fetch(`${stack.origin}/.well-known/mcp-server-card`);
      expect(await coldCard.json()).toMatchObject({
        transports: [{ type: "streamable-http", url: `${stack.origin}/mcp` }],
      });

      const connected = await connectWithSdk(stack);
      try {
        expect(connected.requests.map(String)).toEqual(expect.arrayContaining([
          resourceMetadataUrl,
          authorizationMetadataUrl,
          `${stack.endpoint}/register`,
          `${stack.endpoint}/token`,
        ]));
        expect(await stack.sql("SELECT id FROM vendo_mcp_clients")).toHaveLength(1);
        expect(await stack.sql<{ resource: string }>(
          "SELECT data->>'resource' AS resource FROM vendo_mcp_grants WHERE data->>'kind' = 'access'",
        )).toEqual([{ resource: stack.endpoint }]);

        const listed = await connected.client.listTools();
        const hostNames = new Set(hostTools.map(({ name }) => name));
        expect(listed.tools.filter((tool) => hostNames.has(tool.name as never)).map(descriptorShape)).toEqual(
          (await stack.bound.descriptors()).map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        );
        expect(listed.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
          "vendo_apps_list",
          "vendo_apps_open",
          "vendo_apps_call",
        ]));

        const call = await connected.client.callTool({ name: "host_invoices_list", arguments: {} });
        expect(call.isError).not.toBe(true);
        expect(JSON.parse(textOf(call))).toMatchObject({
          invoices: expect.arrayContaining([expect.objectContaining({ id: "inv_0003" })]),
        });

        const learnedCard = await fetch(`${stack.origin}/.well-known/mcp/server-card.json`);
        expect(await learnedCard.json()).toMatchObject({
          transports: [{ type: "streamable-http", url: stack.endpoint }],
          authorization: { resource_metadata: resourceMetadataUrl },
        });
      } finally {
        await connected.close();
      }

      const manual = await registerClient(stack);
      expect(manual.response.status).toBe(201);
      const authorization = await authorizeCode(stack, manual.body.client_id);
      const code = new URL(authorization.headers.get("location") ?? "").searchParams.get("code");
      if (!code) throw new Error("Manual authorization omitted code");
      const wrongResource = await exchangeCode(stack, {
        code,
        client_id: manual.body.client_id,
        code_verifier: VERIFIER,
        resource: "https://evil.example/mcp",
      });
      expect(wrongResource.status).toBe(400);
      expect(await wrongResource.json()).toMatchObject({ error: "invalid_target" });
    } finally {
      await stack.close();
    }
  });
});
