/**
 * THE OUTSIDE-AGENT PIN — what a real external MCP client sees, and what the
 * door-ctx lane promised would not move.
 *
 * The door-ctx lane teaches the door to carry a live turn's accountability
 * context (venue, presence, the turn's own approval card, THE LAW's §12
 * withholding, the transcript mirror). Every one of those is ADDITIVE, for a
 * caller that legitimately has a turn. A client that came in the only way an
 * outside agent can — `/register` → `/authorize` → `/token`, PKCE, no turn —
 * must keep TODAY'S behavior exactly.
 *
 * So this file was written and run GREEN against the unmodified door FIRST, and
 * every assertion below is a measurement of that run, not a wish. If closing a
 * divergence for turn-bearing callers moves anything an outside agent can see,
 * it fails here.
 *
 * Read with `mcp-door-parity.e2e.test.ts` (the turn-bearing half) — both drive
 * the same composed host and the same minimal MCP client from
 * `mcp-door.test-util.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  MOUNT,
  READ_TOOL,
  SUBJECT,
  WRITE_TOOL,
  bearer,
  composedHost,
  openDoor,
  rowsAddedBy,
  runCleanups,
  shapeOf,
} from "../src/mcp-door.test-util.js";

afterEach(runCleanups);

const rpcBody = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });

const INITIALIZE = rpcBody("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "outside", version: "1.0.0" },
});

describe("the MCP door, as an OUTSIDE agent sees it — pinned before door-ctx", () => {
  it("lists the host's tools VERBATIM, plus the apps ride-alongs, with the risk annotations derived from ONE label", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const listed = await door.listTools();
    const byName = new Map(listed.map((tool) => [tool.name, tool]));

    // The host's own two, described in the REGISTRY's words (10-mcp §2).
    expect(byName.get(READ_TOOL)?.description).toBe("Look something up for the signed-in customer");
    expect(byName.get(READ_TOOL)?.annotations).toEqual({
      title: "Look something up",
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get(WRITE_TOOL)?.annotations).toEqual({
      title: "Send a payment",
      readOnlyHint: false,
      destructiveHint: false,
    });
    // The WHOLE offered surface, measured. The host's two plus every runtime
    // tool the composed umbrella registers — the `vendo_*` namespace is never
    // curated away (10-mcp §2), and `ask_user`/`schedule`/`validate`/
    // `search_components` are the runtime's own. Pinned as a SET so closing a
    // divergence cannot quietly add or withhold one from an outside agent.
    expect([...byName.keys()].sort()).toEqual([
      "ask_user",
      "host_lookup",
      "host_pay",
      "schedule",
      "search_components",
      "validate",
      "vendo_apps_call",
      "vendo_apps_data_delete",
      "vendo_apps_data_list",
      "vendo_apps_data_put",
      "vendo_apps_list",
      "vendo_apps_open",
      "vendo_apps_pin",
      "vendo_apps_rebase_pin",
      "vendo_apps_unpin",
      // The one-tool contract's whole point for MCP: an outside agent asks for a
      // screen through `vendo_make` and never has to decide "new or change?"
      // first. Losing it from this list is losing the front door.
      "vendo_make",
    ]);
  });

  it("a READ the policy runs: ok · rule · present · mcp · the granted subject", async () => {
    const { vendo, store } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const rows = await rowsAddedBy(store, READ_TOOL, async () => {
      const answered = await door.callTool(READ_TOOL, { query: "balance" });
      expect(answered.isError).toBeFalsy();
    });
    expect(rows).toHaveLength(1);
    expect(shapeOf(rows[0])).toEqual({
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
  });

  it("a WRITE the policy parks: the IN-BAND 'resolve it there, then retry', and a pending-approval row", async () => {
    const { vendo, store } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const rows = await rowsAddedBy(store, WRITE_TOOL, async () => {
      const answered = await door.callTool(WRITE_TOOL, { amount: 1400 });
      expect(answered.isError).toBe(true);
      // The exact sentence: an outside client has no stream to receive a card on,
      // so the door names the queue and asks for a retry. This is the behavior
      // the turn-bearing path REPLACES, and the one this path keeps.
      expect(answered.text).toContain("needs approval");
      expect(answered.text).toContain("retry");
    });
    expect(shapeOf(rows.at(-1))).toEqual({
      outcome: "pending-approval",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
  });

  it("an unknown tool answers in-band, never as a JSON-RPC protocol error", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const answered = await door.callTool("host_not_a_tool", {});
    expect(answered.isError).toBe(true);
    expect(answered.text).toContain("not-found");
  });

  it("no bearer is a 401 carrying the protected-resource challenge", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const bare = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: INITIALIZE,
    }));
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toContain("resource_metadata=");
    // No token was presented, so the challenge must NOT claim the token was bad.
    expect(bare.headers.get("www-authenticate")).not.toContain("invalid_token");
  });

  it("an invented bearer is a 401 — a grant only exists at the end of the PKCE flow", async () => {
    const { vendo } = await composedHost(async () => undefined);
    for (const invented of ["bxt_a-token-the-harness-minted", "vtk_looks-like-a-turn-credential", "totally-made-up"]) {
      const answered = await vendo.handler(new Request(MOUNT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${invented}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: INITIALIZE,
      }));
      expect(answered.status, invented).toBe(401);
      expect(answered.headers.get("www-authenticate"), invented).toContain("invalid_token");
    }
  });

  it("a session id belongs to the grant that opened it — another client's bearer cannot drive it", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const first = await bearer(vendo);

    // Open a session on the first grant and learn its id.
    const opened = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: INITIALIZE,
    }));
    const sessionId = opened.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^mcps_/);

    // A SECOND registered client, same subject, its own grant. It may not reach
    // the first client's session.
    const second = await bearer(vendo);
    const stolen = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${second}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!,
      },
      body: rpcBody("tools/list"),
    }));
    expect(stolen.status).toBe(404);
  });
});
