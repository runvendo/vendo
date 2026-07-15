import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions";
import { VENDO_APP_FORMAT, type AppDocument, type RunContext } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";

interface ModelCall {
  prompt: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
}

const scriptedModel = (respond: (call: ModelCall) => string): LanguageModel => ({
  specificationVersion: "v2",
  provider: "vendo-pin-fixture",
  modelId: "vendo-pin-fixture-v1",
  supportedUrls: {},
  async doGenerate(call: ModelCall) {
    return {
      content: [{ type: "text" as const, text: respond(call) }],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
  async doStream() {
    throw new Error("fixture model does not stream");
  },
} as unknown as LanguageModel);

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_maple_fixture" },
  venue: "app",
  presence: "present",
  sessionId: "session_maple_fixture",
};

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.sequential("captured pin baseline through the real umbrella", () => {
  it("captures a Maple slot, loads it into createApps, forks it, and enforces export permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-maple-pin-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    const componentSource = `export default function MapleNetWorthCard() {
  return (
    <article style={{ borderRadius: 16, padding: 24, background: "#fff" }}>
      <span>Net worth</span>
      <strong>$1.2M</strong>
    </article>
  );
}\n`;
    await writeFile(join(root, "src", "MapleNetWorthCard.tsx"), componentSource);
    await writeFile(join(root, "src", "host-catalog.tsx"), `
import MapleNetWorthCard from "./MapleNetWorthCard";
export const hostCatalog = [{
  name: "net-worth-card",
  component: MapleNetWorthCard,
  remixable: true,
  exportable: false,
}];
`);

    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.pins).toEqual({ captured: ["net-worth-card"], drifted: [] });
    await writeFile(join(root, ".vendo", "remixable", "invalid.json"), "{not json\n");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let prompt = "";
    const model = scriptedModel((call) => {
      prompt = call.prompt.map((message) => typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join("")).join("\n");
      return JSON.stringify({
        ops: [{ op: "fork-pin", slot: "net-worth-card", nodeId: "maple-net-worth", parentId: "root" }],
      });
    });
    const dataDir = join(root, ".data");
    const store = createStore({ dataDir });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    const vendo = createVendo({
      model,
      principal: async () => ctx.principal,
      store,
    });
    const seed: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_fixture_identity_is_replaced",
      name: "Maple overview",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    const imported = await vendo.apps.importApp(seed, ctx);

    const edited = await vendo.apps.edit(imported.id, "Remix the net worth card", ctx);

    expect(prompt).toContain("net-worth-card");
    expect(prompt).toContain("MapleNetWorthCard");
    expect(prompt).toContain("$1.2M");
    expect(edited.app.pins).toEqual([{
      slot: "net-worth-card",
      base: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }]);
    const [componentName, pinnedSource] = Object.entries(edited.app.components ?? {})[0] ?? [];
    expect(componentName).toMatch(/^PinnedNetWorthCard/);
    expect(pinnedSource).toBe(componentSource);
    expect(edited.app.tree).toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({
        id: "maple-net-worth",
        component: componentName,
        source: "generated",
      })]),
    });
    await expect(vendo.apps.exportApp(edited.app.id, ctx)).rejects.toMatchObject({
      code: "blocked",
      detail: { reason: "baseline-forbids-export" },
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("invalid.json"));
  }, 120_000);
});
