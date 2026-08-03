import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
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

const promptText = (call: ModelCall): string => call.prompt
  .map((message) => typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join(""))
  .join("\n");

const APP_AS_IT_STANDS = "THE APP AS IT STANDS — the only true copy of it, and what an <Old> must quote:\n";

/** The app exactly as the brain was shown it — the text every answer is built
 *  from. */
const printedApp = (prompt: string): string => {
  const at = prompt.indexOf(APP_AS_IT_STANDS);
  if (at === -1) return "";
  return prompt.slice(at + APP_AS_IT_STANDS.length).split("\n\nTHEY ARE ASKING NOW:")[0] ?? "";
};

/** What this turn was ASKED to do. The live ask carries its own marker, so it is
 *  unambiguous even though the carried conversation quotes earlier turns. */
const instructionOf = (prompt: string): string => {
  const marker = "THEY ARE ASKING NOW: ";
  const at = prompt.lastIndexOf(marker);
  return at === -1 ? "" : (prompt.slice(at + marker.length).split("\n")[0] ?? "");
};

const scriptedModel = (respond: (prompt: string) => string): LanguageModel => {
  return {
    specificationVersion: "v2",
    provider: "vendo-inclient-fixture",
    modelId: "vendo-inclient-fixture-v1",
    supportedUrls: {},
    async doGenerate(call: ModelCall) {
      return {
        content: [{ type: "text" as const, text: respond(promptText(call)) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(call: ModelCall) {
      const text = respond(promptText(call));
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
    await writeFile(join(root, "src", "page.tsx"), `
import { Remixable } from "@vendoai/ui/chrome";
import MapleNetWorthCard from "./MapleNetWorthCard";
export default function Page() {
  return <Remixable><MapleNetWorthCard /></Remixable>;
}
`);
    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.pins.captured).toEqual(["MapleNetWorthCard"]);

    const componentName = pinComponentName("MapleNetWorthCard");
    // The brain, scripted. Only BRAIN turns are answered ("THEY ARE ASKING NOW:" is its
    // marker); the AI reviewer rides the same model and reports nothing.
    const model = scriptedModel((prompt) => {
      if (!prompt.includes("THEY ARE ASKING NOW:")) return "";
      // Any content change after approval — must invalidate the pin. The app's
      // name is printed on its opening <App> line, so a rename is one edit.
      if (instructionOf(prompt).startsWith("Rename")) {
        return '<Edit><Old><App name="Maple overview"></Old><New><App name="Net worth (renamed)"></New></Edit>';
      }
      // Change the fork — the reviewable delta the ship-diff must show. Written
      // WHOLE (a finished <App>, the tiny-ask answer) off the app as it stands.
      return printedApp(prompt).replace("$1.2M", "$1.2M — remixed");
    });

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    const vendo = createVendo({
      model,
      principal: async () => principal,
      store,
      development: true,
    });
    const ctx = { principal, venue: "app" as const, presence: "present" as const, sessionId: "session_journey" };

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

    // The fork is the user's Remix GESTURE, executed deterministically by the
    // engine (the captured source is copied, the pin recorded, no model call).
    const forked = await vendo.apps.pins.fork({ appId: imported.id, slot: "MapleNetWorthCard" }, ctx);
    expect(forked.componentName).toBe(componentName);
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
        slot: "MapleNetWorthCard",
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
