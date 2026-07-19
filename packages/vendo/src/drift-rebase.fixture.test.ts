import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions";
import { appVersionHash, pinBaselineSchema, pinComponentName } from "@vendoai/apps";
import { VENDO_APP_FORMAT, type AppDocument, type Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const scriptedModel = (responses: string[]): LanguageModel => {
  let call = 0;
  const next = (): string => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (response === undefined) throw new Error("scripted model exhausted");
    return response;
  };
  return {
    specificationVersion: "v2",
    provider: "vendo-drift-fixture",
    modelId: "vendo-drift-fixture-v1",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text" as const, text: next() }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream() {
      const text = next();
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
    const slot = "net-worth-card";
    const componentName = pinComponentName(slot);
    const hostSource = `export default function MapleNetWorthCard() {
  return <article><span>Net worth</span><strong>$1.2M</strong></article>;
}\n`;
    const componentFile = join(root, "src", "MapleNetWorthCard.tsx");
    await writeFile(componentFile, hostSource);
    await writeFile(join(root, "src", "host-catalog.tsx"), `
import MapleNetWorthCard from "./MapleNetWorthCard";
export const hostCatalog = [{
  name: "${slot}",
  component: MapleNetWorthCard,
  remixable: true,
  exportable: true,
}];
`);
    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.pins).toEqual({ captured: [slot], drifted: [] });
    const baselineFile = join(root, ".vendo", "remixable", `${slot}.json`);
    const oldHash = pinBaselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8"))).hash;

    const remixedSource = hostSource.replace("$1.2M", "$1.2M — remixed");
    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    const ctx = { principal, venue: "app" as const, presence: "present" as const, sessionId: "session_drift" };

    // ONE host process lifetime: fork the pin and edit the fork.
    const vendo = createVendo({
      model: scriptedModel([
        `<Edit><ForkPin slot="${slot}" into="root"/></Edit>`,
        `<Edit><Island name="${componentName}">${remixedSource}</Island></Edit>`,
      ]),
      principal: async () => principal,
      store,
      development: { root },
    });
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
    const forked = await vendo.apps.edit(appId, "Remix the net worth card", ctx);
    expect(forked.failure).toBeUndefined();
    expect(forked.driftedPins).toBeUndefined();
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
      model: scriptedModel([
        // The rebase replays the ONE recorded pin intent through the model.
        `<Edit><Island name="${componentName}">${newBaseline.source.replace("$1.2M", "$1.2M — remixed")}</Island></Edit>`,
      ]),
      principal: async () => principal,
      store,
      development: { root },
    });
    const expectedDrift = {
      slot,
      component: componentName,
      baseHash: oldHash,
      baselineHash: newBaseline.hash,
      reason: "baseline-changed",
    };

    // 1. The dedicated wire route reports the drift.
    const driftResponse = await redeployed.handler(request("GET", `/apps/${appId}/pin-drift`));
    expect(driftResponse.status).toBe(200);
    expect(await driftResponse.json()).toEqual([expectedDrift]);

    // 2. open() rides the drift report on the payload (the renderer's notice)
    //    while the untouched version keeps its hash-pinned approval.
    const drifted = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(drifted.kind).toBe("tree");
    expect(drifted.payload.pinDrift).toEqual([expectedDrift]);
    expect(drifted.payload.inClient).toMatchObject({ granted: true });

    // 3. The ship-diff fail-closes review with its drifted flag (M4).
    const shipDiff = await (await redeployed.handler(request("GET", `/apps/${appId}/ship-diff`))).json();
    expect(shipDiff.pins).toEqual([expect.objectContaining({ slot, drifted: true })]);

    // 4. The rebase re-forks the NEW baseline and replays the recorded intent.
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

    // 5. Drift is gone — and the rebase minted a NEW version, so the old
    //    in-client approval no longer grants: back to the sandbox, loudly.
    const afterRebase = await (await redeployed.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(afterRebase.payload.pinDrift).toBeUndefined();
    expect(afterRebase.payload.inClient).toEqual({
      granted: false,
      versionHash: appVersionHash(rebase.app),
      reason: "version-changed",
    });
    expect(afterRebase.payload.inClient.versionHash).not.toBe(approval.versionHash);

    // 6. The rebase version sits on the public history like any edit.
    const history = await (await redeployed.handler(request("GET", `/apps/${appId}/history`))).json();
    expect(history[0].intent).toContain(`Rebase remixed ${slot}`);
  }, 120_000);
});
