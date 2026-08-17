/**
 * ADVERSARIAL CHECK on the mint that MOVED. The commit lifted the grant write
 * out of the decide path into `mintGrant`/`buildGrant`; every field the old
 * inline code produced is pinned here against the DECIDE path (not against
 * `mintGrant` directly, which is the seam the change added, not the one it
 * risked). Values below are what `git show origin/main:packages/guard/src/
 * guard.ts` wrote at #commitDecidedMember.
 */
import { USE_SERVICE_TOOL, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore, type MemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, FixtureTools } from "./fixtures/tools.js";

const askWrites = { rules: [{ match: { risk: "write" as const }, action: "ask" as const }] };

const dispatcher: ToolDescriptor = {
  name: USE_SERVICE_TOOL,
  description: "dispatch a connector action",
  inputSchema: { type: "object", additionalProperties: true },
  risk: "write",
};

function guardOf(store: MemoryStore) {
  return createGuard({ store, policy: askWrites });
}

async function park(
  guard: ReturnType<typeof guardOf>,
  tools: FixtureTools,
  toolCall: ReturnType<typeof call>,
  ctx = context(),
): Promise<string> {
  const outcome = await guard.bind(tools).execute(toolCall, ctx);
  if (outcome.status !== "pending-approval") throw new Error(`expected a park, got ${outcome.status}`);
  return outcome.approvalId;
}

describe("CHECK: the decide path's grant is field-for-field what the inline mint wrote", () => {
  it("keeps an explicitly remembered tool-wide scope tool-wide on a CONNECTOR dispatch", async () => {
    // The extraction added a scope DERIVATION (slug → service-tool) that the old
    // decide path never had. The decide path always passes an explicit scope, so
    // the derivation must never fire here: a decide that said "tool" must stay
    // "tool", and a decide that said "service-tool" must stay that slug.
    const store = createMemoryStore();
    const guard = guardOf(store);
    const tools = new FixtureTools([dispatcher]);
    const approvalId = await park(
      guard,
      tools,
      call(USE_SERVICE_TOOL, { slug: "GMAIL_SEND_EMAIL", input: {} }, "call_dispatch"),
    );

    await guard.approvals.decide(
      approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );

    const [grant] = await guard.grants.list(alice);
    expect(grant!.scope).toEqual({ kind: "tool" });
    expect(grant!.tool).toBe(USE_SERVICE_TOOL);
  });

  it("re-derives an exact scope from the approved request, never from the caller", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const tools = new FixtureTools();
    const approvalId = await park(guard, tools, call("host_write", { value: 7 }, "call_exact"));

    await guard.approvals.decide(
      approvalId,
      {
        approve: true,
        remember: { scope: { kind: "exact", inputHash: "attacker", inputPreview: "a harmless read" }, duration: "standing" },
      },
      alice,
    );

    const [grant] = await guard.grants.list(alice);
    expect(grant!.scope).toMatchObject({ kind: "exact" });
    expect((grant!.scope as { inputHash: string }).inputHash).not.toBe("attacker");
    expect((grant!.scope as { inputPreview: string }).inputPreview).not.toBe("a harmless read");
  });

  it("binds a session grant to the PARKING conversation", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const sessionAsk = await park(guard, new FixtureTools(), call("host_write", { value: 1 }, "call_session"));

    await guard.approvals.decide(
      sessionAsk,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "session" } },
      alice,
    );

    expect((await guard.grants.list(alice))[0]!.contextKey).toBe("session_1");
  });

  it("binds a task grant to the RUN, falling back to the conversation when there is none", async () => {
    const withRun = guardOf(createMemoryStore());
    const runCtx = context({
      sessionId: "session_2",
      trigger: { automationId: "atm_main", kind: "schedule", runId: "run_9" },
    });
    const taskAsk = await park(withRun, new FixtureTools(), call("host_write", { value: 2 }, "call_task"), runCtx);
    await withRun.approvals.decide(
      taskAsk,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "task" } },
      alice,
    );
    expect((await withRun.grants.list(alice))[0]!.contextKey).toBe("run_9");

    const noRun = guardOf(createMemoryStore());
    const chatAsk = await park(noRun, new FixtureTools(), call("host_write", { value: 3 }, "call_task_chat"));
    await noRun.approvals.decide(
      chatAsk,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "task" } },
      alice,
    );
    expect((await noRun.grants.list(alice))[0]!.contextKey).toBe("session_1");
  });

  it("stamps a single decide as chat, carries the appId and NO automationId, and writes those refs", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const appCtx = context({ appId: "app_1" });
    const single = await park(guard, new FixtureTools(), call("host_write", { value: 1 }, "call_single"), appCtx);

    await guard.approvals.decide(
      single,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );

    const chat = (await guard.grants.list(alice))[0]!;
    expect(chat.source).toBe("chat");
    expect(chat.appId).toBe("app_1");
    expect(chat.automationId).toBeUndefined();
    // The refs a ref-trusting adapter filters on: exactly subject/tool/app_id,
    // which is what the inline code wrote — a chat grant is nobody's automation.
    const record = await store.records("vendo_grants").get(chat.id);
    expect(record!.refs).toEqual({ subject: alice.subject, tool: "host_write", app_id: "app_1" });
  });

  it("stamps a multi-id decide as batch", async () => {
    const guard = guardOf(createMemoryStore());
    const tools = new FixtureTools();
    const appCtx = context({ appId: "app_1" });
    const a = await park(guard, tools, call("host_write", { value: 2 }, "call_batch_a"), appCtx);
    const b = await park(guard, tools, call("host_write", { value: 3 }, "call_batch_b"), appCtx);

    await guard.approvals.decide(
      [a, b],
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );

    const grants = await guard.grants.list(alice);
    expect(grants).toHaveLength(2);
    expect(grants.map((grant) => grant.source)).toEqual(["batch", "batch"]);
  });

  it("stamps the grant with the SUBJECT the approval was parked for", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const tools = new FixtureTools();
    const approvalId = await park(guard, tools, call("host_write", { value: 1 }, "call_subject"));

    await guard.approvals.decide(
      approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );

    expect((await guard.grants.list(alice)).at(-1)!.subject).toBe(alice.subject);
  });
});
