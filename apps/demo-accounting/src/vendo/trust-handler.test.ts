import { afterEach, describe, expect, it } from "vitest";
import {
  handleDemoGrantsList,
  handleDemoGrantsRevoke,
  handleDemoRulesList,
  handleDemoRulesRevoke,
  handleDemoAuditQuery,
  handleDemoCriticalTools,
} from "./trust-handler";
import { demoStore, CADENCE_SCOPE } from "./store";

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    headers: { "content-type": "application/json", host: "localhost", ...init.headers },
    ...init,
  });
}

describe("Trust-screen demo handlers", () => {
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.VENDO_DEMO_PUBLIC;
  });

  it("lists standing grants", async () => {
    const grant = await demoStore.grants.create(CADENCE_SCOPE, {
      tool: "sendClientMessage", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const res = await handleDemoGrantsList(req("http://localhost/api/vendo/grants"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: { id?: string; tool: string; source: string }[] };
    expect(body.grants.some((g) => g.id === grant.id && g.tool === "sendClientMessage")).toBe(true);
  });

  it("revokes a live grant, 404s an unknown one, 400s a malformed body", async () => {
    const grant = await demoStore.grants.create(CADENCE_SCOPE, {
      tool: "listClients", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const okRes = await handleDemoGrantsRevoke(
      req("http://localhost/api/vendo/grants/revoke", { method: "POST", body: JSON.stringify({ id: grant.id }) }),
    );
    expect(okRes.status).toBe(200);
    expect(await demoStore.grants.findForTool(CADENCE_SCOPE, "listClients")).toHaveLength(0);

    const missingRes = await handleDemoGrantsRevoke(
      req("http://localhost/api/vendo/grants/revoke", { method: "POST", body: JSON.stringify({ id: "nope" }) }),
    );
    expect(missingRes.status).toBe(404);

    const malformedRes = await handleDemoGrantsRevoke(
      req("http://localhost/api/vendo/grants/revoke", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(malformedRes.status).toBe(400);
  });

  it("carries a compiled-rule grant's source.rule through as plainText (ENG-193 item 6)", async () => {
    await demoStore.grants.create(CADENCE_SCOPE, {
      tool: "sendClientMessage", descriptorHash: "h9", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "compiled-rule", rule: "sending client messages" },
    });
    const res = await handleDemoGrantsList(req("http://localhost/api/vendo/grants"));
    const body = (await res.json()) as { grants: { source: string; plainText?: string }[] };
    const row = body.grants.find((g) => g.source === "compiled-rule");
    expect(row?.plainText).toBe("sending client messages");
  });

  it("lists live rules and revokes them (ENG-193 item 6)", async () => {
    const rule = await demoStore.rules.create(CADENCE_SCOPE, {
      kind: "always_ask", toolPattern: "sendClientMessage", plainText: "sending client messages",
    });
    const listRes = await handleDemoRulesList(req("http://localhost/api/vendo/rules"));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { rules: { id: string; toolPattern: string; plainText: string }[] };
    expect(listBody.rules.some((r) => r.id === rule.id && r.plainText === "sending client messages")).toBe(true);

    const okRes = await handleDemoRulesRevoke(
      req("http://localhost/api/vendo/rules/revoke", { method: "POST", body: JSON.stringify({ id: rule.id }) }),
    );
    expect(okRes.status).toBe(200);
    const after = (await (await handleDemoRulesList(req("http://localhost/api/vendo/rules"))).json()) as {
      rules: { id: string }[];
    };
    expect(after.rules.some((r) => r.id === rule.id)).toBe(false);

    const missingRes = await handleDemoRulesRevoke(
      req("http://localhost/api/vendo/rules/revoke", { method: "POST", body: JSON.stringify({ id: "nope" }) }),
    );
    expect(missingRes.status).toBe(404);

    const malformedRes = await handleDemoRulesRevoke(
      req("http://localhost/api/vendo/rules/revoke", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(malformedRes.status).toBe(400);
  });

  it("queries the audit log honoring sinceMs", async () => {
    await demoStore.audit.append({ at: "2026-07-01T00:00:00Z", principal: CADENCE_SCOPE, kind: "automation_firing", automationId: "a1", runId: "r1" });
    await demoStore.audit.append({ at: "2026-07-04T00:00:00Z", principal: CADENCE_SCOPE, kind: "automation_firing", automationId: "a1", runId: "r2" });
    const res = await handleDemoAuditQuery(
      req(`http://localhost/api/vendo/audit?sinceMs=${Date.parse("2026-07-02T00:00:00Z")}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { at: string }[] };
    expect(body.events.every((e) => Date.parse(e.at) >= Date.parse("2026-07-02T00:00:00Z"))).toBe(true);
  });

  it("lists only critical tools", async () => {
    const res = await handleDemoCriticalTools(req("http://localhost/api/vendo/critical-tools"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string }[] };
    expect(body.tools.some((t) => t.name === "setDocumentStatus")).toBe(true);
    expect(body.tools.some((t) => t.name === "get_deadlines")).toBe(false);
  });

  it("guards every route against non-local requests", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const deployedReq = (url: string, init: RequestInit = {}) =>
      req(url, { ...init, headers: { ...init.headers, host: "deployed.example.com" } });

    expect((await handleDemoGrantsList(deployedReq("https://deployed.example.com/api/vendo/grants"))).status).toBe(403);
    expect(
      (await handleDemoGrantsRevoke(
        deployedReq("https://deployed.example.com/api/vendo/grants/revoke", { method: "POST", body: JSON.stringify({ id: "x" }) }),
      )).status,
    ).toBe(403);
    expect((await handleDemoRulesList(deployedReq("https://deployed.example.com/api/vendo/rules"))).status).toBe(403);
    expect(
      (await handleDemoRulesRevoke(
        deployedReq("https://deployed.example.com/api/vendo/rules/revoke", { method: "POST", body: JSON.stringify({ id: "x" }) }),
      )).status,
    ).toBe(403);
    expect((await handleDemoAuditQuery(deployedReq("https://deployed.example.com/api/vendo/audit"))).status).toBe(403);
    expect((await handleDemoCriticalTools(deployedReq("https://deployed.example.com/api/vendo/critical-tools"))).status).toBe(403);
  });
});
