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
import { triggerKey } from "@vendoai/automations";
import {
  DEFAULT_TRIGGER_ID,
  TRIGGER_KIND_REF_PRESENT,
  VENDO_APP_FORMAT,
  VENDO_MAKE_TOOL,
  triggerKindRefKey,
  vendoLimitPartSchema,
  type AppDocument,
  type LimitAction,
  type LimitsCallback,
  type Principal,
  type StoreOps,
} from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
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
    // A refusal is not a failure — and it is not a person's answer either. The
    // call settles as the typed `blocked` outcome, carrying the reason. The
    // ai-SDK's `output-denied` is the terminal state of an approval a PERSON
    // turned down, and borrowing it both mis-attributed the refusal on screen
    // and wrote a part `convertToModelMessages` cannot read (it takes the
    // refusal's words off `approval.reason`, which a policy refusal has none of).
    expect(turn.some((chunk) => chunk["type"] === "tool-output-denied")).toBe(false);
    expect(turn.find((chunk) => chunk["type"] === "tool-output-available"))
      .toMatchObject({ output: { status: "blocked", reason: expect.stringContaining(GENERATION_CAP) } });
  });

  it("leaves the thread ALIVE — the next turn in the same thread still answers", async () => {
    // The gap the first cut shipped through: the denial is persisted, and the
    // NEXT turn rebuilds that history for the provider. One refused build used
    // to kill every later turn in the thread ("The response didn't finish"),
    // while a suite that only ever sent the refused turn stayed green.
    const { model, chat } = await compose({
      limits: noGenerations,
      turns: [
        toolCallTurn(VENDO_MAKE_TOOL, { request: "a spending dashboard" }),
        textTurn("You've used every app on your plan."),
        textTurn("Your last three months are all here in chat."),
      ],
    });

    await chat("build me a dashboard");
    const next = await chat("just tell me the numbers then");

    expect(next.filter((chunk) => chunk["type"] === "error")).toEqual([]);
    expect(next.some((chunk) => chunk["type"] === "data-vendo-turn-error")).toBe(false);
    expect(next.some((chunk) => chunk["delta"] === "Your last three months are all here in chat.")).toBe(true);
    expect(model.calls).toBe(3);
    // The refusal is still IN that history, in the words the host wrote.
    expect(JSON.stringify(model.prompts[2])).toContain(GENERATION_CAP);
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

describe("the generation choke and the AUTOMATION venue", () => {
  /** An armed host-event automation whose one step IS the build door. */
  const arm = async (vendo: Vendo, appId: string): Promise<void> => {
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: appId,
      name: "Nightly build",
      triggers: [{
        id: DEFAULT_TRIGGER_ID,
        on: { kind: "host-event", event: "go" },
        run: {
          kind: "steps",
          // Step args are JSONata, so the request is a quoted literal.
          steps: [{ id: "build", tool: VENDO_MAKE_TOOL, args: { request: "'a spending dashboard'" } }],
        },
      }],
    };
    await vendo.store.records("vendo_apps").put({
      id: appId,
      data: { subject: principal.subject, enabled: true, doc },
      refs: { subject: principal.subject, [triggerKindRefKey("host-event")]: TRIGGER_KIND_REF_PRESENT },
    });
    await vendo.store.records("automations:armed").put({
      id: triggerKey(appId, DEFAULT_TRIGGER_ID),
      data: { appId, triggerId: DEFAULT_TRIGGER_ID },
      refs: { app_id: appId },
    });
  };

  it("never asks the policy about a firing, and meters nothing for it", async () => {
    // The policy refuses EVERYTHING, so a firing that were gated could not
    // possibly build: asking it at all is the defect.
    const asked: LimitAction[] = [];
    const { vendo } = await compose({
      limits: ({ action }) => { asked.push(action); return false; },
      turns: [],
    });
    await arm(vendo, "app_limits_automation");

    expect(await vendo.emit("go", {}, principal)).toHaveLength(1);

    expect(asked).toEqual([]);
    await expect(vendo.usage({ since: new Date(0) })).resolves.toEqual([]);
    // The step reached the registry rather than the choke's refusal.
    const runs = (await vendo.store.records("vendo_runs").list()).records;
    expect(JSON.stringify(runs)).not.toContain("reached a limit");
  });
});

describe("the generation choke and a REQUEST whose identity did not resolve", () => {
  // The deployment asserts no pools and no facts for this visitor — the shape a
  // missing session leaves behind. A policy written against a pool cannot be
  // answered, and the ONLY safe answer is the refusal: skipping here would hand
  // every uncredentialed caller an unlimited deployment.
  const perWorkspace: LimitsCallback = async ({ action, count }) =>
    action !== "generation" || await count("generation", { pool: "workspace" }) < 5;

  it("still fails CLOSED — the build is refused, not waved through", async () => {
    const { chat } = await compose({
      limits: perWorkspace,
      turns: [
        toolCallTurn(VENDO_MAKE_TOOL, { request: "a spending dashboard" }),
        textTurn("I could not build that."),
      ],
    });

    expect(limitCards(await chat("build me a dashboard"))).toEqual([{ type: "data-vendo-limit" }]);
  });
});

describe("vendo.usage() — the tally a host's own overage job reads", () => {
  it("answers what the meter really recorded", async () => {
    const { vendo, chat } = await compose({
      limits: () => true,
      turns: [textTurn("one"), textTurn("two")],
    });

    await chat("first");
    await chat("second");

    await expect(vendo.usage({ since: new Date(0) })).resolves.toEqual([
      { subject: principal.subject, action: "message", count: 2 },
    ]);
  });

  it("REFUSES on a store with no meter, rather than answering an empty tally", async () => {
    const { usage: _absent, ...meterless } = memoryStoreOps();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: Object.assign(await tempStore(), { ops: meterless as StoreOps }),
    } as CreateVendoConfig);

    await expect(vendo.usage({ since: new Date(0) })).rejects.toThrow(/no usage meter/);
  });
});
