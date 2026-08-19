/**
 * The UI lane — `respond()` — and the boot surface it hangs off: an optional
 * harness, the model seat it needs when it takes the default one, and the five
 * places this package tells a host what to fix.
 *
 * Real embedded store, real guard, real runtime; only the thinker is scripted
 * (CLAUDE.md: test the SEAM).
 */
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../src/agent.js";
// Through the BARREL: the header a host reads the thread id from is this
// package's to hand over, and re-exporting it is what keeps the host and the
// browser off two literals.
import { THREAD_ID_HEADER } from "../src/index.js";
import { api, tool } from "../src/tools.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-respond-${stores++}` });

const speaks = (text: string) =>
  defineHarness({
    name: "speaks",
    async *run() {
      yield { type: "text" as const, delta: text };
    },
  });

const boxy = () =>
  defineHarness({
    name: "boxy",
    requires: { sandbox: true, toolDoor: true },
    async *run() {},
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The zero-key rung the ladder resolves to, pinned so the suite reads the same
 *  on a laptop that has run `vendo login` and on one that has not. */
const withRung = (present: boolean): void => {
  vi.stubEnv("VENDO_DEV_CREDENTIAL", "");
  vi.stubEnv("VENDO_API_KEY", present ? "vnd_test" : "");
};

/** What the turn was actually handed for the seat it thinks with. */
async function seatOf(support: ReturnType<typeof agent>, peek: () => unknown): Promise<unknown> {
  await (await support.respond("u_42", "hi")).text();
  return peek();
}

describe("agent() composition", () => {
  it("composes with a name and tools alone — the harness is the default one", () => {
    expect(() => agent({ name: "support", tools: [api()], store: memoryStore() })).not.toThrow();
  });

  it("an explicit model wins over an available rung", async () => {
    withRung(true);
    let seen: unknown;
    const peek = defineHarness({
      name: "peek",
      async *run(turn) {
        seen = turn.models.default;
        yield { type: "text" as const, delta: "ok" };
      },
    });
    const model = { modelId: "fake", specificationVersion: "v2" } as never;

    const handed = await seatOf(
      agent({ name: "support", harness: peek, model, store: memoryStore() }),
      () => seen,
    );

    expect(handed).toBe(model);
  });

  it("an unset model resolves through the ladder", async () => {
    withRung(true);
    let seen: unknown;
    const peek = defineHarness({
      name: "peek",
      async *run(turn) {
        seen = turn.models.default;
        yield { type: "text" as const, delta: "ok" };
      },
    });

    const handed = await seatOf(
      agent({ name: "support", harness: peek, store: memoryStore() }),
      () => seen,
    ) as { provider: string; modelId: string };

    // `vendoModel()`'s own lazy identity — the ladder's model, not one of ours.
    expect(handed.provider).toBe("vendo");
    expect(handed.modelId).toBe("vendo-env");
  });

  it("keeps the seat the host named, and hands it to the turn", async () => {
    let seen: unknown;
    const peek = defineHarness({
      name: "peek",
      async *run(turn) {
        seen = turn.models.default;
        yield { type: "text" as const, delta: "ok" };
      },
    });
    const model = { modelId: "fake", specificationVersion: "v2" } as never;
    const support = agent({ name: "support", harness: peek, model, store: memoryStore() });

    await (await support.respond("u_42", "hi")).text();

    expect(seen).toBe(model);
  });
});

describe("the five things a host is told to fix", () => {
  it("no name", () => {
    expect(() => agent({ name: " ", harness: speaks("hi"), store: memoryStore() }))
      .toThrow(/agent\(\{ name \}\) is required/);
  });

  it("neither an explicit model nor a rung — the default brain has nothing to think with", async () => {
    withRung(false);
    const support = agent({ name: "support", store: memoryStore() });

    await expect(support.respond("u_42", "hi")).rejects.toThrow(/agent\(\{ model \}\) is required/);
    await expect(support.run("do a thing")).rejects.toThrow(/harness: claudeCode\(\)/);
  });

  it("no sandbox, for a harness that thinks on one", () => {
    expect(() => agent({ name: "support", harness: boxy(), store: memoryStore() }))
      .toThrow(/This harness runs on a sandbox and none resolved/);
  });

  it("no door origin, for a sandboxed thinker with nowhere to dial back", () => {
    const sandbox = {
      create: async () => ({}) as never,
      resume: async () => ({}) as never,
      destroy: async () => {},
    };
    expect(() => agent({ name: "support", harness: boxy(), sandbox, store: memoryStore() }))
      .toThrow(/needs an origin that box can dial/);
  });

  it("an unknown thread — a foreign one reads the same as one that never existed", async () => {
    const store = memoryStore();
    const support = agent({ name: "support", harness: speaks("hi"), store });
    const mine = await support.session("u_42");

    await expect(support.session("u_99", { threadId: mine.threadId }))
      .rejects.toThrow(/No conversation thr_.* for this user/);
    await expect(support.respond("u_99", "hi", { threadId: mine.threadId }))
      .rejects.toThrow(/omit it to start a new one/);
  });
});

describe("respond()", () => {
  it("returns the UI message stream with the conversation's id on the header", async () => {
    const store = memoryStore();
    const support = agent({ name: "support", harness: speaks("hello from the harness"), store });

    const response = await support.respond("u_42", "hello");

    const threadId = response.headers.get(THREAD_ID_HEADER);
    expect(threadId).toMatch(/^thr_/);
    expect(await response.text()).toContain("hello from the harness");
  });

  it("session.stream() stamps the same header — one code path, both surfaces", async () => {
    const store = memoryStore();
    const support = agent({ name: "support", harness: speaks("hi"), store });
    const session = await support.session("u_42");

    const response = await session.stream("hello");

    expect(response.headers.get(THREAD_ID_HEADER)).toBe(session.threadId);
  });

  it("continues the conversation the header handed back", async () => {
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

    const first = await support.respond("u_42", "first");
    const threadId = first.headers.get(THREAD_ID_HEADER) as string;
    await first.text();
    await (await support.respond("u_42", "second", { threadId })).text();

    expect(seen).toHaveLength(3); // user, assistant, user
  });

  it("carries the same ctx a session's turn does — the user facts and the tool context", async () => {
    const store = memoryStore();
    const seen: unknown[] = [];
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "caller",
        async *run(turn) {
          await turn.tools.call("peek", {});
          yield { type: "text" as const, delta: "done" };
        },
      }),
      tools: [tool({
        name: "peek",
        description: "Peek at the run context",
        risk: "read",
        inputSchema: { type: "object" },
        execute: (_input, ctx) => {
          seen.push({ user: ctx.user, context: ctx.context, subject: ctx.principal.subject });
          return {};
        },
      })],
      store,
    });

    await (await support.respond("u_42", "go", { user: { plan: "pro" }, context: { tenant: "acme" } })).text();

    expect(seen).toEqual([{ user: { plan: "pro" }, context: { tenant: "acme" }, subject: "u_42" }]);
  });
});
