import { describe, it, expect } from "vitest";
import { hashDescriptor, type VendoPrincipal } from "@vendoai/runtime";
import { demoPolicy } from "./policy";
import { demoStore, CADENCE_SCOPE } from "./store";
import { resolveToolDescriptor } from "./tool-registry";

const PRINCIPAL: VendoPrincipal = { userId: "test" };

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
      "edit_view",
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

  it("a matching always_ask rule forces approve even on an ALWAYS_ALLOW'd tool name (ENG-193 item 6)", async () => {
    // get_deadlines is in ALWAYS_ALLOW (name-policy fast path) — a rule must
    // still beat it. Descriptor is act-shaped (not read) so the rules layer's
    // "reads just flow" exemption doesn't apply.
    const rule = await demoStore.rules.create(CADENCE_SCOPE, {
      kind: "always_ask", toolPattern: "get_deadlines", plainText: "checking deadlines",
    });
    expect(
      await demoPolicy.evaluate({
        toolName: "get_deadlines",
        input: {},
        descriptor: { name: "get_deadlines", source: "caller", annotations: {}, hasExecute: true, kind: "function" } as never,
        principal: PRINCIPAL,
      }),
    ).toBe("approve");
    await demoStore.rules.revoke(CADENCE_SCOPE, rule.id); // don't leak into other tests
  });

  it("with a judge configured, a matching grant is still gated on a judge escalation (composition smoke test)", async () => {
    // Exercises the SAME composition shape demoPolicy uses, with a scripted
    // mock model — proves the wiring, not the env var (which stays unset in CI).
    const { annotationPolicy, judgePolicy, cautionBreaker, volumeBreaker, createBreakerState, grantPolicy, composePolicy } =
      await import("@vendoai/runtime");
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "escalate: unusual" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
        warnings: [],
      }),
    });
    const state = createBreakerState();
    const stack = composePolicy(
      volumeBreaker(cautionBreaker(judgePolicy(grantPolicy(annotationPolicy(), demoStore.grants, {
        principalScope: () => CADENCE_SCOPE, contextKey: (ctx: { threadId?: string }) => ctx.threadId,
      }), { model }), state), state),
    );
    const result = await stack.evaluate({
      toolName: "GMAIL_SEND_EMAIL", input: {},
      descriptor: { name: "GMAIL_SEND_EMAIL", source: "composio", annotations: {}, hasExecute: true, kind: "function" },
      principal: PRINCIPAL, threadId: "th-1",
    } as never);
    expect(result).toBe("approve");
  });
});
