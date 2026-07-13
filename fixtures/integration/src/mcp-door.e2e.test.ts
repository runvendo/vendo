/** J6 — MCP DOOR ROUND-TRIP composed around the umbrella's own parts.
 *
 * The `createVendo({ mcp: true })` hookup is an unlanded handoff
 * (docs/contracts/10-mcp-umbrella-hookup.md), so the harness mounts `createMcpDoor`
 * beside `vendo.handler` on the SAME loopback origin, fed the umbrella's composed
 * parts: the guard-bound registry (`vendo.guard.bind(vendo.actions)`), the same
 * `vendo.guard`, `vendo.store`, a fixture `HostOAuthAdapter`, and an `AppsPort`
 * over `vendo.apps`.
 *
 * This journey does NOT re-prove door-internal OAuth conformance (fixtures/mcp-e2e
 * owns that). It proves the door COMPOSES correctly around the umbrella and shares
 * ONE guard / audit / approval plane with chat:
 *   - unauthenticated → 401 + WWW-Authenticate → path-inserted metadata discovery
 *     → OAuth (PKCE, resource) → initialize → tools/list (verbatim vs the bound
 *     registry, incl. the vendo_apps_* capability tools);
 *   - a destructive call PARKS in-band (never a protocol error) naming the
 *     approval, which is visible at GET /approvals ON THE WIRE — then DECIDED over
 *     the wire, and the guard lets the MCP retry through (ONE approvals plane);
 *   - SQL: vendo_audit venue='mcp', door-auth events, door state rows;
 *   - apps ride-along: a wire-created app opens over MCP for real (store read, no
 *     host auth needed).
 *
 * ⚠ COMPOSITION FINDING (see the `it.fails` case below): route-bound HOST tools
 * cannot authenticate over the composed door — `mcpContext` carries no session and
 * `createVendo` exposes `actAs` only for `presence:"away"`, so present MCP host
 * calls reach the host API with no credentials (401). mcp-e2e masks this by
 * injecting an authenticating `fetch` into a hand-built `createActions`; the
 * umbrella exposes no such seam.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  generationTurn,
  resetFixture,
  type Stack,
} from "./harness.js";
import { connectWithSdk, descriptorShape, textOf } from "./mcp-support.js";

const CREATE_DIALECT = {
  name: "MCP ride-along app",
  description: "A rung-1 tree opened over the door",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["hi"] },
      { id: "hi", component: "Text", source: "prewired", props: { text: "Hello over MCP" } },
    ],
  },
};

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J6: MCP door round-trip composed around the umbrella", () => {
  it("discovers, authenticates, lists verbatim, parks in-band, shares one approvals plane with the wire, and opens an app", async () => {
    await resetFixture();
    stack = await createStack({ mcp: true, turns: [generationTurn(CREATE_DIALECT)] });
    const { origin, endpoint } = stack.mcp!;

    // A wire-created app to ride along over the door (store-only, no host auth).
    const app = (await (await stack.wireFetch("/apps", {
      method: "POST",
      body: JSON.stringify({ prompt: "greeting" }),
    }, ADA)).json()) as { id: string };

    // --- 401 + WWW-Authenticate naming the path-inserted metadata URL -------
    const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/api/vendo/mcp`;
    const challenge = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${resourceMetadataUrl}"`);

    // Discovery documents resolve at the origin root (RFC 9728 §3 path-inserted).
    const protectedResource = await fetch(resourceMetadataUrl);
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: endpoint,
      authorization_servers: [endpoint],
    });

    // --- OAuth round trip + initialize via the REAL MCP SDK client ----------
    const connected = await connectWithSdk(endpoint);
    try {
      // The SDK walked discovery → registration → token against the door.
      expect(connected.requests.map(String)).toEqual(expect.arrayContaining([
        resourceMetadataUrl,
        `${endpoint}/token`,
      ]));

      // --- tools/list: descriptors match the bound registry VERBATIM --------
      const listed = await connected.client.listTools();
      const listedByName = new Map(listed.tools.map((tool) => [tool.name, descriptorShape(tool)]));
      for (const descriptor of await stack.mcp!.bound.descriptors()) {
        expect(listedByName.get(descriptor.name)).toEqual({
          name: descriptor.name,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
        });
      }
      // The vendo_apps_* capability tools are served too.
      expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "vendo_apps_create",
        "vendo_apps_open",
        "vendo_apps_list",
      ]));

      // --- Destructive call PARKS in-band (never a JSON-RPC error) ----------
      const parked = await connected.client.callTool({ name: "host_invoices_delete", arguments: { id: "inv_0003" } });
      expect(parked.isError).toBe(true);
      const approvalId = textOf(parked).match(/apr_[0-9a-f-]+/)?.[0];
      expect(approvalId).toMatch(/^apr_/);

      // The MCP-minted approval is on the SAME plane: visible at GET /approvals
      // over the WIRE (venue mcp / present), decided over the wire.
      const pending = (await (await stack.wireFetch("/approvals", {}, ADA)).json()) as Array<{ id: string }>;
      expect(pending.map((request) => request.id)).toContain(approvalId);
      expect(await stack.sql("SELECT id FROM vendo_approvals WHERE id = $1 AND status = 'pending'", [approvalId]))
        .toHaveLength(1);

      expect((await stack.wireFetch("/approvals/decide", {
        method: "POST",
        body: JSON.stringify({
          ids: [approvalId],
          decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
        }),
      }, ADA)).status).toBe(200);

      // ONE approvals plane: the wire decision authorizes the MCP retry — the
      // guard no longer parks it (it proceeds straight to execution, minting no
      // new approval). Robust to the host-auth gap below: whether execution
      // succeeds or errors at the host, the guard did NOT re-ask.
      const retried = await connected.client.callTool({ name: "host_invoices_delete", arguments: { id: "inv_0003" } });
      expect(textOf(retried)).not.toMatch(/apr_/);
      expect(await stack.wireFetch("/approvals", {}, ADA).then((response) => response.json())).toEqual([]);
      // The retry is authorized by the wire-minted grant (05 §6 decidedBy=grant).
      expect(await stack.sql<{ decided_by: string }>(
        `SELECT event->>'decidedBy' AS decided_by FROM vendo_audit
          WHERE kind = 'tool-call' AND tool = 'host_invoices_delete' AND venue = 'mcp'
          ORDER BY at DESC LIMIT 1`,
      )).toEqual([{ decided_by: "grant" }]);

      // --- Apps ride-along: open a wire-created app over the door for real ---
      const opened = await connected.client.callTool({ name: "vendo_apps_open", arguments: { appId: app.id } });
      expect(opened.isError).not.toBe(true);
      expect(textOf(opened)).toContain("vendo-genui/v1");

      // --- SQL: door shares the audit plane, keeps its own protocol state ----
      expect(await stack.sql(
        "SELECT DISTINCT venue FROM vendo_audit WHERE kind = 'tool-call' AND tool = 'host_invoices_delete'",
      )).toEqual([{ venue: "mcp" }]);
      expect(await stack.sql(
        "SELECT DISTINCT venue FROM vendo_audit WHERE kind = 'door-auth'",
      )).toEqual([{ venue: "mcp" }]);
      expect(Number((await stack.sql<{ count: unknown }>(
        "SELECT COUNT(*)::int AS count FROM vendo_mcp_clients",
      ))[0]?.count)).toBeGreaterThanOrEqual(1);
      expect(Number((await stack.sql<{ count: unknown }>(
        "SELECT COUNT(*)::int AS count FROM vendo_mcp_grants",
      ))[0]?.count)).toBeGreaterThanOrEqual(1);
    } finally {
      await connected.close();
    }
  });

  // COMPOSITION FINDING — asserts the CORRECT contract behavior (10-mcp §2: an
  // authenticated MCP tool call gets "identical treatment to chat"). It currently
  // FAILS because the composed umbrella has no seam to authenticate present MCP
  // host-route calls (mcpContext carries no session; actAs is away-only), so the
  // call reaches the host API unauthenticated (401). Remove `.fails` when the
  // umbrella grows a host-call identity seam for the door. Evidence: the read call
  // below returns `http-error: GET /api/invoices → 401`.
  it.fails("a read host tool over the door executes for real against the host app", async () => {
    await resetFixture();
    stack = await createStack({ mcp: true });
    const connected = await connectWithSdk(stack.mcp!.endpoint);
    try {
      const call = await connected.client.callTool({ name: "host_invoices_list", arguments: {} });
      expect(call.isError).not.toBe(true);
      expect(JSON.parse(textOf(call))).toMatchObject({
        invoices: expect.arrayContaining([expect.objectContaining({ id: "inv_0003" })]),
      });
    } finally {
      await connected.close();
    }
  });
});
