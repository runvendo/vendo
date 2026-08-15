/**
 * The host's limits, enforced over the REAL composition.
 *
 * Every case drives `createVendo(...)` — real store, real meter, real guard,
 * real registry, a real HTTP `Request` into `vendo.handler` — because the thing
 * worth proving is that a composed deployment enforces the host's verdict, and
 * a unit test of the limiter cannot tell you a hot path ever calls it.
 *
 * The model is SCRIPTED and its call count is an assertion, not a detail: the
 * whole promise of the message choke is that a denied turn costs nothing, and
 * "the reply looked right" is compatible with having paid for a turn first.
 *
 * The card is parsed with `vendoLimitPartSchema` off `@vendoai/core` — the same
 * schema the chat surface reads it through. A hand-written expectation here
 * would let the producer and the consumer drift apart with the suite green.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_MAKE_TOOL, vendoLimitPartSchema, type LimitsCallback, type Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { readSse, scriptedModel, textTurn, toolCallTurn, type ScriptedModel } from "../src/agent-doubles.test-util.js";
import { createVendo, type CreateVendoConfig, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_limited" };

const MESSAGE_CAP = "You have used all 2 messages on Maple Free. It resets on the 1st.";
const GENERATION_CAP = "Maple Free builds one app a month. Upgrade for more.";

type Chunk = Record<string, unknown>;

interface Composed {
  vendo: Vendo;
  model: ScriptedModel;
  /** One turn through the wire, as the chunks the client actually receives. */
  chat: (text: string) => Promise<Chunk[]>;
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-limits-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await store.ensureSchema();
  return store;
}

async function compose(options: {
  limits: LimitsCallback;
  turns: Parameters<typeof scriptedModel>[0];
}): Promise<Composed> {
  const model = scriptedModel(options.turns);
  const vendo = createVendo({
    models: { default: model as unknown as LanguageModel },
    principal: async () => principal,
    store: await tempStore(),
    limits: options.limits,
  } as CreateVendoConfig);
  const chat = async (text: string): Promise<Chunk[]> => readSse(await vendo.handler(
    new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_limits",
        message: { id: `m_${globalThis.crypto.randomUUID()}`, role: "user", parts: [{ type: "text", text }] },
      }),
    }),
  ));
  return { vendo, model, chat };
}

/** Every limit card on the wire, parsed by the schema the chat surface reads it
 *  with — flattened out of its wire envelope exactly as the chrome flattens it. */
const limitCards = (chunks: Chunk[]) => chunks
  .filter((chunk) => chunk["type"] === "data-vendo-limit")
  .map((chunk) => vendoLimitPartSchema.parse({ type: chunk["type"], ...chunk["data"] as object }));

describe("the message choke — a denied message costs nothing", () => {
  const twoMessages: LimitsCallback = async ({ action, count }) =>
    action !== "message" || await count("message") < 2 ? true : { allow: false, message: MESSAGE_CAP };

  it("turns the third message away with the host's sentence, before any model call", async () => {
    // Two turns scripted, and only two: a third model call is exhaustion, not a
    // pass.
    const { model, chat } = await compose({ limits: twoMessages, turns: [textTurn("one"), textTurn("two")] });

    expect(limitCards(await chat("first"))).toEqual([]);
    expect(limitCards(await chat("second"))).toEqual([]);
    expect(model.calls).toBe(2);

    expect(limitCards(await chat("third"))).toEqual([{ type: "data-vendo-limit", message: MESSAGE_CAP }]);
    // THE POINT: the turn was refused at the door, so the provider was never
    // dialed at all.
    expect(model.calls).toBe(2);
  });

  it("says nothing of its own when the policy gave no sentence", async () => {
    const { chat } = await compose({ limits: () => false, turns: [] });

    expect(limitCards(await chat("hello"))).toEqual([{ type: "data-vendo-limit" }]);
  });
});

describe("the generation choke — the agent is told, and the turn goes on", () => {
  const noGenerations: LimitsCallback = ({ action }) =>
    action !== "generation" || { allow: false, message: GENERATION_CAP };

  it("refuses the build to the AGENT, cards the person, and finishes the turn in words", async () => {
    const { model, chat } = await compose({
      limits: noGenerations,
      turns: [
        toolCallTurn(VENDO_MAKE_TOOL, { request: "a spending dashboard" }),
        textTurn("You've used every app on your plan."),
      ],
    });

    const turn = await chat("build me a dashboard");

    expect(limitCards(turn)).toEqual([{ type: "data-vendo-limit", message: GENERATION_CAP }]);
    // The refusal reached the MODEL: it was asked a second time, carrying the
    // denial, and answered in words.
    expect(model.calls).toBe(2);
    expect(JSON.stringify(model.prompts[1])).toContain(GENERATION_CAP);
    expect(turn.some((chunk) => chunk["delta"] === "You've used every app on your plan.")).toBe(true);
    // A refusal is not a failure: the thread's own affordance for the call is
    // the denied one.
    expect(turn.some((chunk) => chunk["type"] === "tool-output-denied")).toBe(true);
  });

  it("leaves a message-only policy's generations alone", async () => {
    const { model, chat } = await compose({
      limits: ({ action }) => action !== "generation",
      turns: [textTurn("nothing to refuse")],
    });

    expect(limitCards(await chat("just talk to me"))).toEqual([]);
    expect(model.calls).toBe(1);
  });
});
