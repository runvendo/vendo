/** Pre-train app rows on a HOST-SUPPLIED store adapter.
 *
 * The train renamed the app row's trigger-kind ref from one `trigger_kind:
 * "<kind>"` to one key per kind (`trigger_kind_<kind>: "1"`), because an app has
 * a LIST of triggers and a single-valued ref can only name one of them.
 *
 * The RESERVED `@vendoai/store` migrates itself: those refs come from generated
 * columns that read the document, so every existing row gained the new keys the
 * moment the column was added. A host-supplied durable `StoreAdapter` has no such
 * thing — 01-core §12 says a generic adapter stores the refs it is GIVEN — so its
 * pre-train rows still carry the old key and nothing rewrites them. The tick and
 * `emit` ask for the new key, match nothing, and every automation armed before
 * the train stops firing. Silently: no error, no run row, no audit event.
 *
 * These use an adapter that honors refs verbatim, which is the whole point: the
 * conformance memory store DERIVES app refs the way the reserved store does, so
 * it cannot show this at all.
 */
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type BlobStore,
  type Guard,
  type Principal,
  type RecordQuery,
  type RecordStore,
  type StoreAdapter,
  type ToolRegistry,
  type VendoRecord,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomations } from "./index.js";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const OWNER = "user_byo";
const principal: Principal = { kind: "user", subject: OWNER };

/**
 * A durable adapter of the kind a host brings: it stores exactly the refs it is
 * handed and matches them by equality. No generated columns, no derivation —
 * which is precisely why a rename that the reserved store absorbs for free is a
 * migration this one never performs.
 */
function verbatimRefsAdapter(): StoreAdapter {
  const collections = new Map<string, Map<string, VendoRecord>>();
  const clone = (record: VendoRecord): VendoRecord => ({
    ...record,
    data: structuredClone(record.data),
    refs: record.refs === undefined ? undefined : { ...record.refs },
  });
  const store = (collection: string): RecordStore => {
    let byId = collections.get(collection);
    if (byId === undefined) {
      byId = new Map();
      collections.set(collection, byId);
    }
    const rows = byId;
    return {
      async get(id) {
        const found = rows.get(id);
        return found === undefined ? null : clone(found);
      },
      async put(record) {
        const at = NOW.toISOString();
        const stored: VendoRecord = {
          id: record.id,
          data: structuredClone(record.data),
          refs: record.refs === undefined ? undefined : { ...record.refs },
          createdAt: rows.get(record.id)?.createdAt ?? at,
          updatedAt: at,
        };
        rows.set(stored.id, stored);
        return clone(stored);
      },
      async delete(id) {
        rows.delete(id);
      },
      async list(query: RecordQuery = {}) {
        const ids = query.ids === undefined ? undefined : new Set(query.ids);
        const records = [...rows.values()]
          .filter((record) => ids === undefined || ids.has(record.id))
          .filter((record) => Object.entries(query.refs ?? {})
            .every(([key, value]) => record.refs?.[key] === value))
          .map(clone);
        return { records };
      },
    };
  };
  return {
    async ensureSchema() {},
    records: store,
    blobs: () => ({}) as BlobStore,
  };
}

class GuardDouble implements Guard {
  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }
  async report(_event: AuditEvent): Promise<void> {}
  async directions(): Promise<string[]> { return []; }
  onApprovalDecision(_callback: (id: ApprovalId, approved: boolean) => void): () => void {
    return () => {};
  }
}

const tools: ToolRegistry = {
  async descriptors() {
    return [{ name: "host_sync", description: "Sync", inputSchema: { type: "object" }, risk: "read" }];
  },
  async execute() { return { status: "ok", output: {} }; },
};

const appsDouble = (): AppsRuntime => ({ call: async () => ({ status: "ok", output: {} }) }) as AppsRuntime;

const preTrainApp = (id: string, on: AppDocument["triggers"] extends undefined ? never : NonNullable<AppDocument["triggers"]>[number]["on"]): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: id,
  triggers: [{ id: "main", on, run: { kind: "steps", steps: [{ id: "sync", tool: "host_sync" }] } }],
});

/** The row as a pre-train deployment left it: ARMED (`enabled`, no per-trigger
 *  armed row, which is the pre-list arming shape) and carrying the ONE ref key
 *  the code wrote back then. */
async function seedPreTrainRow(store: StoreAdapter, doc: AppDocument, kind: string): Promise<void> {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: OWNER, enabled: true, doc },
    refs: { subject: OWNER, trigger_kind: kind },
  });
}

describe("pre-train app rows on a host-supplied adapter", () => {
  let store: StoreAdapter;

  beforeEach(() => {
    store = verbatimRefsAdapter();
  });

  const engine = () => createAutomations({
    apps: appsDouble(), tools, guard: new GuardDouble(), store, now: () => NOW,
  });

  it("still ticks a schedule automation armed before the ref rename", async () => {
    const doc = preTrainApp("app_byo_schedule", { kind: "schedule", every: "1h" });
    await seedPreTrainRow(store, doc, "schedule");
    const automations = engine();

    // The tick has to FIND the row before anything else can happen, and the proof
    // that it did is the schedule cursor it writes for it. A tick that never saw
    // the row writes nothing at all — which is exactly how this failed: silently.
    const first = await automations.tick(new Date(NOW.getTime() + 3 * 3_600_000));
    expect(await store.records("automations:schedule").get(`${doc.id}:main`)).not.toBeNull();
    // Nothing fires on the tick that discovers it: a schedule whose clock has just
    // been started is not yet due, which is deliberate and unrelated to the refs.
    expect(first).toEqual([]);

    // One interval later it fires, as an armed hourly automation must.
    const second = await automations.tick(new Date(NOW.getTime() + 5 * 3_600_000));
    expect(second).toHaveLength(1);
  });

  it("still emits to a host-event automation armed before the ref rename", async () => {
    await seedPreTrainRow(
      store,
      preTrainApp("app_byo_event", { kind: "host-event", event: "invoice.paid" }),
      "host-event",
    );

    const fired = await engine().emit("invoice.paid", { id: "inv_1" }, principal);

    expect(fired).toHaveLength(1);
  });

  it("rewrites the row onto the new ref keys once anything writes it, so the fallback ages out", async () => {
    const doc = preTrainApp("app_byo_rewrite", { kind: "schedule", every: "1h" });
    await seedPreTrainRow(store, doc, "schedule");

    // Any write through the engine re-derives the refs from the document.
    await engine().disable(doc.id, "main", {
      principal,
      venue: "chat",
      presence: "present",
      sessionId: "sess_byo",
      appId: doc.id,
    });

    const refs = (await store.records("vendo_apps").get(doc.id))?.refs;
    expect(refs).toMatchObject({ subject: OWNER, trigger_kind_schedule: "1" });
    expect(refs?.["trigger_kind"]).toBeUndefined();
  });
});
