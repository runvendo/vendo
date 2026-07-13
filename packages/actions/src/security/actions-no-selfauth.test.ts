import type { RunContext } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { mcpConnector } from "../connectors/mcp.js";
import type { ExtractedTool } from "../formats.js";
import { createActions, type ActionsRunContext } from "../runtime/registry.js";

// Red-team suite for @vendoai/actions authorization posture (04-actions).
// Actions does NOT self-authorize. It executes exactly what it is handed and relies
// on the guard binding (which the umbrella always wraps around it) to be the gate.
// The adversarial concern is the inverse of most auth code: actions must NEVER
// silently execute an away (act-as-user) call on its own. Away execution requires the
// host's explicit actAs seam AND a captured grant; absent either, it errors cleanly.

const routeTool = (name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  risk: "read",
  binding: { kind: "route", method: "GET", path: "/probe", argsIn: "query" },
  ...extras,
});

const present: RunContext = {
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

const away: RunContext = { ...present, presence: "away" };

describe("actions never self-authorizes away execution", () => {
  it("returns a clean not-implemented error for an away call when actAs is absent", async () => {
    const fetchSpy = vi.fn();
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: "http://host.test",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const outcome = await actions.execute({ id: "1", tool: "host_probe", args: {} }, away);

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-implemented" } });
    // The critical property: NO outbound request happened. It never ran as the user.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an away call that has actAs but NO captured grant", async () => {
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer host-issued" } }));
    const fetchSpy = vi.fn();
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: "http://host.test",
      actAs,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    // ctx.grant is undefined — the guard binding never captured one.
    const outcome = await actions.execute({ id: "1", tool: "host_probe", args: {} }, away);

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(actAs).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses host-issued credentials (not the caller's headers) for a properly-granted away call", async () => {
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer host-issued" } }));
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: "http://host.test",
      actAs,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const grantedAway: ActionsRunContext = {
      ...away,
      requestHeaders: { cookie: "should_not_be_forwarded_when_away" },
      grant: {
        id: "grt_1",
        subject: "user_1",
        tool: "host_probe",
        descriptorHash: "hash",
        scope: { kind: "tool" },
        duration: "standing",
        source: "automation",
        grantedAt: "2026-07-12T00:00:00.000Z",
      },
    };

    await expect(actions.execute({ id: "1", tool: "host_probe", args: {} }, grantedAway))
      .resolves.toMatchObject({ status: "ok" });
    expect(actAs).toHaveBeenCalledTimes(1);
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    // Away carries the host-issued authority, NOT the inbound present-session cookie.
    expect(headers.authorization).toBe("Bearer host-issued");
    expect(headers.cookie).toBeUndefined();
  });

  it("forwards the caller's requestHeaders on a same-origin PRESENT call", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: "http://host.test",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const ctx: RunContext = {
      ...present,
      requestHeaders: { cookie: "session=user_1", authorization: "Bearer inbound" },
    };
    await expect(actions.execute({ id: "1", tool: "host_probe", args: {} }, ctx))
      .resolves.toMatchObject({ status: "ok" });

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.cookie).toBe("session=user_1");
    expect(headers.authorization).toBe("Bearer inbound");
  });

  it("treats an unannotated connector tool as risk=write (conservative default)", async () => {
    // The MCP connector maps annotations -> risk; an unannotated tool is NOT assumed
    // read-only. Conservative default = "write" so the guard treats it as mutating.
    const fetchStub = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "{}") as { method: string; id?: number };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "do_thing", description: "unannotated" }] },
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const connector = mcpConnector({ url: "http://mcp.test", name: "srv" });
      const descriptors = await connector.descriptors();
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]?.risk).toBe("write");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
