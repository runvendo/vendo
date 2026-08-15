import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { seedBaselineSchema } from "@vendoai/apps";
import { seedComponentName, type RunContext } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

interface ModelCall {
  prompt: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
}

const scriptedModel = (respond: (call: ModelCall) => string): LanguageModel => ({
  specificationVersion: "v2",
  provider: "vendo-seed-fixture",
  modelId: "vendo-seed-fixture-v1",
  supportedUrls: {},
  async doGenerate(call: ModelCall) {
    return {
      content: [{ type: "text" as const, text: respond(call) }],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
  async doStream(call: ModelCall) {
    const text = respond(call);
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

describe.sequential("a captured seed baseline through the real umbrella", () => {
  it("captures a furnished Maple slot, loads it into createVendo, seeds an app from it, opens it furnished, and enforces export permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-maple-seed-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "src", "app"), { recursive: true });
    const badgeSource = `export function MapleTrendBadge() {
  return <span className="maple-trend-badge">+4.2%</span>;
}\n`;
    const componentSource = `import { MapleTrendBadge } from "./MapleTrendBadge";

export default function MapleNetWorthCard() {
  return (
    <article style={{ borderRadius: 16, padding: 24, background: "#fff" }}>
      <span>Net worth</span>
      <strong>$1.2M</strong>
      <MapleTrendBadge />
    </article>
  );
}\n`;
    const rootCss = ".maple-trend-badge { color: rgb(22, 101, 52); }\n";
    await writeFile(join(root, "src", "MapleTrendBadge.tsx"), badgeSource);
    await writeFile(join(root, "src", "MapleNetWorthCard.tsx"), componentSource);
    await writeFile(join(root, "src", "app", "globals.css"), rootCss);
    await writeFile(join(root, "src", "app", "layout.tsx"), `
import "./globals.css";
export default function Layout({ children }) { return children; }
`);
    await writeFile(join(root, "src", "app", "page.tsx"), `
import { Remixable } from "@vendoai/ui/chrome";
import MapleNetWorthCard from "../MapleNetWorthCard";
export default function Page() {
  return <Remixable><MapleNetWorthCard /></Remixable>;
}
`);

    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.remixableErrors).toEqual([]);
    expect(synced.pins).toEqual({ captured: ["MapleNetWorthCard"], drifted: [] });
    const baseline = seedBaselineSchema.parse(JSON.parse(
      await readFile(join(root, ".vendo", "remixable", "MapleNetWorthCard.json"), "utf8"),
    ));
    expect(baseline.sourceImports).toEqual({ "./MapleTrendBadge": "src/MapleTrendBadge.tsx" });
    expect(baseline.subSources).toEqual({
      "src/MapleTrendBadge.tsx": { source: badgeSource, imports: {} },
    });
    expect(baseline.sampleProps).toBeUndefined();
    expect(baseline.styles).toEqual([{ path: "src/app/globals.css", css: rootCss }]);
    await writeFile(join(root, ".vendo", "remixable", "invalid.json"), "{not json\n");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let modelCalls = 0;
    const model = scriptedModel(() => {
      modelCalls += 1;
      return "";
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

    // The ✦ gesture is a CREATE that starts from something: it records where the
    // remix came from and runs the person's instruction through the ordinary
    // edit door. Nothing copies the captured source into the app.
    const app = await vendo.apps.seed.from(
      { component: "MapleNetWorthCard", instruction: "call out the trend" },
      ctx,
    );

    // The instruction really reached the builder — the gesture is not a bare fork.
    expect(modelCalls).toBeGreaterThan(0);
    expect(app.seed).toEqual({
      component: "MapleNetWorthCard",
      baseline: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      instruction: "call out the trend",
    });
    // Not one byte of the capture — no seat, no sub-modules, no host stylesheet.
    const stored = JSON.stringify(app);
    expect(app.components?.[seedComponentName("MapleNetWorthCard")]).toBeUndefined();
    expect(stored).not.toContain(badgeSource.trim());
    expect(stored).not.toContain(componentSource.trim());
    expect(stored).not.toContain(rootCss.trim());
    await expect(vendo.apps.exportApp(app.id, ctx)).rejects.toMatchObject({
      code: "blocked",
      detail: { reason: "baseline-forbids-export" },
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("invalid.json"));
  }, 120_000);

  it("exports a seeded app with an exportable baseline and preserves its seed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-maple-exportable-seed-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    const componentSource = `export default function MapleNetWorthCard() {
  return <article><span>Net worth</span><strong>$1.2M</strong></article>;
}\n`;
    await writeFile(join(root, "src", "MapleNetWorthCard.tsx"), componentSource);
    await writeFile(join(root, "src", "page.tsx"), `
import { Remixable } from "@vendoai/ui/chrome";
import MapleNetWorthCard from "./MapleNetWorthCard";
export default function Page() {
  return <Remixable><MapleNetWorthCard /></Remixable>;
}
`);

    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.pins).toEqual({ captured: ["MapleNetWorthCard"], drifted: [] });
    // Sync always writes exportable: false now; raise it by hand to prove the
    // apps-side export gate still honors an exportable (legacy) baseline.
    const baselineFile = join(root, ".vendo", "remixable", "MapleNetWorthCard.json");
    const captured = JSON.parse(await readFile(baselineFile, "utf8"));
    await writeFile(baselineFile, JSON.stringify({ ...captured, exportable: true }, null, 2));
    // The gesture never reaches the model; the composition still wants one.
    const model = scriptedModel(() => "");
    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    const vendo = createVendo({
      model,
      principal: async () => ctx.principal,
      store,
    });

    const app = await vendo.apps.seed.from(
      { component: "MapleNetWorthCard", instruction: "call out the trend" },
      ctx,
    );
    const archive = await vendo.apps.exportApp(app.id, ctx);
    const exported = await vendo.apps.importApp(archive, ctx);

    expect(app.seed).toEqual({
      component: "MapleNetWorthCard",
      baseline: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      instruction: "call out the trend",
    });
    // The provenance — including the instruction a re-seed replays — survives
    // the round trip. There is no captured seat to survive.
    expect(exported.seed).toEqual(app.seed);
  }, 120_000);
});
