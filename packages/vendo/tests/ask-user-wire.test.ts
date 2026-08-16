/**
 * `ask_user` through the real composition — design §4, "questions as a tool, one
 * door, any seat".
 *
 * The ruling these tests pin: a question is TURN-ENDING, not a blocking mid-turn
 * card. Build contract §8 cuts steering, and design §6 has the builder "ask the
 * user through the one door if genuinely ambiguous, and dies". So there is no wire
 * part, no pending-question registry, no answer door and no renderer: the door
 * records the question (the mirrored tool call IS the record), the turn ends, and
 * the reply arrives as the next turn's message.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_USER_TOOL, type Principal, type RunContext } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { defineHarness } from "@vendoai/harnesses";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_ask" };
const chat = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s_ask",
  ...overrides,
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-ask-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const userMessage = (id: string, text: string) =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as never;

/** The harness asks once and reports what came back. */
const asking = (result: { value?: unknown; error?: string }) => defineHarness({
  name: "asker",
  async *run(turn) {
    const outcome = await turn.tools.call(ASK_USER_TOOL, { question: "Which account?", choices: ["a", "b"] });
    if (outcome.status === "ok") result.value = outcome.output;
    else result.error = JSON.stringify(outcome);
    yield { type: "text", delta: "asked" };
  },
}) as never;

async function compose(harness?: unknown): Promise<{ vendo: Vendo; store: VendoStore }> {
  const store = await tempStore();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    ...(harness === undefined ? {} : { harness: harness as never }),
  });
  await store.ensureSchema();
  return { vendo, store };
}

describe("ask_user is the one door, on the one registry", () => {
  it("resolves by name as a guarded descriptor — the building-apps skill teaches it", async () => {
    const { vendo } = await compose();
    const names = (await vendo.guardedTools.descriptors(chat())).map((descriptor) => descriptor.name);
    expect(names).toContain(ASK_USER_TOOL);
  });

  it("is a read, so no host policy can card a question", async () => {
    // The hand-written `read` label is final (two-vote grading removed), so a
    // host policy matching `{ risk: "write" }` never cards a question and the
    // guard writes it no effect-ledger row. §12: reads are silent, always.
    const { vendo } = await compose();
    const descriptor = (await vendo.guardedTools.descriptors(chat()))
      .find((entry) => entry.name === ASK_USER_TOOL);

    expect(descriptor?.risk).toBe("read");
  });

  it("never reaches a person when nobody is present", async () => {
    // The invariant that matters: an unattended run cannot get an answer. It holds
    // at EXECUTION — `askUserRegistry` refuses an unattended ctx outright. It does
    // NOT hold at PROJECTION: `ask_user`'s contextual descriptor-withholding
    // cannot fire, because `ActionsRegistry.descriptors()` merges and memoizes
    // ctx-blind, so the ctx never reaches the inner registry. Recorded in
    // PARKED.md P5 rather than papered over.
    const { vendo } = await compose();

    const outcome = await vendo.guardedTools.execute(
      { id: "a1", tool: ASK_USER_TOOL, args: { question: "Which account?" } },
      chat({ venue: "automation", presence: "away" }),
    );

    expect(outcome.status).not.toBe("ok");
  });
});

describe("a question is turn-ending, and its answer is the next message", () => {
  it("records the question in the transcript and hands the model the stop instruction", async () => {
    const result: { value?: unknown; error?: string } = {};
    const { vendo } = await compose(asking(result));

    const turn = await vendo.harness.stream({
      threadId: "thr_ask",
      message: userMessage("m1", "move some money"),
      ctx: chat(),
    });
    await turn.text();

    // The door answered — no surface has to be wired for a question to work, and
    // nothing waited on a human inside the call.
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ asked: "Which account?", choices: ["a", "b"] });
    expect(JSON.stringify(result.value)).toMatch(/final message/);

    // And the question is durable: the runtime mirrored the guarded call into the
    // canonical transcript, which IS the record. No question row, no wire part.
    const fetched = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_ask"));
    const thread = await fetched.json() as { messages: unknown[] };
    expect(JSON.stringify(thread)).toContain("Which account?");
  });

  it("reads the user's reply as the next turn's message — no answer door needed", async () => {
    // "The next turn sees the answer in the transcript", literally: the reply is
    // an ordinary user message, and `turn.messages` is the canonical transcript.
    const seen: string[][] = [];
    const { vendo } = await compose(defineHarness({
      name: "reader",
      async *run(turn) {
        seen.push(turn.messages
          .filter((message) => message.role === "user")
          .map((message) => message.parts.map((part) => (part as { text?: string }).text ?? "").join("")));
        yield { type: "text", delta: "ok" };
      },
    }) as never);

    await (await vendo.harness.stream({
      threadId: "thr_reply", message: userMessage("m1", "book it"), ctx: chat(),
    })).text();
    await (await vendo.harness.stream({
      threadId: "thr_reply", message: userMessage("m2", "the joint account"), ctx: chat(),
    })).text();

    expect(seen[0]).toEqual(["book it"]);
    // Turn two reads the answer with no answer door, no correlation id, and no
    // pending-question state anywhere.
    expect(seen[1]).toEqual(["book it", "the joint account"]);
  });

  it("keeps two concurrent turns' questions in their own threads", async () => {
    // The registry is composed ONCE for the deployment while turns run
    // concurrently. Nothing per-turn is bound into it any more — a question never
    // leaves its own turn's mirrored call — so the property that used to need
    // AsyncLocalStorage now holds by construction.
    const { vendo } = await compose(defineHarness({
      name: "asker-concurrent",
      async *run(turn) {
        const question = (turn.messages.at(-1)?.parts[0] as { text?: string }).text ?? "";
        const outcome = await turn.tools.call(ASK_USER_TOOL, { question });
        yield { type: "text", delta: outcome.status === "ok" ? JSON.stringify(outcome.output) : "failed" };
      },
    }) as never);

    const [a, b] = await Promise.all([
      vendo.harness.stream({ threadId: "thr_one", message: userMessage("m1", "one"), ctx: chat() }),
      vendo.harness.stream({ threadId: "thr_two", message: userMessage("m2", "two"), ctx: chat() }),
    ]);
    const [textA, textB] = await Promise.all([a.text(), b.text()]);

    // Each turn's own question came back to it, never the other's.
    expect(textA).toContain("one");
    expect(textA).not.toContain("asked...two");
    expect(textB).toContain("two");
  });
});
