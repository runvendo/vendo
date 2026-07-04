import { describe, it, expect } from "vitest";
import { hashDescriptor, type FlowletPrincipal } from "@flowlet/runtime";
import { demoPolicy } from "./policy";
import { demoStore, CADENCE_SCOPE } from "./store";
import { resolveToolDescriptor } from "./tool-registry";

const PRINCIPAL: FlowletPrincipal = { userId: "test" };

function evaluate(toolName: string, executor?: "client", annotations?: Record<string, boolean>) {
  return demoPolicy.evaluate({
    toolName,
    input: {},
    descriptor: {
      name: toolName,
      source: executor === "client" ? "caller" : "caller",
      ...(executor ? { executor } : {}),
      annotations: annotations ?? {},
      hasExecute: executor !== "client",
      kind: "function",
    } as never,
    principal: PRINCIPAL,
  });
}

describe("demoPolicy", () => {
  it("allows the render tool and the in-process reads", async () => {
    for (const name of [
      "render_view",
      "get_dashboard",
      "get_clients",
      "get_client_documents",
      "get_deadlines",
      "get_activity",
      "list_automations",
      "get_automation_runs",
    ]) {
      expect(await evaluate(name), name).toBe("allow");
    }
  });

  it("gates automation authoring writes", async () => {
    for (const name of ["create_automation", "update_automation", "delete_automation", "pause_automation", "run_automation_now"]) {
      expect(await evaluate(name), name).toBe("approve");
    }
  });

  it("decides host-API tools from annotations (reads allow, writes approve)", async () => {
    expect(await evaluate("listClients", "client", { readOnlyHint: true })).toBe("allow");
    expect(await evaluate("sendClientMessage", "client", { readOnlyHint: false })).toBe("approve");
  });

  it("gates Composio write verbs and allows read verbs by whole segment", async () => {
    expect(await evaluate("GMAIL_SEND_EMAIL")).toBe("approve");
    expect(await evaluate("GOOGLECALENDAR_CREATE_EVENT")).toBe("approve");
    expect(await evaluate("GMAIL_FETCH_EMAILS")).toBe("allow");
    expect(await evaluate("GOOGLECALENDAR_LIST_CALENDARS")).toBe("allow");
    // A write verb wins even when a read verb is also present.
    expect(await evaluate("GOOGLEDOCS_FIND_AND_REPLACE")).toBe("approve");
    // An unanchored substring must not auto-allow (BUDGET contains GET).
    expect(await evaluate("SOMETOOL_BUDGET_TOTALS")).toBe("approve");
  });

  it("fails safe to approval for unknown names", async () => {
    expect(await evaluate("mystery_tool")).toBe("approve");
  });

  it("a matching grant suppresses a repeat act-tier approve, but never a critical one", async () => {
    // ENG-193 item 2 (§4.3): demoPolicy now composes grantPolicy+auditPolicy
    // onto namePolicy (Task 7). Use resolveToolDescriptor's own descriptor for
    // both the grant's descriptorHash AND the evaluated ctx — grantMatches
    // requires an EXACT descriptor hash match, so this is the only descriptor
    // shape that will actually round-trip (the `evaluate()` helper above
    // fabricates its own descriptor, which won't hash-match).
    const gmailDescriptor = resolveToolDescriptor("GMAIL_SEND_EMAIL")!;
    await demoStore.grants.create(CADENCE_SCOPE, {
      tool: "GMAIL_SEND_EMAIL",
      descriptorHash: hashDescriptor(gmailDescriptor),
      scope: { kind: "tool" },
      duration: "standing",
      source: { kind: "chat" },
    });
    expect(
      await demoPolicy.evaluate({
        toolName: "GMAIL_SEND_EMAIL",
        input: {},
        descriptor: gmailDescriptor,
        principal: PRINCIPAL,
      }),
    ).toBe("allow");

    // INVARIANT: even a grant seeded for a critical (destructiveHint) tool
    // never suppresses it — grantPolicy refuses to apply by type, before any
    // grant lookup.
    const criticalDescriptor = resolveToolDescriptor("create_automation")!;
    await demoStore.grants.create(CADENCE_SCOPE, {
      tool: "create_automation",
      descriptorHash: hashDescriptor(criticalDescriptor),
      scope: { kind: "tool" },
      duration: "standing",
      source: { kind: "chat" },
    });
    expect(
      await demoPolicy.evaluate({
        toolName: "create_automation",
        input: {},
        descriptor: criticalDescriptor,
        principal: PRINCIPAL,
      }),
    ).toBe("approve");
  });
});
