/**
 * The honest-refusal law on the QUERY path (06-apps §1–2).
 *
 * "Data didn't load — that isn't your data being empty" shipped on 2026-08-03 as
 * a payload marker the renderer shows. It could only ever be set by the render
 * seam, and only when the whole app half THREW — which is the rare failure. The
 * common one is a query that answered: an error from the host, a `blocked` or
 * `connect-required` refusal from the guard. Those resolve to no data, every
 * binding under them renders "—", and the view told the person they have no
 * spending. `open()` — the path every stored app opens through — could not set
 * the marker at all.
 *
 * So: whoever RAN the queries and watched them fail says so, and nobody else can
 * (a document field is stripped, and a host venue hook cannot mint one either).
 * An empty result is NOT a failure — claiming it is would be the same lie in
 * reverse.
 */
import {
  compileWire,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { bindTools, guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

const APP_ID = "app_data_unavailable";

const ctx = (subject = "u1"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: "s1",
});

const descriptor: ToolDescriptor = {
  name: "maple_spend_summary",
  title: "Spending summary",
  description: "This month's spending",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
};

const WIRE = `<App name="Spending">
  <Query id="spend" tool="maple_spend_summary" />
  <Stack>
    <Text text={spend.total} />
  </Stack>
</App>`;

const treeApp = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: APP_ID,
  name: "Spending",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
    queries: [{ name: "spend", tool: "maple_spend_summary" }],
  } as unknown as NonNullable<AppDocument["tree"]>,
});

const stand = (options: {
  outcome?: ToolOutcome;
  rules?: Record<string, "run" | "ask" | "block">;
  venueState?: () => Record<string, unknown>;
} = {}) => {
  const store = memoryStore();
  const guard = guardFixture(options.rules === undefined ? {} : { rules: options.rules });
  const host: ToolRegistry = {
    async descriptors() { return [descriptor]; },
    async execute() {
      return options.outcome ?? { status: "ok", output: { total: 4210, currency: "USD" } };
    },
  };
  const runtime = createApps({
    store,
    guard,
    tools: bindTools(guard, host),
    catalog: [],
    ...(options.venueState === undefined ? {} : { venueState: async () => options.venueState?.() }),
  });
  return { runtime, store };
};

/** The marker as the renderer reads it: a top-level payload field. */
const markerOf = async (
  runtime: ReturnType<typeof stand>["runtime"],
): Promise<unknown> => {
  const surface = await runtime.open(APP_ID, ctx());
  if (surface.kind !== "tree") throw new Error(`expected a tree surface, got ${surface.kind}`);
  return (surface.payload as { dataUnavailable?: unknown }).dataUnavailable;
};

describe("open() on an app whose query did not resolve", () => {
  it("says the data did not load when the query ERRORED", async () => {
    const { runtime, store } = stand({
      outcome: { status: "error", error: { code: "upstream", message: "the bank is down" } },
    });
    await seedAppRow(store, treeApp(), "u1");

    // Without this the payload is a perfectly healthy-looking tree with `data: {}`
    // and every value bound to `spend` rendering "—": the app full of dashes.
    expect(await markerOf(runtime)).toBe(true);
  });

  it("says it for a guard REFUSAL too — the person's data did not arrive either", async () => {
    // `blocked` and `pending-approval` are refusals the person may be able to act
    // on, and an actionable affordance for them (connect the account, approve the
    // call) belongs in the surface. But the sentence this marker carries is TRUE
    // in every one of them, and the alternative is the empty-state lie: so they
    // all count, and the affordance is renderer work on top, not instead.
    for (const rules of [{ maple_spend_summary: "block" as const }, { maple_spend_summary: "ask" as const }]) {
      const { runtime, store } = stand({ rules });
      await seedAppRow(store, treeApp(), "u1");
      expect(await markerOf(runtime)).toBe(true);
    }
  });

  it("says it when a connector needs connecting", async () => {
    const { runtime, store } = stand({
      outcome: {
        status: "connect-required",
        connect: { connector: "maple", toolkit: "maple", message: "connect your account" },
      },
    });
    await seedAppRow(store, treeApp(), "u1");

    expect(await markerOf(runtime)).toBe(true);
  });

  it("says NOTHING when the queries answered — an empty answer is empty data", async () => {
    for (const output of [{ total: 4210 }, {}]) {
      const { runtime, store } = stand({ outcome: { status: "ok", output } });
      await seedAppRow(store, treeApp(), "u1");
      expect(await markerOf(runtime)).toBeUndefined();
    }
  });

  it("says nothing for an app with no queries at all", async () => {
    const { runtime, store } = stand();
    const app = treeApp();
    delete (app.tree as unknown as { queries?: unknown }).queries;
    await seedAppRow(store, app, "u1");

    expect(await markerOf(runtime)).toBeUndefined();
  });

  it("ignores a stored document's own claim — only the code that ran the queries may make it", async () => {
    const { runtime, store } = stand();
    const app = treeApp();
    (app.tree as unknown as { dataUnavailable: boolean }).dataUnavailable = true;
    await seedAppRow(store, app, "u1");

    // The queries resolved, so the tree's forged claim is stripped like a forged
    // `inClient` or `pinDrift` (stripServerAuthoritativeFields).
    expect(await markerOf(runtime)).toBeUndefined();
  });

  it("refuses a host venue hook that would claim it over healthy data", async () => {
    // §9.9's additive slot spreads its keys onto the payload. `dataUnavailable`
    // is reserved for the same reason `inClient`, `data` and `pinDrift` are: the
    // hook did not run these queries, so it cannot tell the person their data is
    // missing while it sits on the screen in front of them.
    const { runtime, store } = stand({
      venueState: () => ({ dataUnavailable: true, adoption: { automation: "nightly digest" } }),
    });
    await seedAppRow(store, treeApp(), "u1");

    const surface = await runtime.open(APP_ID, ctx());
    if (surface.kind !== "tree") throw new Error("expected a tree surface");
    const payload = surface.payload as Record<string, unknown>;
    expect(payload["dataUnavailable"]).toBeUndefined();
    expect(payload["data"]).toEqual({ spend: { total: 4210, currency: "USD" } });
    // The rest of the hook's state still rides along: this is one reserved key,
    // not a closed door.
    expect(payload["adoption"]).toEqual({ automation: "nightly digest" });
  });
});

describe("authored() — the same answer for a files-first save", () => {
  it("tells the render seam its queries failed, so the painted view says so", async () => {
    const { runtime } = stand({
      outcome: { status: "error", error: { code: "upstream", message: "the bank is down" } },
    });

    // The seam paints what this returns. Before the marker, a failed query and a
    // genuinely empty account produced the identical answer here — which is how
    // the "app full of —" bug survived its own fix on this path.
    await expect(runtime.authored({ appId: APP_ID, compiled: compileWire(WIRE) }, ctx()))
      .resolves.toEqual({ data: {}, dataUnavailable: true });
  });

  it("says nothing when they answered", async () => {
    const { runtime } = stand();

    await expect(runtime.authored({ appId: APP_ID, compiled: compileWire(WIRE) }, ctx()))
      .resolves.toEqual({ data: { spend: { total: 4210, currency: "USD" } } });
  });
});
