// Remix final shape (2026-08-02) — an edit must never land inside a pinned
// fork. The fork's source is the user's copy of the HOST's component, and the
// ship-diff review is meaningful only because that copy changes exclusively
// when the user asks to change THAT component. The rule is structural in the
// patch contract: a change to a pinned component's source applies only
// alongside an explicit <EditPin name="..."/> target declaration; content the
// instruction wants NEAR the fork lands as a sibling; a violating patch is
// rejected whole with a readable issue so the repair loop gets a chance.
import type { AppDocument, RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type PinBaseline } from "./index.js";
import { pinComponentName } from "./pins.js";
import { computeShipDiff } from "./ship-diff.js";
import {
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
  type ScriptedModelCall,
} from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_pin_guard" },
  venue: "app",
  presence: "present",
  sessionId: "session_pin_guard",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const SLOT = "net-worth-card";
const COMPONENT = pinComponentName(SLOT);
const PIN_NODE = `${COMPONENT.toLowerCase()}-1`;
const SOURCE = `// Host provenance comment the fork must carry.
export default function NetWorthCard() {
  return <strong>$1.2M</strong>;
}`;

const baseline: PinBaseline = {
  slot: SLOT,
  source: SOURCE,
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
};

/** An app that already carries the fork, exactly as pins.fork leaves it. */
const forkedDoc = (id = "app_pinned"): AppDocument => ({
  format: "vendo/app@1",
  id,
  name: "My corner",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: [PIN_NODE] },
      { id: PIN_NODE, component: COMPONENT, source: "generated" },
    ],
  },
  components: { [COMPONENT]: SOURCE },
  componentTools: { [COMPONENT]: [] },
  pins: [{ slot: SLOT, base: "sha256:maple-base" }],
});

const runtimeWith = (store: StoreAdapter, overrides: Partial<AppsConfig> = {}) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  pinBaselines: [baseline],
  ...overrides,
});

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const SIBLING_PATCH = `<Edit>
  <Island name="SpendChart">export default function SpendChart() { return <div>chart</div>; }</Island>
  <Insert into="root"><SpendChart/></Insert>
</Edit>`;

// The observed violation shape: asked for content NEXT TO the fork, the model
// implants it INTO the pinned component's source instead.
const IMPLANT_PATCH = `<Edit><Island name="${COMPONENT}">${SOURCE.replace(
  "return <strong>$1.2M</strong>;",
  "return <div><strong>$1.2M</strong><div>chart implanted into the fork</div></div>;",
)}</Island></Edit>`;

describe("remix invariant — an edit never lands inside a pinned fork", () => {
  it("lands additive-alongside content as a SIBLING, leaving the pin byte-identical and its ship-diff empty", async () => {
    const store = memoryStore();
    const app = forkedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store, { model: scriptedLanguageModel(SIBLING_PATCH) });

    const result = await runtime.edit(app.id, "add a spending chart below the forked net worth card", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.issues).toBeUndefined();
    expect(result.app.tree?.nodes.find(({ id }) => id === "root")?.children).toEqual([PIN_NODE, "spendchart-1"]);
    expect(result.app.components?.[COMPONENT]).toBe(SOURCE);
    expect(computeShipDiff(result.app, [baseline]).pins).toEqual([
      expect.objectContaining({ slot: SLOT, drifted: false, diff: "" }),
    ]);
  });

  it("rejects a patch that rewrites the pinned component without targeting it, leaving the document untouched", async () => {
    const store = memoryStore();
    const app = forkedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store, { model: scriptedLanguageModel(IMPLANT_PATCH) });

    const result = await runtime.edit(app.id, "add a spending chart next to the forked card", ctx);

    expect(result.failure).toBeDefined();
    expect(result.issues?.join("\n")).toContain(`changed pinned component "${COMPONENT}" without targeting it`);
    expect(result.app).toEqual(app);
    await expect(runtime.get(app.id, ctx)).resolves.toEqual(app);
  });

  it("feeds the rejection to the repair loop, which recovers with the sibling shape", async () => {
    const store = memoryStore();
    const app = forkedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store, {
      model: scriptedLanguageModel(
        IMPLANT_PATCH,
        (call) => {
          const prompt = promptText(call).replaceAll('\\"', '"');
          expect(prompt).toContain(`changed pinned component "${COMPONENT}" without targeting it`);
          return SIBLING_PATCH;
        },
      ),
    });

    const result = await runtime.edit(app.id, "add a spending chart next to the forked card", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.app.components?.[COMPONENT]).toBe(SOURCE);
    expect(result.app.components?.SpendChart).toContain("chart");
  });

  it("still edits the pin normally when the patch declares the target (the common path)", async () => {
    const store = memoryStore();
    const app = forkedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store, {
      model: scriptedLanguageModel(
        `<Edit><EditPin name="${COMPONENT}"/><Island name="${COMPONENT}">${SOURCE.replace("$1.2M", "$1.4M")}</Island></Edit>`,
      ),
    });

    const result = await runtime.edit(app.id, "increase the displayed net worth on my remixed card", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.issues).toBeUndefined();
    expect(result.app.components?.[COMPONENT]).toContain("$1.4M");
    const [pin] = computeShipDiff(result.app, [baseline]).pins;
    expect(pin?.diff).toContain("+");
    expect(pin?.diff).toContain("$1.4M");
  });

  it("rejects removing the pinned component, and an <EditPin> that names no pin", async () => {
    const store = memoryStore();
    const app = forkedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store, {
      model: scriptedLanguageModel(`<Edit><RemoveIsland name="${COMPONENT}"/><EditPin name="NotAPin"/></Edit>`),
    });

    const result = await runtime.edit(app.id, "get rid of the remix", ctx);

    expect(result.failure).toBeDefined();
    expect(result.issues?.join("\n")).toContain(`pinned component "${COMPONENT}" is the user's fork of a host component and cannot be removed`);
    expect(result.issues?.join("\n")).toContain('<EditPin name="NotAPin"/> does not name a pinned component');
    await expect(runtime.get(app.id, ctx)).resolves.toEqual(app);
  });
});
