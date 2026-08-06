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
import { createVendo, type Vendo } from "./server.js";

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

interface ModelCall {
  prompt: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
}

const promptText = (call: ModelCall): string => call.prompt
  .map(message => typeof message.content === "string"
    ? message.content
    : message.content.map(part => part.text ?? "").join(""))
  .join("\n");

/** The name the create validator needs, taken from the request the way the
 *  apps package's own `basicLanguageModel` fixture takes it. */
const namedFrom = (text: string, marker: string): string => {
  const start = text.lastIndexOf(marker);
  if (start === -1) return "Untitled app";
  const value = text.slice(start + marker.length).split("\n")[0]?.trim() ?? "";
  return (value.slice(0, 40) || "Untitled app").replaceAll('"', "'");
};

/** A deterministic LanguageModelV2 double that HOLDS until the test releases
 *  it — which is what makes "the slot shows the build forming" observable
 *  without a sleep. Same generation markup as the apps fixture. */
function gatedModel(gate: Promise<void>): LanguageModel {
  const answer = (text: string): string => {
    if (text.includes("TASK: EDIT_TREE")) {
      return `<Edit><SetName name="${namedFrom(text, "INSTRUCTION: ")}"/></Edit>`;
    }
    const name = namedFrom(text, "USER_REQUEST: ");
    return `<App name="${name}"><Text text="${name}"/><Disclaimer reason="Scripted fixture app."/></App>`;
  };
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-placements-seam",
    modelId: "vendo-placements-seam-v1",
    supportedUrls: {},
    async doGenerate(call: ModelCall) {
      await gate;
      return {
        content: [{ type: "text" as const, text: answer(promptText(call)) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(call: ModelCall) {
      await gate;
      const text = answer(promptText(call));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            controller.enqueue({ type: "text-delta", id: "text_1", delta: text });
            controller.enqueue({ type: "text-end", id: "text_1" });
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
  };
  return model as unknown as LanguageModel;
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-placements-seam-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
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
