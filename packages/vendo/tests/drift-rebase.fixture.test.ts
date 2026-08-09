import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { appVersionHash, pinBaselineSchema, pinComponentName } from "@vendoai/apps";
import { VENDO_APP_FORMAT, printWire, type AppDocument, type Principal } from "@vendoai/core";
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
 * The screen agent, scripted. There is one builder now, so both the user's edit
 * and the rebase's REPLAY of that same recorded intent come through here: read
 * the app's document as it stands, add the remix note to the pinned island's
 * source, save the whole thing back.
 *
 * Reading the document rather than a printed copy in the prompt is what keeps
 * the same script correct on the replay, where the island source is the host's
 * NEW baseline.
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

describe.sequential("06-apps §8 — the drift→rebase journey through the real umbrella", () => {
  it("sync → fork → edit → host change + resync → loud drift → rebase replays intents → approval drops", async () => {
    // A remixable host slot, captured by the REAL sync.
    const root = await mkdtemp(join(tmpdir(), "vendo-drift-rebase-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    const slot = "MapleNetWorthCard";
    const componentName = pinComponentName(slot);
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
    const oldHash = pinBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8"))).hash;

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
        { tree: app.tree as never, components: app.components ?? {}, name: app.name },
        { includeIds: true },
      );
    };

    // ONE host process lifetime: fork the pin (gesture, no model) and edit the fork.
    const vendo = createVendo({
      model: screenModel(asItStands),
      principal: async () => principal,
      store,
      development: true,
    });
    active = vendo;
    const imported = await vendo.apps.importApp({
      format: VENDO_APP_FORMAT,
      id: "app_identity_is_replaced",
      name: "Maple overview",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    } as AppDocument, ctx);
    const appId = imported.id;
    appUnderEdit = appId;
    // Gesture-owned forking (2026-07-21): the fork rides its own wire route,
    // executed deterministically by the engine — the model never sees it.
    const forkResponse = await vendo.handler(request("POST", `/apps/${appId}/fork-pin`, { slot }));
    expect(forkResponse.status).toBe(200);
    const forked = await forkResponse.json();
    expect(forked.componentName).toBe(componentName);
    expect(forked.app.pins).toEqual([{ slot, base: oldHash }]);
    expect(forked.app.components[componentName]).toContain("$1.2M");
    const remixed = await vendo.apps.edit(appId, "Call out that it is remixed", ctx);
    expect(remixed.failure).toBeUndefined();
    expect(remixed.app.pins).toEqual([{ slot, base: oldHash }]);

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
    const newBaseline = pinBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8")));
    expect(newBaseline.hash).not.toBe(oldHash);

    // The host redeploys: a fresh composition loads the NEW baselines over the
    // SAME store. Drift must now be loud on every surface the app rides.
    const redeployed = createVendo({
      // The rebase replays the ONE recorded pin intent through the same builder,
      // which now opens the app with the NEW baseline source under the pinned
      // component.
      model: screenModel(asItStands),
      principal: async () => principal,
      store,
      development: true,
    });
    active = redeployed;
    const expectedDrift = {
      slot,
      component: componentName,
      baseHash: oldHash,
      baselineHash: newBaseline.hash,
      reason: "baseline-changed",
    };

    // 1. open() rides the drift report on the payload (the renderer's notice)
    //    while the untouched version keeps its hash-pinned approval.
    const drifted = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(drifted.kind).toBe("tree");
    expect(drifted.payload.pinDrift).toEqual([expectedDrift]);
    expect(drifted.payload.inClient).toMatchObject({ granted: true });

    // 2. The ship-diff fail-closes review with its drifted flag (M4).
    const shipDiff = await (await redeployed.handler(request("GET", `/apps/${appId}/ship-diff`))).json();
    expect(shipDiff.pins).toEqual([expect.objectContaining({ slot, drifted: true })]);

    // 3. The rebase re-forks the NEW baseline and replays the recorded intent.
    const rebaseResponse = await redeployed.handler(request("POST", `/apps/${appId}/rebase-pin`, { slot }));
    expect(rebaseResponse.status).toBe(200);
    const rebase = await rebaseResponse.json();
    expect(rebase).toMatchObject({
      status: "rebased",
      slot,
      baseHash: newBaseline.hash,
      replayed: ["Call out that it is remixed"],
    });
    expect(rebase.app.pins).toEqual([{ slot, base: newBaseline.hash }]);
    expect(rebase.app.components[componentName]).toContain("Total net worth");
    expect(rebase.app.components[componentName]).toContain("— remixed");

    // 4. Drift is gone — and the rebase minted a NEW version, so the old
    //    in-client approval no longer grants: back to the sandbox, loudly.
    const afterRebase = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(afterRebase.payload.pinDrift).toBeUndefined();
    expect(afterRebase.payload.inClient).toEqual({
      granted: false,
      versionHash: appVersionHash(rebase.app),
      reason: "version-changed",
    });
    expect(afterRebase.payload.inClient.versionHash).not.toBe(approval.versionHash);

    // 5. The rebase version sits on the public history like any edit.
    const history = await (await redeployed.handler(request("GET", `/apps/${appId}/history`))).json();
    expect(history[0].intent).toContain(`Rebase remixed ${slot}`);
  }, 120_000);
});
