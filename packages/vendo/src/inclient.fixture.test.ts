import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions";
import { appVersionHash, pinComponentName } from "@vendoai/apps";
import { VENDO_APP_FORMAT, type AppDocument, type Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

interface ModelCall {
  prompt: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
}

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
    provider: "vendo-inclient-fixture",
    modelId: "vendo-inclient-fixture-v1",
    supportedUrls: {},
    async doGenerate(_call: ModelCall) {
      return {
        content: [{ type: "text" as const, text: next() }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(_call: ModelCall) {
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

const principal: Principal = { kind: "user", subject: "user_promotion_fixture" };

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

describe.sequential("06-apps §9 — the in-client promotion journey through the real umbrella", () => {
  it("fork → visible ship-diff → injected approval → host-page verdict → new version drops back → re-approval", async () => {
    // A remixable host slot, captured by the REAL sync.
    const root = await mkdtemp(join(tmpdir(), "vendo-inclient-journey-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    const hostSource = `export default function MapleNetWorthCard() {
  return <article><span>Net worth</span><strong>$1.2M</strong></article>;
}\n`;
    await writeFile(join(root, "src", "MapleNetWorthCard.tsx"), hostSource);
    await writeFile(join(root, "src", "host-catalog.tsx"), `
import MapleNetWorthCard from "./MapleNetWorthCard";
export const hostCatalog = [{
  name: "net-worth-card",
  component: MapleNetWorthCard,
  remixable: true,
  exportable: true,
}];
`);
    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.pins.captured).toEqual(["net-worth-card"]);

    const componentName = pinComponentName("net-worth-card");
    const remixedSource = hostSource.replace("$1.2M", "$1.2M — remixed");
    const model = scriptedModel([
      // Edit 1: fork the pin (copies captured source verbatim, records the pin).
      JSON.stringify({ ops: [{ op: "fork-pin", slot: "net-worth-card", nodeId: "worth", parentId: "root" }] }),
      // Edit 2: change the fork — the reviewable delta the ship-diff must show.
      JSON.stringify({ ops: [{ op: "add-component", name: componentName, source: remixedSource }] }),
      // Edit 3: any content change after approval — must invalidate the pin.
      JSON.stringify({ ops: [{ op: "set-name", name: "Net worth (renamed)" }] }),
    ]);

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    const vendo = createVendo({
      model,
      principal: async () => principal,
      store,
      development: { root },
    });
    const ctx = { principal, venue: "app" as const, presence: "present" as const, sessionId: "session_journey" };

    const imported = await vendo.apps.importApp({
      format: VENDO_APP_FORMAT,
      id: "app_identity_is_replaced",
      name: "Maple overview",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    } as AppDocument, ctx);

    const forked = await vendo.apps.edit(imported.id, "Remix the net worth card", ctx);
    expect(forked.failure).toBeUndefined();
    const remixed = await vendo.apps.edit(imported.id, "Call out that it is remixed", ctx);
    expect(remixed.failure).toBeUndefined();
    const appId = imported.id;

    // 1. The ship-diff is visible over the wire and shows exactly the net change.
    const shipDiffResponse = await vendo.handler(request("GET", `/apps/${appId}/ship-diff`));
    expect(shipDiffResponse.status).toBe(200);
    const shipDiff = await shipDiffResponse.json();
    expect(shipDiff).toMatchObject({
      appId,
      versionHash: appVersionHash(remixed.app),
      pins: [{
        slot: "net-worth-card",
        component: componentName,
        drifted: false,
      }],
    });
    expect(shipDiff.pins[0].diff).toContain("-  return <article><span>Net worth</span><strong>$1.2M</strong></article>;");
    expect(shipDiff.pins[0].diff).toContain("+  return <article><span>Net worth</span><strong>$1.2M — remixed</strong></article>;");

    // 2. Before approval: open() carries no venue verdict — jailed by default.
    const unapproved = await (await vendo.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(unapproved.kind).toBe("tree");
    expect(unapproved.payload.inClient).toBeUndefined();

    // 3. Inject the approval through the documented dev seam (Cloud's console in prod).
    const approvalResponse = await vendo.handler(request("POST", "/dev/inclient-approval", {
      appId,
      approvedBy: "maple-security-review",
    }));
    expect(approvalResponse.status).toBe(200);
    const approval = await approvalResponse.json();
    expect(approval).toMatchObject({
      appId,
      versionHash: shipDiff.versionHash,
      approvedBy: "maple-security-review",
    });

    // 4. The verdict now grants the host-page mount, pinned to that exact hash.
    const granted = await (await vendo.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(granted.payload.inClient).toMatchObject({
      granted: true,
      versionHash: approval.versionHash,
      approvedBy: "maple-security-review",
    });

    // 5. A NEW VERSION (any content change) drops back to the iframe, loudly.
    const renamed = await vendo.apps.edit(appId, "Rename the app", ctx);
    expect(renamed.failure).toBeUndefined();
    const dropped = await (await vendo.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(dropped.payload.inClient).toEqual({
      granted: false,
      versionHash: appVersionHash(renamed.app),
      reason: "version-changed",
    });
    expect(dropped.payload.inClient.versionHash).not.toBe(approval.versionHash);

    // 6. Re-approval of the new version is required — and sufficient.
    const reapproved = await (await vendo.handler(request("POST", "/dev/inclient-approval", {
      appId,
      approvedBy: "maple-security-review",
    }))).json();
    expect(reapproved.versionHash).toBe(appVersionHash(renamed.app));
    const regranted = await (await vendo.handler(request("GET", `/apps/${appId}/open`))).json();
    expect(regranted.payload.inClient).toMatchObject({ granted: true });
  }, 120_000);
});
