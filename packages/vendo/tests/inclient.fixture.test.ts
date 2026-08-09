import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { appVersionHash, pinComponentName } from "@vendoai/apps";
import { VENDO_APP_FORMAT, printWire, type AppDocument, type Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

interface ModelCall {
  prompt: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
}

/** The WHOLE prompt as text — tool results included. A `save_app` reply is a
 *  tool-result part, not a text part, and it is what tells this model that the
 *  current run has already saved. */
const promptText = (call: ModelCall): string => JSON.stringify(call.prompt ?? "");

/** The screen agent's own brief (`environmentNote`), verbatim — the one marker
 *  that says a prompt belongs to the assembly loop. An EDIT rides the same loop
 *  now: the assembler opens this app's document, rewrites it, and saves the
 *  whole thing back. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** `save_app`'s own reply. Its presence in the prompt means THIS run already
 *  saved, which is how one model answers a multi-step loop without counting
 *  calls across runs. */
const SAVED_MARKER = "Run validate on it now.";

/**
 * A model that plays the screen agent: one `save_app` carrying the whole
 * rewritten document, then a closing word.
 *
 * `rewrite` gets the prompt and answers with the complete new `.vendo` document
 * — which is the only edit dialect there is now.
 */
const screenModel = (rewrite: (prompt: string) => Promise<string>): LanguageModel => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const saving = (prompt: string): boolean =>
    prompt.includes(SCREEN_BRIEF_MARKER) && !prompt.includes(SAVED_MARKER);
  return {
    specificationVersion: "v2",
    provider: "vendo-inclient-fixture",
    modelId: "vendo-inclient-fixture-v1",
    supportedUrls: {},
    async doGenerate(call: ModelCall) {
      const prompt = promptText(call);
      if (!saving(prompt)) {
        return { content: [{ type: "text" as const, text: "done" }], finishReason: "stop" as const, usage };
      }
      return {
        content: [{
          type: "tool-call" as const,
          toolCallId: "call_save_app",
          toolName: "save_app",
          input: JSON.stringify({ content: await rewrite(prompt) }),
        }],
        finishReason: "tool-calls" as const,
        usage,
      };
    },
    async doStream(call: ModelCall) {
      const prompt = promptText(call);
      const content = saving(prompt) ? await rewrite(prompt) : undefined;
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
    const ctx = { principal, venue: "app" as const, presence: "present" as const, sessionId: "session_journey" };
    let composed: Vendo | undefined;
    /** The app under edit. Set once it is imported — `importApp` mints the id,
     *  it never keeps the one in the source document. */
    let appUnderEdit: string | undefined;
    /** The app's own document, printed exactly as a checkout prints it — the
     *  text the assembler opens before it rewrites anything. */
    const asItStands = async (): Promise<string> => {
      const app = await composed!.apps.get(appUnderEdit!, ctx);
      if (app === null) throw new Error("no app row to rewrite");
      return printWire(
        { tree: app.tree as never, components: app.components ?? {}, name: app.name },
        { includeIds: true },
      );
    };
    // The screen agent, scripted. There is one builder now, so an edit is the
    // assembly loop rewriting this app's WHOLE document and saving it back.
    const model = screenModel(async (prompt) => {
      const document = await asItStands();
      // Any content change after approval — must invalidate the pin. The app's
      // name is printed on its opening <App> line, so a rename is one edit.
      if (prompt.includes("Rename the app")) {
        return document.replace('<App name="Maple overview">', '<App name="Net worth (renamed)">');
      }
      // Change the fork — the reviewable delta the ship-diff must show, written
      // into the pinned island's own source.
      return document.replace("$1.2M", "$1.2M — remixed");
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
    composed = vendo;

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
    appUnderEdit = imported.id;

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
