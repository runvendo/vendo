/**
 * Placement, across the seam it actually spans: the write path (the wire's
 * place/unplace routes and the runtime's create-at-mint) and the read path
 * (GET /apps/placements) with nothing stubbed between them. A slot-targeted
 * create is watched from BUILDING to READY through the same door a browser
 * would use.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_APP_FORMAT, type AppDocument, type Principal, type RunContext } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ADA: Principal = { kind: "user", subject: "user_ada" };
const ctx: RunContext = {
  principal: ADA,
  venue: "app",
  presence: "present",
  sessionId: "session_placements_seam",
};

/** The smallest `app.tsx` the gauntlet renders and the seam paints. */
const SPENDING = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack>
      <Text text="This month" />
    </Stack>
  );
}
`;

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

type Chunk = Record<string, unknown>;

const saveApp = (content: string): Chunk[] => [
  {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "save_app",
    input: JSON.stringify({ content }),
  },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

const speak = (text: string): Chunk[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

/** A deterministic LanguageModelV2 double that HOLDS until the test releases
 *  it — which is what makes "the slot shows the build forming" observable
 *  without a sleep. It drives the ONE engine the way a real screen agent does:
 *  a `save_app` hand, then a word to finish on. */
function gatedModel(gate: Promise<void>): LanguageModel {
  const turns: Chunk[][] = [saveApp(SPENDING), speak("done")];
  const answer = (): Chunk[] => turns.shift() ?? speak("nothing more to do");
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-placements-seam",
    modelId: "vendo-placements-seam-v1",
    supportedUrls: {},
    async doGenerate() {
      await gate;
      const chunks = answer();
      const toolCall = chunks.find((chunk) => chunk["type"] === "tool-call");
      if (toolCall !== undefined) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: toolCall["toolCallId"] as string,
            toolName: toolCall["toolName"] as string,
            input: toolCall["input"] as string,
          }],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: chunks
            .filter((chunk) => chunk["type"] === "text-delta")
            .map((chunk) => chunk["delta"] as string).join(""),
        }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream() {
      await gate;
      const chunks = answer();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
  return model as unknown as LanguageModel;
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-placements-seam-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const seedDoc = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

interface Entry { slot: string; app: string; title: string; status: string }

async function setup(gate: Promise<void>): Promise<Vendo> {
  const store = await tempStore();
  await store.ensureSchema();
  return createVendo({
    model: gatedModel(gate),
    principal: async (request) => {
      const subject = request.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
  });
}

const get = (vendo: Vendo, path: string): Promise<Response> =>
  vendo.handler(new Request(`http://wire.test/api/vendo${path}`, {
    headers: new Headers({ "x-test-user": ADA.subject }),
  }));

const post = (vendo: Vendo, path: string, body: unknown): Promise<Response> =>
  vendo.handler(new Request(`http://wire.test/api/vendo${path}`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", "x-test-user": ADA.subject }),
    body: JSON.stringify(body),
  }));

const placements = async (vendo: Vendo, query = ""): Promise<Entry[]> => {
  const response = await get(vendo, `/apps/placements${query}`);
  expect(response.status).toBe(200);
  return await response.json() as Entry[];
};

/** Poll until the condition holds, with NO inner budget on purpose: the test's
 *  own timeout is the hang detector, and a tighter inner limit is a second,
 *  invisible speed limit that reports a product bug when the machine is busy. */
const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("placement across the wire seam", () => {
  it("places through the real route and reads back through the real one, evicting as it goes", async () => {
    const vendo = await setup(Promise.resolve());
    await vendo.apps.importApp(seedDoc("app_ignored_1", "Spending"), ctx);
    const spending = (await vendo.apps.list(ctx))[0]!;
    await vendo.apps.importApp(seedDoc("app_ignored_2", "Savings"), ctx);
    const savings = (await vendo.apps.list(ctx)).find(app => app.id !== spending.id)!;

    const placed = await post(vendo, `/apps/${spending.id}/place`, { slot: "home-hero" });
    expect(placed.status).toBe(200);
    expect(await placed.json()).toEqual({});

    expect(await placements(vendo)).toEqual([
      { slot: "home-hero", app: spending.id, title: "Spending", status: "ready" },
    ]);

    // One app per slot: the second place displaces the first, and says so.
    expect(await (await post(vendo, `/apps/${savings.id}/place`, { slot: "home-hero" })).json())
      .toEqual({ evicted: spending.id });
    expect(await placements(vendo)).toEqual([
      { slot: "home-hero", app: savings.id, title: "Savings", status: "ready" },
    ]);

    // A slot the surface did not mount is never answered.
    expect(await placements(vendo, "?slots=sidebar")).toEqual([]);

    expect((await post(vendo, `/apps/${savings.id}/unplace`, { slot: "home-hero" })).status).toBe(200);
    expect(await placements(vendo)).toEqual([]);
  });

  it("a slot-targeted create shows the slot BUILDING, then READY, through the same door", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const vendo = await setup(gate);

    const building = vendo.apps.create({ prompt: "Show my spending", slot: "home-hero" }, ctx);

    const forming = (await until(
      () => placements(vendo),
      rows => rows[0]?.status === "building",
    ))[0]!;
    expect(forming.slot).toBe("home-hero");
    expect(forming.app).toMatch(/^app_/);

    release();
    const app = await building;
    expect(await placements(vendo)).toEqual([
      { slot: "home-hero", app: app.id, title: app.name, status: "ready" },
    ]);
    // Same id the whole way: the row was written at mint, never rewritten.
    expect(app.id).toBe(forming.app);
  });
});
