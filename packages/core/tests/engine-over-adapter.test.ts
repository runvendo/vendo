import { describe, expect, it } from "vitest";
import { engineOverAdapter } from "../src/engine-over-adapter.js";
import type { VendoError } from "../src/errors.js";
import type {
  BlobStore,
  RecordInput,
  RecordQuery,
  RecordStore,
  StoreAdapter,
  VendoRecord,
} from "../src/store.js";

/** Both on the engine allowlist (engine-collections.ts), so the gate lets them
 *  through and the tests below are about the door, not the allowlist. */
const AUDIT = "vendo_audit";
const EFFECTS = "vendo_effects";

/** `claim` and `atomic` are OPTIONAL on RecordStore (02-store §4). Which of them
 *  a BYO adapter actually implements is the whole subject of this file, so the
 *  fake takes them as capabilities rather than always offering both. */
type Caps = { claim: boolean; atomic: boolean };

type Fake = {
  store: StoreAdapter;
  /** How many times `records()` has been asked for a handle. */
  doorCount: () => number;
};

function fakeAdapter(caps: Caps): Fake {
  const tables = new Map<string, Map<string, VendoRecord>>();
  let doors = 0;
  let seq = 0;

  const tableFor = (collection: string): Map<string, VendoRecord> => {
    const found = tables.get(collection);
    if (found !== undefined) return found;
    const fresh = new Map<string, VendoRecord>();
    tables.set(collection, fresh);
    return fresh;
  };

  /** A revision is handed out only when this door claims `atomic`, mirroring
   *  VendoRecord.revision's contract ("present when the store exposes atomic"). */
  const write = (rows: Map<string, VendoRecord>, input: RecordInput): VendoRecord => {
    const now = "2026-08-10T00:00:00.000Z";
    const previous = rows.get(input.id);
    seq += 1;
    const record: VendoRecord = {
      id: input.id,
      data: input.data,
      ...(input.refs === undefined ? {} : { refs: input.refs }),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(caps.atomic ? { revision: `r${seq}` } : {}),
    };
    rows.set(input.id, record);
    return record;
  };

  const records = (collection: string): RecordStore => {
    doors += 1;
    const rows = tableFor(collection);
    const door: RecordStore = {
      get: async (id) => rows.get(id) ?? null,
      put: async (input) => write(rows, input),
      delete: async (id) => {
        rows.delete(id);
      },
      list: async (query?: RecordQuery) => ({
        records: [...rows.values()].filter(
          (row) => query?.ids === undefined || query.ids.includes(row.id),
        ),
      }),
    };
    if (caps.claim) {
      door.claim = async (expected) => rows.has(expected.id);
    }
    if (caps.atomic) {
      door.atomic = {
        insertIfAbsent: async (input) => (rows.has(input.id) ? null : write(rows, input)),
        compareAndSwap: async (input, expectedRevision) =>
          rows.get(input.id)?.revision === expectedRevision ? write(rows, input) : null,
      };
    }
    return door;
  };

  return {
    store: {
      records,
      blobs: (): BlobStore => {
        throw new Error("the engine family never reaches for blobs");
      },
      ensureSchema: async () => undefined,
    },
    doorCount: () => doors,
  };
}

const caught = async (run: Promise<unknown>): Promise<VendoError> =>
  await run.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as VendoError,
  );

describe("engineOverAdapter — the engine family over a bare StoreAdapter", () => {
  it("carries the seven verbs through to the adapter's own record door", async () => {
    const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);

    const put = await engine.put(AUDIT, { id: "a1", data: { n: 1 }, refs: { app: "app_1" } });
    expect(put).toMatchObject({ id: "a1", data: { n: 1 }, refs: { app: "app_1" } });
    expect(await engine.get(AUDIT, "a1")).toMatchObject({ id: "a1", data: { n: 1 } });
    expect(await engine.get(AUDIT, "absent")).toBeNull();

    const listed = await engine.list(AUDIT);
    expect(listed.records.map((row) => row.id)).toEqual(["a1"]);
    expect((await engine.list(AUDIT, { ids: ["absent"] })).records).toEqual([]);

    expect(await engine.claim(AUDIT, { id: "a1", data: { n: 1 } })).toBe(true);

    await engine.delete(AUDIT, "a1");
    expect(await engine.get(AUDIT, "a1")).toBeNull();
  });

  it("gates the collection name on every verb, refusing with `blocked`", async () => {
    const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);
    // App data belongs to the appData family; the allowlist is what says so.
    const refusal = await caught(engine.put("host_invoices", { id: "inv_1", data: {} }));
    expect(refusal.code).toBe("blocked");
    expect(refusal.message).toContain("host_invoices");
  });

  it("asks for a fresh handle per verb and never caches one", async () => {
    // Fixtures wrap `records()` to inject a failure on a chosen call, so a
    // cached handle would quietly make those fixtures unreachable.
    const fake = fakeAdapter({ claim: true, atomic: true });
    const engine = engineOverAdapter(fake.store);
    await engine.put(AUDIT, { id: "a1", data: {} });
    await engine.get(AUDIT, "a1");
    await engine.list(AUDIT);
    expect(fake.doorCount()).toBe(3);
  });

  it("refuses claim with `not-implemented` on a door that does not offer it", async () => {
    const engine = engineOverAdapter(fakeAdapter({ claim: false, atomic: true }).store);
    const refusal = await caught(engine.claim(AUDIT, { id: "a1", data: {} }));
    expect(refusal.code).toBe("not-implemented");
    expect(refusal.message).toContain(AUDIT);
  });

  describe("a door WITH the atomic capability gets the real thing", () => {
    it("insertIfAbsent lets the first writer win and answers null to the second", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 1 } }))
        .toMatchObject({ id: "e1", data: { v: 1 } });
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 2 } })).toBeNull();
    });

    it("compareAndSwap honors the revision token and rejects a stale one", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);
      const created = await engine.put(EFFECTS, { id: "e1", data: { v: 1 } });
      expect(created.revision).toBeDefined();
      const revision = created.revision ?? "";

      expect(await engine.compareAndSwap(EFFECTS, { id: "e1", data: { v: 2 } }, revision))
        .toMatchObject({ data: { v: 2 } });
      // The token has moved on, so the same revision no longer matches.
      expect(await engine.compareAndSwap(EFFECTS, { id: "e1", data: { v: 3 } }, revision)).toBeNull();
    });
  });

  describe("a door WITHOUT it degrades instead of failing closed", () => {
    // The documented promise (engine-over-adapter.ts:36-56): moving a block onto
    // this family must not turn a working BYO adapter into a `not-implemented`.
    it("insertIfAbsent becomes check-then-put, keeping the first write", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: false }).store);
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 1 } }))
        .toMatchObject({ id: "e1", data: { v: 1 } });
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 2 } })).toBeNull();
      expect(await engine.get(EFFECTS, "e1")).toMatchObject({ data: { v: 1 } });
    });

    it("compareAndSwap becomes last-write-wins, because the token means nothing", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: false }).store);
      const created = await engine.put(EFFECTS, { id: "e1", data: { v: 1 } });
      // A door with no atomic hands out no revision, so no caller can hold one.
      expect(created.revision).toBeUndefined();
      expect(await engine.compareAndSwap(EFFECTS, { id: "e1", data: { v: 2 } }, "unenforceable"))
        .toMatchObject({ data: { v: 2 } });
      expect(await engine.get(EFFECTS, "e1")).toMatchObject({ data: { v: 2 } });
    });
  });
});
