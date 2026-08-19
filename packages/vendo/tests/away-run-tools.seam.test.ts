/**
 * WHAT AN AWAY RUN IS EQUIPPED WITH, AND WHAT IT IS TOLD ABOUT THE REST.
 *
 * Production Maple, 2026-08-19: "check my balance and text me" was armed with
 * every standing grant it needed, fired on time, read the balance — and then told
 * the customer "I don't have a way to send a text message." Two mechanisms, one
 * silence. `computeInitialLoadout` cuts a large surface safest-first, so 25 reads
 * filled the 24-tool belt and every WRITE was evicted, `vendo_text_me` included;
 * and the away brief hardcoded `discovery: false`, so the model was never told
 * that the `find_tools` its own harness was carrying could equip it again.
 *
 * Nothing is stubbed between the halves: a real `createVendo`, a real store, the
 * real automations engine, the real composed `vendo()` brain and the real away
 * runner. The belt is read off the MODEL CALL — the tools block as it crosses the
 * provider seam — because a loadout the model was never handed proves nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationsInternals } from "@vendoai/automations";
import { VENDO_AUTOMATE_TOOL, type Harness, type Principal, type RunContext, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";
import { VENDO_TEXT_ME_TOOL } from "../src/text-me.js";

const owner: Principal = { kind: "user", subject: "user_away_tools" };
const ctx: RunContext = {
  principal: owner,
  venue: "chat",
  presence: "present",
  sessionId: "sess_away_tools",
};
const EVENT = "balance.checked";
const GOAL = "check my checking balance and text me";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** Maple's arithmetic in miniature: enough graded READS to fill the default belt
 *  on their own, so every write on the surface is a candidate for eviction —
 *  which is the whole reason the person's granted Text me never reached it. */
const READS = 30;

const hostReads = (): ToolRegistry => {
  const descriptors: ToolDescriptor[] = Array.from({ length: READS }, (_, index) => ({
    name: `maple_read_${String(index).padStart(2, "0")}`,
    title: `Read ${index}`,
    description: "One of the bank's read-only lookups",
    inputSchema: { type: "object" },
    risk: "read",
  }));
  return {
    async descriptors() {
      return descriptors;
    },
    async execute() {
      return { status: "ok", output: {} };
    },
  };
};

/** Every tool block the provider was handed, per call. */
function recordingModel(seen: string[][]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "probe",
    modelId: "probe-v1",
    supportedUrls: {},
    async doStream(call: { tools?: readonly { name?: string }[] }) {
      seen.push((call.tools ?? []).map((entry) => String(entry.name)));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-away-tools-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function compose(overrides: Record<string, unknown>): Promise<Vendo> {
  const store = await tempStore();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => owner,
    store,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(hostReads());
  await store.ensureSchema();
  return vendo;
}

/** One armed agentic automation, fired. `emit` awaits the firing, so the away run
 *  has already thought by the time it returns. */
async function fire(vendo: Vendo): Promise<void> {
  await automationsInternals(vendo.automations).create({
    owner,
    when: { event: EVENT },
    task: { kind: "goal", prompt: GOAL },
    authoredBy: "chat",
  }, ctx);
  await vendo.emit(EVENT, {}, owner);
}

describe.sequential("the belt an away firing is handed", () => {
  it("keeps the tools the prompt teaches on it however many reads crowd the surface", async () => {
    // The channel is configured, so the tool is registered and the grant the
    // person gave it is worth something. `VENDO_CLOUD_URL` points nowhere on
    // purpose: this run never reaches the console, and a stray request must fail
    // instantly rather than leave the test's tenant.
    vi.stubEnv("VENDO_API_KEY", "vk_live_away_tools");
    vi.stubEnv("VENDO_CLOUD_URL", "http://127.0.0.1:1");
    const seen: string[][] = [];
    const vendo = await compose({
      models: { default: recordingModel(seen) },
      channels: { text: true },
      connectors: [],
    });

    await fire(vendo);

    expect(seen.length, "the away run never reached the model").toBeGreaterThan(0);
    const belt = seen[0]!;
    // THE POINT: the power the person granted is on the belt the model was
    // handed. Before this, it was the 25th read's turn and every write lost.
    expect(belt).toContain(VENDO_TEXT_ME_TOOL);
    // …and so is the tool that ARMS it. The channel's hidden grounding names the
    // automation path on every single inbound text ("to text the user later, set
    // up an automation for it", channel-turn.ts), and arming is a write — so the
    // same safest-first cut that buried Text me made the one thing this channel
    // advertises cost a `find_tools` round on the first turn of every fresh
    // thread.
    expect(belt).toContain(VENDO_AUTOMATE_TOOL);
    // …and the cap really did bite, so the lines above are survivors and not an
    // accident of a surface that fit whole.
    expect(belt.filter((name) => name.startsWith("maple_read_")).length).toBeLessThan(READS);
  }, 60_000);
});

describe.sequential("the brief an away firing thinks on", () => {
  /** A harness that reports the brief it was handed and nothing else. */
  const probe = (told: { system?: string }, toolSurface?: Harness["toolSurface"]) =>
    defineHarness({
      name: "away-brief-probe",
      ...(toolSurface === undefined ? {} : { toolSurface }),
      async *run(turn) {
        told.system = turn.system ?? "";
        yield { type: "text", delta: "ok" };
      },
    }) as never;

  it("teaches the search budget when the away harness actually carries find_tools", async () => {
    const told: { system?: string } = {};
    await fire(await compose({ harness: probe(told) }));

    // The away run mounts the composed brain, `find_tools` and all — the brief
    // used to say `discovery: false` and leave the rail unmentioned.
    expect(told.system).toContain("Discovery budget");
    expect(told.system).toContain("find_tools");
  }, 60_000);

  it("still says nothing about a rail an uncurated away harness does not have", async () => {
    const told: { system?: string } = {};
    await fire(await compose({ harness: probe(told, { curated: false }) }));

    // Derived, not hardcoded the other way: an uncurated surface has no
    // `find_tools`, and with no searchable connector it has no pair either.
    expect(told.system).not.toContain("Discovery budget");
    expect(told.system).not.toContain("find_tools");
    expect(told.system).not.toContain("find_service_tools");
  }, 60_000);
});
