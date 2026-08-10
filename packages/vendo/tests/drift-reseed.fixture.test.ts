import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { appVersionHash, seedBaselineSchema } from "@vendoai/apps";
import {
  bundleOf,
  seedComponentName,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import {
  componentSources,
  printWire,
} from "@vendoai/apps/contract";
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
const SAVED_MARKER = "Run validate on it now.";

/**
 * The screen agent, scripted, for the ONE model-driven step in this journey —
 * the user's edit. It reads the app's document as it stands, adds the remix note
 * to the seeded island's source, and saves the whole thing back.
 *
 * The re-seed below never comes through here: it is deterministic (d6 — a plain
 * swap for the pristine new component, with no replay).
 */
const screenModel = (document: () => Promise<string>): LanguageModel => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const saving = (prompt: string): boolean =>
    prompt.includes(SCREEN_BRIEF_MARKER) && !prompt.includes(SAVED_MARKER);
  const rewrite = async (): Promise<string> => (await document()).replace("$1.2M", "$1.2M — remixed");
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
          input: JSON.stringify({ content: await rewrite() }),
        }],
        finishReason: "tool-calls" as const,
        usage,
      };
    },
    async doStream(call: ModelCall) {
      const content = saving(promptText(call)) ? await rewrite() : undefined;
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
  it("sync → seed → edit → host change + resync → loud drift → re-seed REPLACES → approval drops", async () => {
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
    expect(synced.pins).toEqual({ captured: [slot], drifted: [] });
    const baselineFile = join(root, ".vendo", "remixable", `${slot}.json`);
    const oldHash = seedBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8"))).hash;

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    const ctx = { principal, venue: "app" as const, presence: "present" as const, sessionId: "session_drift" };

    /** The composition currently serving, and the app under edit — both are set
     *  as the journey reaches them, because the assembler opens the app's own
     *  document and the host redeploys halfway through. */
    let active: ReturnType<typeof createVendo> | undefined;
    let appUnderEdit: string | undefined;
    const asItStands = async (): Promise<string> => {
      const app = await active!.apps.get(appUnderEdit!, ctx);
      if (app === null) throw new Error("no app row to rewrite");
      return printWire(
        { tree: app.tree as never, components: componentSources(app.components), name: app.name },
        { includeIds: true },
      );
    };

    // ONE host process lifetime: seed the app (gesture, no model) and edit it.
    const vendo = createVendo({
      model: screenModel(asItStands),
      principal: async () => principal,
      store,
      development: true,
    });
    active = vendo;
    // Gesture-owned seeding: the seed rides its own wire route, executed
    // deterministically by the engine — the model never sees it.
    const seedResponse = await vendo.handler(request("POST", "/apps/seed", { component: slot }));
    expect(seedResponse.status).toBe(200);
    const seeded = await seedResponse.json() as AppDocument;
    const appId = seeded.id;
    appUnderEdit = appId;
    expect(seeded.seed).toEqual({ component: slot, baseline: oldHash });
    expect(bundleOf(seeded.components![componentName]!).source).toContain("$1.2M");
    const remixed = await vendo.apps.edit(appId, "Call out that it is remixed", ctx);
    expect(remixed.failure).toBeUndefined();
    expect(remixed.app.seed).toEqual({ component: slot, baseline: oldHash });
    // The person's own change really is in the seat — otherwise "the re-seed
    // replaces it" below would prove nothing.
    expect(bundleOf(remixed.app.components![componentName]!).source).toContain("— remixed");

    // The pre-drift version gets an in-client approval (dev injection seam).
    const approval = await (await vendo.handler(request("POST", "/dev/inclient-approval", {
      appId,
      approvedBy: "maple-security-review",
    }))).json();
    expect(approval.versionHash).toBe(appVersionHash(remixed.app));

    // The HOST changes the component and resyncs: the sync report says drifted.
    await writeFile(componentFile, hostSource.replace(
      "<article><span>Net worth</span>",
      "<article className=\"nw-card\"><span>Total net worth</span>",
    ));
    const resynced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(resynced.pins).toEqual({ captured: [], drifted: [slot] });
    const newBaseline = seedBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8")));
    expect(newBaseline.hash).not.toBe(oldHash);

    // The host redeploys: a fresh composition loads the NEW baselines over the
    // SAME store. Drift must now be loud on every surface the app rides.
    const redeployed = createVendo({
      model: screenModel(asItStands),
      principal: async () => principal,
      store,
      development: true,
    });
    active = redeployed;

    // 1. open() rides the drift report on the payload (the renderer's notice)
    //    while the untouched version keeps its hash-pinned approval. ONE seed,
    //    ONE verdict — an object, never a row set.
    const drifted = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(drifted.kind).toBe("tree");
    expect(drifted.payload.seedDrift).toEqual({
      component: slot,
      componentName,
      baseline: oldHash,
      current: newBaseline.hash,
      reason: "baseline-changed",
    });
    expect(drifted.payload.inClient).toMatchObject({ granted: true });

    // 2. The ship-diff fail-closes review with its drifted flag (M4).
    const shipDiff = await (await redeployed.handler(request("GET", `/apps/${appId}/ship-diff`))).json();
    expect(shipDiff.pins).toEqual([expect.objectContaining({ slot, drifted: true })]);

    // 3. The re-seed swaps in the PRISTINE new component. That is the whole
    //    trade: it replaces what the person made, and nothing is replayed.
    const reseedResponse = await redeployed.handler(request("POST", `/apps/${appId}/reseed`));
    expect(reseedResponse.status).toBe(200);
    const reseeded = await reseedResponse.json() as AppDocument;
    expect(reseeded.seed).toEqual({ component: slot, baseline: newBaseline.hash });
    const reseededSource = bundleOf(reseeded.components![componentName]!).source;
    expect(reseededSource).toContain("Total net worth");
    expect(reseededSource).not.toContain("— remixed");

    // 4. Drift is gone — and the re-seed minted a NEW version, so the old
    //    in-client approval no longer grants: back to the sandbox, loudly.
    const afterReseed = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(afterReseed.payload.seedDrift).toBeUndefined();
    expect(afterReseed.payload.inClient).toEqual({
      granted: false,
      versionHash: appVersionHash(reseeded),
      reason: "version-changed",
    });
    expect(afterReseed.payload.inClient.versionHash).not.toBe(approval.versionHash);

    // 5. The re-seed version sits on the public history like any edit.
    const history = await (await redeployed.handler(request("GET", `/apps/${appId}/history`))).json();
    expect(history[0].intent).toContain(`Update ${slot} to the host's current version`);
  }, 120_000);
});
