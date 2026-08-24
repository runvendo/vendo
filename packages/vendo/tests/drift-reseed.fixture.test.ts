import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { seedBaselineSchema } from "@vendoai/apps";
import {
  seedComponentName,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

interface ModelCall {
  prompt: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
}

/** The whole prompt as text, tool results included — a `save_app` reply is a
 *  tool RESULT, and it is what says the current run has already saved. */
const promptText = (call: ModelCall): string => JSON.stringify(call.prompt ?? "");

/** The screen agent's own brief (`environmentNote`), verbatim — the one marker
 *  that says a prompt belongs to the assembly loop. */
const SCREEN_BRIEF_MARKER = "# In this loop";
const SAVED_MARKER = "That save landed.";

/**
 * The screen agent, scripted. It runs TWICE in this journey and writes a
 * different heading each time — first for the ✦ gesture's own instruction, then
 * for the re-seed, which replays that same instruction against the host's new
 * baseline. The second heading is how the replay is visible at all.
 */
const screenModel = (headings: string[]): LanguageModel => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  let saves = 0;
  const saving = (prompt: string): boolean =>
    prompt.includes(SCREEN_BRIEF_MARKER) && !prompt.includes(SAVED_MARKER);
  const rewrite = (): string => {
    const heading = headings[Math.min(saves, headings.length - 1)];
    saves += 1;
    return `import { Stack, Text } from "@vendo/screen";

export default function MapleNetWorth() {
  return (
    <Stack>
      <Text text="${heading}" />
    </Stack>
  );
}
`;
  };
  return {
    specificationVersion: "v2",
    provider: "vendo-drift-fixture",
    modelId: "vendo-drift-fixture-v1",
    supportedUrls: {},
    async doGenerate(call: ModelCall) {
      if (!saving(promptText(call))) {
        return { content: [{ type: "text" as const, text: "done" }], finishReason: "stop" as const, usage };
      }
      return {
        content: [{
          type: "tool-call" as const,
          toolCallId: "call_save_app",
          toolName: "save_app",
          input: JSON.stringify({ content: rewrite() }),
        }],
        finishReason: "tool-calls" as const,
        usage,
      };
    },
    async doStream(call: ModelCall) {
      const content = saving(promptText(call)) ? rewrite() : undefined;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (content === undefined) {
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "done" });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: "stop", usage });
            } else {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "call_save_app",
                toolName: "save_app",
                input: JSON.stringify({ content }),
              });
              controller.enqueue({ type: "finish", finishReason: "tool-calls", usage });
            }
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
};

/**
 * The same scripted agent, plus one wish the host's NEW version has nothing to
 * change: while `refuse` names it, the loop writes no file at all, which is how
 * a real replay fails — the assembler ran and saved nothing, so the edit door
 * reports it and `reseed` keeps the wish on `seed.unapplied`.
 */
const screenModelRefusing = (headings: string[], refuse: () => string | undefined): LanguageModel => {
  const inner = screenModel(headings) as unknown as Record<string, unknown> & {
    doGenerate(call: ModelCall): Promise<unknown>;
    doStream(call: ModelCall): Promise<unknown>;
  };
  // The edit door leads every brief with the app's MEMORY, which quotes the
  // earlier asks — so "the prompt mentions this wish" matches every replay.
  // The wish being REPLAYED is the last line of the user turn, exactly as the
  // apps-level fixture keys on it.
  const asked = (call: ModelCall): string => {
    const user = (call.prompt ?? []).filter(({ role }) => role === "user").at(-1);
    const content = user?.content;
    return typeof content === "string"
      ? content
      : (content ?? []).map((part) => part.text ?? "").join("");
  };
  const declines = (call: ModelCall): boolean => {
    const wish = refuse();
    return wish !== undefined && asked(call).trimEnd().endsWith(wish);
  };
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return {
    ...inner,
    async doGenerate(call: ModelCall) {
      if (declines(call)) {
        return { content: [{ type: "text" as const, text: "nothing to change" }], finishReason: "stop" as const, usage };
      }
      return await inner.doGenerate(call);
    },
    async doStream(call: ModelCall) {
      if (declines(call)) {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "nothing to change" });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: "stop", usage });
              controller.close();
            },
          }),
        };
      }
      return await inner.doStream(call);
    },
  } as unknown as LanguageModel;
};

const principal: Principal = { kind: "user", subject: "user_drift_fixture" };

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  process.chdir(originalCwd);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe.sequential("06-apps §8 — the drift→re-seed journey through the real umbrella", () => {
  it("sync → seed → edit → host change + resync → loud drift → re-seed REPLACES", async () => {
    // A remixable host component, captured by the REAL sync.
    const root = await mkdtemp(join(tmpdir(), "vendo-drift-reseed-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    const slot = "MapleNetWorthCard";
    const componentName = seedComponentName(slot);
    const hostSource = `export default function MapleNetWorthCard() {
  return <article><span>Net worth</span><strong>$1.2M</strong></article>;
}\n`;
    const componentFile = join(root, "src", "MapleNetWorthCard.tsx");
    await writeFile(componentFile, hostSource);
    await writeFile(join(root, "src", "page.tsx"), `
import { Remixable } from "@vendoai/ui/chrome";
import MapleNetWorthCard from "./MapleNetWorthCard";
export default function Page() {
  return <Remixable><MapleNetWorthCard /></Remixable>;
}
`);
    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.pins).toEqual({ captured: [slot], drifted: [], ported: [slot] });
    const baselineFile = join(root, ".vendo", "remixable", `${slot}.json`);
    const oldHash = seedBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8"))).hash;

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);

    // ONE host process lifetime: the ✦ gesture, instruction and all.
    const vendo = createVendo({
      models: { default: screenModel(["Net worth $1.2M — remixed"]) },
      principal: async () => principal,
      store,
      development: true,
    });
    // Gesture-owned seeding: the seed rides its own wire route, and the
    // instruction it carries runs through the ordinary edit door in the same
    // operation.
    const seedResponse = await vendo.handler(request("POST", "/apps/seed", {
      component: slot,
      instruction: "Call out that it is remixed",
    }));
    expect(seedResponse.status).toBe(200);
    const remixed = await seedResponse.json() as AppDocument;
    const appId = remixed.id;
    expect(remixed.seed).toEqual({
      component: slot,
      baseline: oldHash,
      wishes: ["Call out that it is remixed"],
    });
    // The remix IS its screen, and none of the capture came with it.
    expect(remixed.source?.["app.tsx"]?.text).toContain("— remixed");
    expect(remixed.components?.[componentName]).toBeUndefined();

    // The HOST changes the component and resyncs: the sync report says drifted.
    await writeFile(componentFile, hostSource.replace(
      "<article><span>Net worth</span>",
      "<article className=\"nw-card\"><span>Total net worth</span>",
    ));
    const resynced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(resynced.pins).toEqual({ captured: [], drifted: [slot], ported: [slot] });
    const newBaseline = seedBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8")));
    expect(newBaseline.hash).not.toBe(oldHash);

    // The host redeploys: a fresh composition loads the NEW baselines over the
    // SAME store. Drift must now be loud on every surface the app rides.
    const redeployed = createVendo({
      models: { default: screenModel(["Total net worth $1.2M — remixed"]) },
      principal: async () => principal,
      store,
      development: true,
    });

    // 1. open() rides the drift report on the payload (the renderer's notice).
    const drifted = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(drifted.kind).toBe("tree");
    expect(drifted.payload.seedDrift).toEqual({
      component: slot,
      componentName,
      baseline: oldHash,
      current: newBaseline.hash,
      reason: "baseline-changed",
    });

    // 2. The re-seed REPLAYS the recorded instruction against the host's new
    //    baseline. That is the whole trade: it rebuilds, so whatever the person
    //    changed since the first edit is gone.
    const reseedResponse = await redeployed.handler(request("POST", `/apps/${appId}/reseed`));
    expect(reseedResponse.status).toBe(200);
    const reseeded = await reseedResponse.json() as AppDocument;
    expect(reseeded.seed).toEqual({
      component: slot,
      baseline: newBaseline.hash,
      wishes: ["Call out that it is remixed"],
    });
    // A NEW screen: the instruction really ran again.
    expect(reseeded.source?.["app.tsx"]?.text).toContain("Total net worth");

    // 3. Drift is gone after the re-seed replays onto the new baseline.
    const afterReseed = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(afterReseed.payload.seedDrift).toBeUndefined();

    // 4. The re-seed sits on the public history like any edit — the version that
    //    moved the provenance, and the replay of the person's own words.
    const history = await (await redeployed.handler(request("GET", `/apps/${appId}/history`))).json();
    const intents = (history as Array<{ intent: string }>).map(({ intent }) => intent);
    expect(intents).toContain(`Update ${slot} to the host's current version`);
    expect(intents).toContain("Call out that it is remixed");
  }, 120_000);

  /**
   * The drift notice promises two things: "Updating replays every change you
   * asked for onto the new version, AND TELLS YOU ABOUT ANY THAT NO LONGER FIT."
   * The replay was real; the telling was not. `reseed` answers 200 with the lost
   * wishes on `seed.unapplied` — the agent tool says that line out loud, and the
   * ✦ menu's Update, the only surface that offers this to a person, read none of
   * it. So a replay that dropped a change the person asked for looked exactly
   * like one that worked, and a replay that landed NOTHING (baseline unmoved,
   * drift notice still up) looked exactly like the button doing nothing at all.
   *
   * The whole journey is the shipped one: the real sync, the real ✦ door, the
   * real `vendo_make` the chat calls, the real wire. Nothing stands in for
   * anything — the page is asked what it can SHOW, because what the page can
   * show is the thing that was missing.
   */
  it("says which wishes the host's new version could not take, on the surface a person reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-reseed-unapplied-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    const slot = "MapleNetWorthCard";
    const hostSource = `export default function MapleNetWorthCard() {
  return <article><span>Net worth</span><strong>$1.2M</strong></article>;
}\n`;
    const componentFile = join(root, "src", "MapleNetWorthCard.tsx");
    await writeFile(componentFile, hostSource);
    await writeFile(join(root, "src", "page.tsx"), `
import { Remixable } from "@vendoai/ui/chrome";
import MapleNetWorthCard from "./MapleNetWorthCard";
export default function Page() {
  return <Remixable><MapleNetWorthCard /></Remixable>;
}
`);
    await vendoSync({ root, out: join(root, ".vendo") });
    const baselineFile = join(root, ".vendo", "remixable", `${slot}.json`);

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);

    const FIRST = "Call out that it is remixed";
    const LOST = "Paint the total purple";
    const vendo = createVendo({
      models: { default: screenModel(["remixed", "remixed, purple"]) },
      principal: async () => principal,
      store,
      development: true,
    });
    // Wish one — the ✦ gesture's own, through its own wire route.
    const seeded = await (await vendo.handler(request("POST", "/apps/seed", {
      component: slot,
      instruction: FIRST,
    }))).json() as AppDocument;
    const appId = seeded.id;
    // Wish two — through the REAL `vendo_make` the chat calls, which is what
    // appends to the wish list. Both are on record before the host moves.
    expect(await vendo.apps.agentTools().execute(
      { id: "call_purple", tool: "vendo_make", args: { app: appId, request: LOST } },
      { principal, venue: "app", presence: "present", sessionId: "session_drift" },
    )).toMatchObject({ status: "ok" });
    expect((await vendo.apps.get(appId, {
      principal, venue: "app", presence: "present", sessionId: "session_drift",
    }))?.seed?.wishes).toEqual([FIRST, LOST]);

    // The host ships a new version that has no total to paint.
    await writeFile(componentFile, hostSource.replace("<strong>$1.2M</strong>", "<em>$1.4M</em>"));
    await vendoSync({ root, out: join(root, ".vendo") });
    const newBaseline = seedBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8")));

    // The host redeploys: fresh composition, new baselines, same store.
    let replaying = false;
    const redeployed = createVendo({
      models: { default: screenModelRefusing(["on the new version"], () => (replaying ? LOST : undefined)) },
      principal: async () => principal,
      store,
      development: true,
    });
    replaying = true;

    // The ✦ menu's "Update", byte for byte: POST /apps/:id/reseed.
    const reseeded = await (await redeployed.handler(request("POST", `/apps/${appId}/reseed`))).json() as AppDocument;

    // The replay REALLY RAN — the first wish landed on the host's new version.
    expect(reseeded.seed?.baseline).toBe(newBaseline.hash);
    expect(reseeded.source?.["app.tsx"]?.text).toContain("on the new version");
    // And the second one did not survive it. The server knows exactly which.
    expect(reseeded.seed?.unapplied).toEqual([LOST]);

    // THE POINT: the page the person is looking at can say so. `open()` is the
    // only thing the ✦ chrome re-reads after an Update, so a report that does
    // not ride this payload reaches nobody — which is how a change the person
    // asked for went missing in silence.
    const opened = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(opened.payload.seedUnapplied).toEqual([LOST]);
  }, 120_000);
});
