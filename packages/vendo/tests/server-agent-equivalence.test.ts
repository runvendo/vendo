/**
 * ONE deployment, spelled two ways: the flat keys on `createVendo`, and the
 * SAME values handed to `agent()` and adopted through `createVendo({ agent })`.
 *
 * Tested as a seam, with no stub on either side — a real `agent()`, a real
 * `createVendo`, and a real turn driven over the wire — because the thing at
 * risk is exactly that the two spellings drift: the flat keys resolve through
 * `compose-adapters.ts`/`compose-harness.ts`/`compose-prompt.ts`, the adopted
 * ones through `agent()`, and a harness mocking its counterparty could never
 * catch the day those two disagree. What the harness SEES on the turn — the
 * assembled system prompt, the equipped tool listing, the model seats — is the
 * comparison, because that is everything the deployment's brain is handed.
 */
import { agent } from "@vendoai/agents";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { inMemoryBoxFiles } from "@vendoai/apps/testing";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-agent-equiv-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const fakeSandbox = (): SandboxAdapter => {
  const machine = {
    id: "box_1",
    request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    url: async () => "http://box",
    snapshot: async () => "fake:snap",
    stop: async () => {},
    destroy: async () => {},
    files: inMemoryBoxFiles(new Map()),
  } satisfies SandboxMachine;
  return {
    create: async () => machine,
    resume: async () => machine,
    destroy: async () => {},
  };
};

const INSTRUCTIONS = "Answer as Maple support, in one sentence.";
const REPLY = "Two invoices are open.";

/** What the deployment's brain was handed for its turn. */
interface TurnView {
  system: string | undefined;
  tools: readonly string[];
  seats: readonly string[];
}

interface Deployment {
  view: TurnView;
  /** The host's own store instance, not a second one composed beside it. */
  adoptedStore: boolean;
  sandboxPosture: unknown;
  answer: string;
}

/** Compose one deployment from the same four values, drive one real turn
 *  through the wire, and report what the brain saw. */
async function composed(spelling: "flat" | "through agent()"): Promise<Deployment> {
  const store = await tempStore();
  const sandbox = fakeSandbox();
  let view: TurnView | undefined;
  const harness = defineHarness({
    name: "scripted",
    requires: { sandbox: true },
    async *run(turn) {
      view = {
        system: turn.system,
        tools: (await turn.tools.list()).map((tool) => tool.name).sort(),
        seats: Object.keys(turn.models).sort(),
      };
      yield { type: "text", delta: REPLY };
    },
  });
  const base = {
    models: { default: {} as LanguageModel },
    principal: async () => ({ kind: "user" as const, subject: "user_equiv" }),
  };
  const vendo = spelling === "flat"
    ? createVendo({ ...base, harness, store, sandbox, instructions: INSTRUCTIONS })
    : createVendo({
      ...base,
      agent: agent({ name: "support", harness, store, sandbox, instructions: INSTRUCTIONS }),
    });

  const status = await vendo.handler(new Request("https://host.test/api/vendo/status"));
  const sandboxPosture = (await status.json() as { blocks: { sandbox: unknown } }).blocks.sandbox;
  const turn = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_equiv",
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "how many invoices are open?" }],
      } satisfies UIMessage,
    }),
  }));
  const answer = await turn.text();
  if (view === undefined) throw new Error("the deployment's harness never ran the turn");
  return { view, adoptedStore: vendo.store === store, sandboxPosture, answer };
}

it("composes the same deployment from the flat keys and from agent()", async () => {
  vi.stubEnv("E2B_API_KEY", "");
  vi.stubEnv("VENDO_API_KEY", "");

  const flat = await composed("flat");
  const adopted = await composed("through agent()");

  // Each half really ran: the host's brain answered, on the host's own store,
  // over the host's own sandbox.
  expect(flat.answer).toContain(REPLY);
  expect(adopted.answer).toContain(REPLY);
  expect(flat.adoptedStore).toBe(true);
  expect(adopted.adoptedStore).toBe(true);
  expect(flat.sandboxPosture).toBe("custom");
  // …and the host's prose reached the brain, which is the slot most likely to
  // be silently lost by whichever spelling loses a precedence race.
  expect(flat.view.system).toContain(INSTRUCTIONS);

  // The equivalence itself: one turn, two spellings, nothing between them.
  expect(adopted.sandboxPosture).toBe(flat.sandboxPosture);
  expect(adopted.view).toEqual(flat.view);
}, 60_000);
