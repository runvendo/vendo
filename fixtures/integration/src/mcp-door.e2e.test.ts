/** J6 — MCP DOOR ROUND-TRIP composed around the umbrella's own parts.
 *
 * ┌─ ACCEPTANCE TEST for the v0-mcp-hookup wave ───────────────────────────────┐
 * │ This journey is the acceptance test for the dedicated MCP-hookup wave       │
 * │ (`createVendo({ mcp: true })` + actAs-for-venue="mcp" host auth). When that  │
 * │ wave lands, host-route auth over the door starts working, so it must FLIP    │
 * │ the two fail-closed legs marked `⚑ HOOKUP FLIP` below to green:              │
 * │   1. the `it.fails(...)` "a read host tool over the door executes for real"  │
 * │      → change to `it(...)` and keep the real-invoice assertion; and          │
 * │   2. the retried-destructive assertion in the main test (currently asserts   │
 * │      isError + the 401 gap signature) → assert the real host DELETE landed.  │
 * │ Until then these legs assert the current fail-closed behavior so the gap is  │
 * │ documented, never hidden. Do NOT delete this journey. See the KNOWN GAP      │
 * │ note below and docs/contracts/10-mcp-umbrella-hookup.md.                     │
 * └────────────────────────────────────────────────────────────────────────────┘
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
 * KNOWN GAP (see the second case below): route-bound HOST tools CANNOT authenticate
 * over the composed door under the frozen contracts today. The door correctly mints
 * a session-less `venue:"mcp"` context per 10-mcp §3 (no token-passthrough — the
 * inbound MCP Authorization Bearer is never forwarded, so `mcpContext` carries no
 * requestHeaders), and `actAs` is contractually the AWAY-only, grant-REQUIRED seam
 * (04 §4). There is no present-session host-auth seam in the frozen contracts, so a
 * present MCP host-route call reaches the host API unauthenticated and the host
 * answers 401. This is the real gap this suite surfaces for the
 * `createVendo({ mcp: true })` hookup (docs/contracts/10-mcp-umbrella-hookup.md) to
 * close with a properly designed present-session seam — it is out of scope for this
 * additive test-suite wave. The host-route legs below assert the desired end-state
 * with `it.fails` / an explicit gap assertion so the gap is documented, not hidden.
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
      const boundDescriptors = await stack.mcp!.bound.descriptors();
      for (const descriptor of boundDescriptors) {
        expect(listedByName.get(descriptor.name)).toEqual({
          name: descriptor.name,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
        });
      }
      // EXACT set, not a subset: tools/list serves the bound registry (10-mcp §2
      // "no second catalog" of HOST tools) PLUS exactly the door's own three
      // apps ride-along capability tools (10-mcp §4, door = viewer + runner):
      // vendo_apps_list / vendo_apps_open / vendo_apps_call, served from the
      // composed AppsPort, not the actions registry. Asserting equality against
      // this closed union still fails on ANY unguarded extra surface — a tool in
      // tools/list that is neither a bound descriptor nor a known ride-along tool.
      const APP_RIDE_ALONG = ["vendo_apps_list", "vendo_apps_open", "vendo_apps_call"];
      const expectedNames = [
        ...new Set([...boundDescriptors.map((descriptor) => descriptor.name), ...APP_RIDE_ALONG]),
      ].sort();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(expectedNames);

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
      // new approval). We prove the guard-plane claim WITHOUT asserting host
      // success, because the host DELETE over MCP genuinely cannot succeed today
      // (the same present-session host-auth KNOWN GAP as the second case below).
      const retried = await connected.client.callTool({ name: "host_invoices_delete", arguments: { id: "inv_0003" } });
      // (a) no NEW approval was minted — the guard did not re-ask.
      expect(textOf(retried)).not.toMatch(/apr_/);
      expect(await stack.wireFetch("/approvals", {}, ADA).then((response) => response.json())).toEqual([]);
      // (b) the retry is authorized by the wire-minted grant (05 §6 decidedBy=grant).
      expect(await stack.sql<{ decided_by: string }>(
        `SELECT event->>'decidedBy' AS decided_by FROM vendo_audit
          WHERE kind = 'tool-call' AND tool = 'host_invoices_delete' AND venue = 'mcp'
          ORDER BY at DESC LIMIT 1`,
      )).toEqual([{ decided_by: "grant" }]);
      // (c) the retry's failure mode is the host-auth GAP, NOT an approval park:
      // the guard let it through to real host execution, which 401s because there
      // is no present-session host-auth seam. When the createVendo({ mcp: true })
      // hookup lands that seam (docs/contracts/10-mcp-umbrella-hookup.md), this
      // becomes a real-deletion assert (inv_0003 gone from the host).
      // ⚑ HOOKUP FLIP (2/2): replace these two asserts with a real host-DELETE assert.
      expect(retried.isError).toBe(true);
      expect(textOf(retried)).toMatch(/http-error:.*→ 401/);

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

  // KNOWN GAP (it.fails documents the DESIRED end-state, which does NOT hold today).
  // 10-mcp §2 says an authenticated MCP tool call should get "identical treatment to
  // chat", but a present MCP host-route call cannot authenticate under the composed
  // umbrella: the door mints a session-less venue:"mcp" context (10-mcp §3, no
  // token-passthrough — no requestHeaders), and actAs is the away-only, grant-required
  // seam (04 §4), so there is no frozen-contract seam to mint host AuthMaterial for a
  // present read. The read below therefore reaches the host API unauthenticated and
  // gets `http-error: GET /api/invoices → 401` instead of real invoices. The
  // createVendo({ mcp: true }) hookup (docs/contracts/10-mcp-umbrella-hookup.md) closes
  // this with a properly designed present-session host-auth seam; when it lands, flip
  // `it.fails` back to `it` and this passes.
  // ⚑ HOOKUP FLIP (1/2): change `it.fails` → `it` once host-route auth works.
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
