import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionGrant } from "@vendoai/core";
import type { ExtractedTool } from "../../src/formats.js";
import { createActions, type ActionsRunContext } from "../../src/runtime/registry.js";

/**
 * VEGA-INFO-00037 — the actAs twin of the present-mode SECURITY pin in
 * server.test.ts. A base auto-learned from a spoofable Host is untrusted
 * (baseUrlTrusted:false); production with no VENDO_BASE_URL arms the fail-closed
 * policy. The actAs seam (away, MCP, text-channel) must then refuse to MINT host
 * credentials rather than sending freshly-minted ones to a possibly-poisoned
 * origin — exactly as present-mode refuses to FORWARD the caller's own.
 */
describe("actAs host credentials fail closed on an untrusted base (VEGA-INFO-00037)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function hostServer(): Promise<{ url: string; seen: Array<Record<string, string | string[] | undefined>> }> {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const { port } = server.address() as AddressInfo;
    closers.push(async () => { server.close(); server.closeAllConnections(); });
    return { url: `http://127.0.0.1:${port}`, seen };
  }

  // A relative route binding resolves against the (untrusted, auto-learned) base.
  const probeTool: ExtractedTool = {
    name: "host_write",
    description: "host_write",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "GET", path: "/probe", argsIn: "query" },
  };

  const awayGrant: PermissionGrant = {
    id: "grt_away",
    subject: "user_1",
    tool: "host_write",
    descriptorHash: "sha256:real",
    scope: { kind: "tool" },
    duration: "standing",
    source: "automation",
    grantedAt: "2026-07-13T00:00:00.000Z",
  };
  const awayCtx: ActionsRunContext = {
    principal: { kind: "user", subject: "user_1" },
    venue: "automation",
    presence: "away",
    sessionId: "auto_1",
    grant: awayGrant,
  };
  const mcpCtx: ActionsRunContext = {
    principal: { kind: "user", subject: "user_1" },
    venue: "mcp",
    presence: "present",
    sessionId: "mcps_1",
    mcpConsent: { clientId: "mcpc_x", scopes: ["read", "write"] },
  };

  for (const { label, ctx } of [
    { label: "away", ctx: awayCtx },
    { label: "MCP", ctx: mcpCtx },
  ]) {
    it(`SECURITY: does not mint or send ${label} host credentials to an untrusted base under untrustedOriginPolicy:"fail"`, async () => {
      const host = await hostServer();
      const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act-as-user_1" } }));
      const actions = createActions({
        tools: [probeTool],
        baseUrl: host.url,
        baseUrlTrusted: false,
        untrustedOriginPolicy: "fail",
        actAs,
      });

      const outcome = await actions.execute({ id: "1", tool: "host_write", args: {} }, ctx);

      expect(outcome).toMatchObject({
        status: "error",
        error: { code: "blocked", message: expect.stringContaining("VENDO_BASE_URL") },
      });
      // The mint never runs and the (possibly-poisoned) host never sees the call.
      expect(actAs).not.toHaveBeenCalled();
      expect(host.seen).toHaveLength(0);
    });
  }

  it('mints normally on an untrusted base under the default "warn" policy — dev/self-probe behavior is unchanged', async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act-as-user_1" } }));
    const actions = createActions({
      tools: [probeTool],
      baseUrl: host.url,
      baseUrlTrusted: false, // untrusted, but no fail policy: matches server.test.ts's away doctor probe
      actAs,
    });

    await expect(actions.execute({ id: "1", tool: "host_write", args: {} }, mcpCtx)).resolves.toMatchObject({ status: "ok" });
    expect(actAs).toHaveBeenCalledTimes(1);
    expect(host.seen[0]?.authorization).toBe("Bearer act-as-user_1");
  });
});
