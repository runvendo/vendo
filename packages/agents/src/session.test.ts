/**
 * The seam test: a real embedded store, the real guard, the real
 * `createHarnessRuntime` — only the thinker is scripted, because the thinker
 * is deliberately not what is under test (CLAUDE.md: test the SEAM).
 */
import { VendoError, type ApprovalRequest, type RunContext, type Turn } from "@vendoai/core";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, threadMessageStore, threadStore } from "@vendoai/store";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agent } from "./agent.js";
import { tool } from "./tools.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-session-${stores++}` });

const principal = { kind: "user" as const, subject: "u_42" };

const speaks = (text: string) =>
  defineHarness({
    name: "speaks",
    async *run() {
      yield { type: "text" as const, delta: text };
    },
  });

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session", () => {
  it("opens a thread the store recognizes", async () => {
    const store = memoryStore();
    const support = agent({ name: "support", harness: speaks("hi"), store });
    const session = await support.session("u_42");
    expect(session.threadId).toMatch(/^thr_/);
    expect(await threadStore(store).get(principal, session.threadId as never)).not.toBeNull();
  });

  it("streams a turn and the transcript truth is the runtime's — persisted, both sides", async () => {
    const store = memoryStore();
    const support = agent({ name: "support", harness: speaks("hello from the harness"), store });
    const session = await support.session("u_42");
    const response = await session.stream("hello from the user");
    expect(await response.text()).toContain("hello from the harness");
    const messages = await threadMessageStore(store).list(principal, session.threadId as never);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("a second turn hands the harness the whole prior conversation", async () => {
    const store = memoryStore();
    let seen: readonly unknown[] = [];
    const peek = defineHarness({
      name: "peek",
      async *run(turn) {
        seen = turn.messages;
        yield { type: "text" as const, delta: "ok" };
      },
    });
    const support = agent({ name: "support", harness: peek, store });
    const session = await support.session("u_42");
    await (await session.stream("first")).text();
    await (await session.stream("second")).text();
    expect(seen).toHaveLength(3); // user, assistant, user
  });

  it("assembles the per-turn system prompt: instructions, [User], the guard's directions", async () => {
    let system: string | undefined;
    const peek = defineHarness({
      name: "peek",
      async *run(turn) {
        system = turn.system;
      },
    });
    const support = agent({
      name: "support",
      harness: peek,
      store: memoryStore(),
      instructions: "Answer as the Acme desk.",
    });
    const session = await support.session("u_42", { user: { name: "Dana", plan: "pro" } });
    await (await session.stream("hi", { context: { page: "/billing" } })).text();
    expect(system).toContain("Answer as the Acme desk.");
    expect(system).toContain("[User]");
    expect(system).toContain("name: Dana");
    expect(system).toContain("[Situation]");
    expect(system).toContain("page: /billing");
  });

  it("builds the enriched RunContext the guard and tools see: user, context, headers", async () => {
    let seen: RunContext | undefined;
    const probe = tool({
      name: "probe",
      risk: "read",
      inputSchema: { type: "object" },
      execute: (_input, ctx) => {
        seen = ctx;
        return { ok: true };
      },
    });
    const caller = defineHarness({
      name: "caller",
      async *run(turn) {
        await turn.tools.call("probe", {});
      },
    });
    const support = agent({ name: "support", harness: caller, store: memoryStore(), tools: [probe] });
    const session = await support.session("u_42", {
      user: { plan: "pro" },
      context: { helpers: () => "check-time" },
      headers: { authorization: "Bearer present-user" },
    });
    await (await session.stream("hi", { context: { record: "inv_7" } })).text();
    expect(seen?.principal).toEqual(principal);
    expect(seen?.requestHeaders).toEqual({ authorization: "Bearer present-user" });
    const enriched = seen as (RunContext & { user?: unknown; context?: Record<string, unknown> }) | undefined;
    expect(enriched?.user).toEqual({ plan: "pro" });
    expect(enriched?.context?.["record"]).toBe("inv_7");
    expect(typeof enriched?.context?.["helpers"]).toBe("function");
  });

  it("projects boot-loaded skill folders into the turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "agents-session-skills-"));
    cleanups.push(root);
    const dir = join(root, "product-docs");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), '---\ndescription: "Billing answers."\n---\nBody here.');
    let listed: Array<{ name: string }> = [];
    let body = "";
    const peek = defineHarness({
      name: "peek",
      async *run(turn: Turn) {
        listed = await turn.skills.list();
        body = await turn.skills.load("product-docs");
      },
    });
    const support = agent({ name: "support", harness: peek, store: memoryStore(), skills: [dir] });
    const session = await support.session("u_42");
    await (await session.stream("hi")).text();
    expect(listed.map((s) => s.name)).toContain("product-docs");
    expect(body).toContain("Body here.");
  });

  it("surfaces parked approvals to on('approval') and decides through the guard", async () => {
    let requested: ((request: ApprovalRequest) => void) | undefined;
    const decisions: unknown[] = [];
    const guard: VendoGuard = {
      check: async () => ({ action: "run", decidedBy: "default" }),
      report: async () => {},
      directions: async () => [],
      onApprovalDecision: () => () => {},
      bind: (tools) => tools,
      approvals: {
        pending: async () => [],
        decide: async (ids, decision, by) => {
          decisions.push([ids, decision, by]);
        },
        revoke: async () => {},
      },
      freeze: async () => {},
      unfreeze: async () => {},
      frozen: async () => false,
      grants: { list: async () => [], revoke: async () => {} },
      audit: { query: async () => ({ events: [] }), export: async function* () {} },
      status: () => ({ posture: "unconfigured" }),
      onApprovalRequested: (cb) => {
        requested = cb;
        return () => {};
      },
    };
    const support = agent({ name: "support", harness: speaks("hi"), store: memoryStore(), guard });
    const session = await support.session("u_42");
    const events: unknown[] = [];
    session.on("approval", (req) => {
      events.push(req.request.id);
      void req.approve();
    });
    // Delivery is scoped to the parking conversation, so the request must
    // carry this session's own thread as its owner to be surfaced at all.
    const request = {
      id: "apr_1",
      call: { id: "c1", tool: "t", args: {} },
      ctx: { sessionId: session.threadId },
    } as unknown as ApprovalRequest;
    requested?.(request);
    expect(events).toEqual(["apr_1"]);
    await Promise.resolve();
    expect(decisions).toEqual([[["apr_1"], { approve: true }, principal]]);
  });

  it("delivers an approval ONLY to the conversation that parked it, and a foreign session cannot decide it", async () => {
    const store = memoryStore();
    const guard = createGuard({ store, policy: "cautious" });
    const writer = tool({
      name: "writer",
      risk: "write",
      inputSchema: { type: "object" },
      execute: () => ({ done: true }),
    });
    const caller = defineHarness({
      name: "caller",
      async *run(turn) {
        await turn.tools.call("writer", {});
        yield { type: "text" as const, delta: "wrote" };
      },
    });
    const support = agent({ name: "support", harness: caller, store, guard, tools: [writer] });
    const sessionA = await support.session("u_a");
    const sessionB = await support.session("u_b");
    // Same user as A, other conversation: scoping is per THREAD, not per subject.
    const sessionA2 = await support.session("u_a");

    const leaked: string[] = [];
    sessionB.on("approval", (event) => leaked.push(`B:${event.request.id}`));
    sessionA2.on("approval", (event) => leaked.push(`A2:${event.request.id}`));

    const seen: ApprovalRequest[] = [];
    let crossUserDecide: unknown = "not-attempted";
    sessionA.on("approval", (event) => {
      seen.push(event.request);
      void (async () => {
        // The other user's resolve path: deciding A's pending approval as u_b
        // must reject before A's own approve lands.
        try {
          await guard.approvals.decide(
            [event.request.id],
            { approve: false },
            { kind: "user", subject: "u_b" },
          );
          crossUserDecide = "allowed";
        } catch (error) {
          crossUserDecide = error;
        }
        await event.approve();
      })();
    });

    const response = await sessionA.stream("write it");
    await response.text();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.ctx.principal.subject).toBe("u_a");
    expect(leaked).toEqual([]);
    expect(crossUserDecide).toBeInstanceOf(VendoError);
    expect((crossUserDecide as VendoError).code).toBe("not-found");
  });
});
