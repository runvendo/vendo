import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import {
  listGrantsRoute,
  revokeGrantRoute,
  listRulesRoute,
  revokeRuleRoute,
  queryAuditRoute,
  listCriticalToolsRoute,
} from "./trust";
import { createInMemoryCompiledRuleStore, createInMemoryGrantStore, InMemoryAuditLog, buildDescriptor } from "@flowlet/runtime";
import { createAutomationsWorld } from "./world";
import { defaultFlowletPolicy } from "./default-policy";
import { automationSpecSchema } from "@flowlet/runtime";

const scope = { tenantId: "flowlet-embedded", subject: "flowlet-default-user" };
const now = () => "2026-07-04T00:00:00Z";

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, { headers: { "content-type": "application/json", host: "localhost" }, ...init });
}

describe("listGrantsRoute", () => {
  it("returns standing GrantStore rows", async () => {
    const grants = createInMemoryGrantStore({ now });
    await grants.create(scope, {
      tool: "GMAIL_SEND_EMAIL", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const res = await listGrantsRoute(req("http://localhost/api/flowlet/grants"), {
      grants, world: null, principal: scope,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: { id?: string; tool: string; source: string }[] };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).toMatchObject({ tool: "GMAIL_SEND_EMAIL", source: "chat" });
    expect(body.grants[0]?.id).toBeTruthy();
  });

  it("federates automation-version grants as read-only rows with no id", async () => {
    const grants = createInMemoryGrantStore({ now });
    const world = createAutomationsWorld({
      policy: defaultFlowletPolicy,
      model: { modelId: "stub" } as unknown as LanguageModel,
      scope,
    });
    const spec = automationSpecSchema.parse({
      dslVersion: 1, name: "Morning chase", description: "d", prompt: "p",
      trigger: { type: "host_event", event: "transaction.created" },
      execution: { mode: "steps", steps: [{ id: "s1", type: "tool", tool: "GMAIL_SEND_EMAIL", input: {} }] },
    });
    await world.store.create(scope, {
      spec,
      grants: [{ tool: "GMAIL_SEND_EMAIL", descriptorHash: "h1", scopeHash: "s1", grantedAt: now() }],
    });
    const res = await listGrantsRoute(req("http://localhost/api/flowlet/grants"), {
      grants, world, principal: scope,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grants: { id?: string; tool: string; source: string; automationName?: string }[];
    };
    const automationRow = body.grants.find((g) => g.source === "automation");
    expect(automationRow).toMatchObject({ tool: "GMAIL_SEND_EMAIL", automationName: "Morning chase" });
    expect(automationRow?.id).toBeUndefined();
  });
});

describe("revokeGrantRoute", () => {
  it("revokes a live grant", async () => {
    const grants = createInMemoryGrantStore({ now });
    const audit = new InMemoryAuditLog();
    const grant = await grants.create(scope, {
      tool: "GMAIL_SEND_EMAIL", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const res = await revokeGrantRoute(
      req("http://localhost/api/flowlet/grants/revoke", { method: "POST", body: JSON.stringify({ id: grant.id }) }),
      { grants, audit, principal: scope },
    );
    expect(res.status).toBe(200);
    expect(await grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
  });

  it("404s an unknown grant id", async () => {
    const grants = createInMemoryGrantStore({ now });
    const audit = new InMemoryAuditLog();
    const res = await revokeGrantRoute(
      req("http://localhost/api/flowlet/grants/revoke", { method: "POST", body: JSON.stringify({ id: "nope" }) }),
      { grants, audit, principal: scope },
    );
    expect(res.status).toBe(404);
  });

  it("400s a malformed body", async () => {
    const grants = createInMemoryGrantStore({ now });
    const audit = new InMemoryAuditLog();
    const res = await revokeGrantRoute(
      req("http://localhost/api/flowlet/grants/revoke", { method: "POST", body: JSON.stringify({}) }),
      { grants, audit, principal: scope },
    );
    expect(res.status).toBe(400);
  });
});

describe("listGrantsRoute — compiled-rule plainText (ENG-193 item 6)", () => {
  it("carries a compiled-rule grant's source.rule through as plainText", async () => {
    const grants = createInMemoryGrantStore({ now });
    await grants.create(scope, {
      tool: "send_email", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "compiled-rule", rule: "don't ask about invoices" },
    });
    const res = await listGrantsRoute(req("http://localhost/api/flowlet/grants"), {
      grants, world: null, principal: scope,
    });
    const body = (await res.json()) as { grants: { plainText?: string; source: string }[] };
    expect(body.grants[0]).toMatchObject({ source: "compiled-rule", plainText: "don't ask about invoices" });
  });
});

describe("listRulesRoute", () => {
  it("returns an empty list from a fresh store", async () => {
    const rules = createInMemoryCompiledRuleStore({ now });
    const res = await listRulesRoute(req("http://localhost/api/flowlet/rules"), { rules, principal: scope });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [] });
  });

  it("returns live rules as TrustRuleRows", async () => {
    const rules = createInMemoryCompiledRuleStore({ now });
    const rule = await rules.create(scope, {
      kind: "always_ask", toolPattern: "sendClientMessage", plainText: "sending client messages",
    });
    const res = await listRulesRoute(req("http://localhost/api/flowlet/rules"), { rules, principal: scope });
    const body = (await res.json()) as { rules: { id: string; toolPattern: string; plainText: string; since: string }[] };
    expect(body.rules).toEqual([
      { id: rule.id, toolPattern: "sendClientMessage", plainText: "sending client messages", since: now() },
    ]);
  });
});

describe("revokeRuleRoute", () => {
  it("revokes a live rule and drops it from a follow-up list", async () => {
    const rules = createInMemoryCompiledRuleStore({ now });
    const audit = new InMemoryAuditLog();
    const rule = await rules.create(scope, {
      kind: "always_ask", toolPattern: "sendClientMessage", plainText: "sending client messages",
    });
    const res = await revokeRuleRoute(
      req("http://localhost/api/flowlet/rules/revoke", { method: "POST", body: JSON.stringify({ id: rule.id }) }),
      { rules, audit, principal: scope },
    );
    expect(res.status).toBe(200);
    const list = await listRulesRoute(req("http://localhost/api/flowlet/rules"), { rules, principal: scope });
    expect(await list.json()).toEqual({ rules: [] });
  });

  it("404s an unknown rule id", async () => {
    const rules = createInMemoryCompiledRuleStore({ now });
    const res = await revokeRuleRoute(
      req("http://localhost/api/flowlet/rules/revoke", { method: "POST", body: JSON.stringify({ id: "nope" }) }),
      { rules, audit: new InMemoryAuditLog(), principal: scope },
    );
    expect(res.status).toBe(404);
  });

  it("400s a malformed body", async () => {
    const rules = createInMemoryCompiledRuleStore({ now });
    const res = await revokeRuleRoute(
      req("http://localhost/api/flowlet/rules/revoke", { method: "POST", body: JSON.stringify({}) }),
      { rules, audit: new InMemoryAuditLog(), principal: scope },
    );
    expect(res.status).toBe(400);
  });
});

describe("queryAuditRoute", () => {
  it("honors ?sinceMs= and returns rows newest-first", async () => {
    const audit = new InMemoryAuditLog();
    await audit.append({ at: "2026-07-01T00:00:00Z", principal: scope, kind: "automation_firing", automationId: "a1", runId: "r1" });
    await audit.append({ at: "2026-07-03T00:00:00Z", principal: scope, kind: "automation_firing", automationId: "a1", runId: "r2" });
    const res = await queryAuditRoute(
      req(`http://localhost/api/flowlet/audit?sinceMs=${Date.parse("2026-07-02T00:00:00Z")}`),
      { audit, principal: scope },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { at: string }[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.at).toBe("2026-07-03T00:00:00Z");
  });
});

describe("listCriticalToolsRoute", () => {
  it("returns only critical-tier tools", async () => {
    const resolveDescriptor = (name: string) =>
      name === "transfer_money"
        ? buildDescriptor(name, { annotations: { destructiveHint: true } }, "caller")
        : name === "get_balance"
          ? buildDescriptor(name, { annotations: { readOnlyHint: true } }, "caller")
          : undefined;
    const res = await listCriticalToolsRoute(req("http://localhost/api/flowlet/critical-tools"), {
      toolNames: ["transfer_money", "get_balance"], resolveDescriptor,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string }[] };
    expect(body.tools).toEqual([{ name: "transfer_money" }]);
  });
});
