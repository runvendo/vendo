import type { AuditEvent } from "../audit.js";
import { ENGINE_ALLOWLIST_VERSION, engineAppHistory } from "../engine-collections.js";
import type { VendoErrorCode } from "../errors.js";
import { isoDateTimeSchema, type IsoDateTime } from "../ids.js";
import { STORE_WIRE_APPEND_MESSAGES_OPS, STORE_WIRE_PATHS, VENDO_STORE_WIRE_FORMAT } from "../store-wire.js";
import type { AuditQuery, CollectionFootprint, StoreOps } from "../store.js";
import { assert, assertBytesEqual, assertDeepEqual } from "./assertions.js";
import type { ConformanceCase, ConformanceSuite } from "./index.js";

/** Refusals are checked by VendoError CODE, not by message text: "threw" is not
    "refused for the right reason". Duck-typed rather than `instanceof`, because
    a remote backend rebuilds the error from the wire envelope. */
const assertThrowsCode = async (
  body: () => Promise<unknown>,
  code: VendoErrorCode,
  message: string,
): Promise<void> => {
  try {
    await body();
  } catch (error) {
    const actual = (error as { code?: unknown }).code;
    assert(actual === code, `${message} should throw ${code}, got ${String(actual)}: ${String(error)}`);
    return;
  }
  throw new Error(`${message} did not throw`);
};

/** The page size every pagination case walks with. */
const PAGE = 2;

/** Walks a list op page by page and proves the walk is lossless: no page
    exceeds the requested limit, nothing repeats, no cursor repeats, and the
    union is exactly the seeded set. */
const assertPaginates = async (
  label: string,
  expected: string[],
  fetchPage: (cursor?: string) => Promise<{ ids: string[]; cursor?: string }>,
): Promise<void> => {
  const seen: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < expected.length + 1; page += 1) {
    const next = await fetchPage(cursor);
    assert(next.ids.length <= PAGE, `${label}: page exceeded its requested limit`);
    for (const id of next.ids) {
      assert(!seen.includes(id), `${label}: ${id} appeared on more than one page`);
      seen.push(id);
    }
    if (next.cursor === undefined) break;
    assert(!cursors.has(next.cursor), `${label}: pagination cursor repeated before completion`);
    cursors.add(next.cursor);
    cursor = next.cursor;
  }
  assertDeepEqual([...seen].sort(), [...expected].sort(), `${label}: pagination omitted or added entries`);
};

/** Reads one string field off an opaque list entry. `workspace.index` and
    `workspace.history` type their entries as `unknown`, but a caller has no
    other way to learn a path or a commit id, so the field is contract, not
    shape guessing. */
const stringField = (entry: unknown, field: string, message: string): string => {
  const value = (entry as Record<string, unknown> | null)?.[field];
  assert(typeof value === "string", `${message}: entry ${JSON.stringify(entry)} has no string "${field}"`);
  return value;
};

/** The numeric twin of {@link stringField} — `workspace.index` entries carry
    the revision a strict commit compare-and-swaps against, so the field is
    contract the same way `commitId` is. */
const numberField = (entry: unknown, field: string, message: string): number => {
  const value = (entry as Record<string, unknown> | null)?.[field];
  assert(typeof value === "number", `${message}: entry ${JSON.stringify(entry)} has no number "${field}"`);
  return value;
};

/** A thread's harness state rides the harness slot under this synthetic appId
    (the store's `harnessStateKey`), which is what makes deleteThread's cascade
    onto harness state observable through the 35 ops. */
const harnessSlot = (threadId: string): string => `harness_state:${threadId}`;

/** A shape-valid AuditEvent. `vendo_audit` is a TYPED door — the real backend
    parses every row with `auditEventSchema` and refuses what does not fit — so
    the audit cases seed real events rather than convenient stubs. `minute` is
    the event's own `at`, which is the column both doors over this drawer order
    on. */
const auditEvent = (id: string, minute: number, fields: Partial<AuditEvent>): AuditEvent => ({
  id,
  at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() as IsoDateTime,
  kind: "tool-call",
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  ...fields,
});

/** Seeds the audit drawer through the engine door, in ascending `at` order —
    which is what makes "newest first" one list rather than two. */
const seedAudit = async (ops: StoreOps, events: AuditEvent[]): Promise<void> => {
  for (const event of events) await ops.engine.put("vendo_audit", { id: event.id, data: event });
};

/** appData rows live in the app's own drawer, and the local backend fails an
    app-scoped write closed when the app has no row — so every appData case
    seeds one first, with the shape the typed `vendo_apps` door accepts. */
const seedApp = async (ops: StoreOps, appId: string): Promise<void> => {
  await ops.engine.put("vendo_apps", {
    id: appId,
    data: {
      subject: "user_1",
      enabled: true,
      doc: { format: "vendo/app@1", id: appId, name: appId },
    },
    refs: { subject: "user_1" },
  });
};

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

export interface StoreOpsConformanceOptions {
  makeOps(): Promise<{ ops: StoreOps; close?(): Promise<void> }>;
}

const opsCase = (
  opts: StoreOpsConformanceOptions,
  name: string,
  body: (ops: StoreOps) => Promise<void>,
): ConformanceCase => ({
  name,
  async run() {
    const made = await opts.makeOps();
    try {
      await body(made.ops);
    } finally {
      await made.close?.();
    }
  },
});

export function storeOpsConformance(opts: StoreOpsConformanceOptions): ConformanceSuite {
  return {
    seam: "StoreOps",
    cases: [
      // =====================================================================
      // engine
      // =====================================================================

      /** Store wire v1: every list op defaults to 100 per page and caps at
          1000. Pinned on `engine.list` — the generic records family that used
          to carry this case is gone, and the rule is the WIRE's, not the
          StoreAdapter's, so it stays in this suite. */
      opsCase(opts, "engine.list defaults to 100 per page and refuses or clamps a limit above 1000", async (ops) => {
        const collection = engineAppHistory("conf_cap");
        const ids = Array.from({ length: 101 }, (_, i) => `cap_${String(i).padStart(3, "0")}`);
        for (const id of ids) await ops.engine.put(collection, { id, data: { id } });
        const defaulted = await ops.engine.list(collection);
        assert(defaulted.records.length === 100, `the default page should hold 100 records, got ${defaulted.records.length}`);
        assert(defaulted.cursor !== undefined, "a truncated default page must return a cursor");
        const overMax = await ops.engine.list(collection, { limit: 5000 }).catch((error: unknown) => {
          assert((error as { code?: unknown }).code === "validation", `a limit above the 1000 max must be refused as validation, got ${String(error)}`);
          return null;
        });
        if (overMax !== null) assert(overMax.records.length <= 1000, "an accepted over-max limit was not clamped to 1000");
      }),

      /** Store wire v1: a cursor is only followable if an identical query comes
          back in an identical order. Same reason as the case above for living
          on `engine.list`. */
      opsCase(opts, "engine.list repeats an identical query in the same order", async (ops) => {
        const collection = engineAppHistory("conf_det");
        for (const id of ["da", "db", "dc", "dd"]) await ops.engine.put(collection, { id, data: { id } });
        const first = await ops.engine.list(collection);
        const repeat = await ops.engine.list(collection);
        assertDeepEqual(repeat.records.map((r) => r.id), first.records.map((r) => r.id), "identical list calls returned different orders");
        const firstPage = await ops.engine.list(collection, { limit: PAGE });
        const repeatPage = await ops.engine.list(collection, { limit: PAGE });
        assertDeepEqual(repeatPage.records.map((r) => r.id), firstPage.records.map((r) => r.id), "identical first pages returned different records");
        assert(repeatPage.cursor === firstPage.cursor, "identical first pages returned different cursors");
      }),

      /** Store wire v1: keyset pagination over `engine.list` walks the whole
          set exactly once. */
      opsCase(opts, "engine.list limit and cursor paginate without loss or duplicates", async (ops) => {
        const collection = engineAppHistory("conf_pg");
        const expected = ["pa", "pb", "pc", "pd", "pe"];
        for (const id of expected) await ops.engine.put(collection, { id, data: { id } });
        await assertPaginates("engine.list", expected, async (cursor) => {
          const page = await ops.engine.list(collection, { limit: PAGE, cursor });
          return { ids: page.records.map((r) => r.id), cursor: page.cursor };
        });
      }),

      /** The forward walk — the one read a newest-first page cannot serve. A
          meter that has already counted runs up to some instant asks for
          everything after it and advances its mark as it goes, so a bound that
          loses precision on the round trip moves BACKWARDS and the meter
          re-counts a window it has already billed; one that moves too far skips
          rows nobody ever counts. Both are silent, which is why the walk is
          asserted lossless rather than merely non-empty.
          Nothing here reads the watermark STRING: it is contractually opaque,
          and the two shipped engines spell it differently (a Postgres-native
          text form, an ISO instant). */
      opsCase(opts, "engine.list walks forward from a watermark, oldest first, visiting every row exactly once", async (ops) => {
        // vendo_runs is a typed door — appId, trigger, status, record and
        // startedAt, or the real backend refuses the row. `startedAt` ascends
        // with write order, so "oldest first" is one answer for an engine that
        // orders on the indexed column and one that orders on arrival.
        const ids = ["run_w1", "run_w2", "run_w3", "run_w4", "run_w5"];
        for (const [index, id] of ids.entries()) {
          await ops.engine.put("vendo_runs", {
            id,
            data: {
              appId: "app_meter",
              trigger: { kind: "schedule" },
              status: "ok",
              record: { index },
              startedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
            },
          });
        }

        let after = new Date(0).toISOString(); // the mark a meter that has counted nothing holds
        const seen: string[] = [];
        for (let page = 0; page < ids.length + 2; page += 1) {
          const answer = await ops.engine.list("vendo_runs", { limit: PAGE, watermark: { field: "started_at", after } });
          const echoed = answer.watermark;
          assert(answer.records.length <= PAGE, `a watermark page held ${answer.records.length} rows past its limit of ${PAGE}`);
          // The echo is the ONLY thing that tells a caller its bound was
          // understood: a mount older than the bound parses the query, ignores
          // it, and answers with an ordinary newest-first page instead.
          assert(echoed !== undefined, "a page that was given a watermark bound must echo the next bound back");
          for (const record of answer.records) {
            assert(!seen.includes(record.id), `${record.id} was visited twice by the forward walk`);
            seen.push(record.id);
          }
          if (answer.records.length === 0) {
            assert(echoed === after, "an empty page must echo the requested bound back unchanged");
            break;
          }
          after = echoed;
        }
        assertDeepEqual(seen, ids, "the forward walk did not visit every row exactly once, oldest first");
      }),

      /** The tie the walk has to survive. `vendo_runs.started_at` is
          CALLER-SUPPLIED, and callers write `new Date().toISOString()` — one
          millisecond of resolution — so a burst of runs routinely shares one
          value. A bound that is nothing but that value cannot say where INSIDE
          such a group a page stopped: the next call asks for everything
          strictly after the instant, and whatever was left of the group is
          skipped, silently and permanently. For the meter this walk exists for
          that is usage nobody ever bills. The group is seeded larger than the
          page deliberately, so a page boundary MUST land inside it. */
      opsCase(opts, "engine.list's forward walk crosses a page boundary inside rows sharing one indexed value", async (ops) => {
        const tied = "2026-03-04T05:06:07.000Z"; // one millisecond, five runs
        const ids = ["run_t1", "run_t2", "run_t3", "run_t4", "run_t5"];
        for (const id of ids) {
          await ops.engine.put("vendo_runs", {
            id,
            data: { appId: "app_meter", trigger: { kind: "schedule" }, status: "ok", record: {}, startedAt: tied },
          });
        }
        // A meter's FIRST bound is a plain field value it authored; every later
        // one is the page's own echo, sent back verbatim and never read.
        await assertPaginates("engine.list watermark", ids, async (after) => {
          const page = await ops.engine.list("vendo_runs", {
            limit: PAGE,
            watermark: { field: "started_at", after: after ?? new Date(0).toISOString() },
          });
          assert(page.watermark !== undefined, "a page that was given a watermark bound must echo the next bound back");
          // The echo never falls away — its absence means the mount ignored the
          // bound — so it is the empty page, not a missing echo, that ends the
          // walk.
          return {
            ids: page.records.map((record) => record.id),
            ...(page.records.length === 0 ? {} : { cursor: page.watermark }),
          };
        });
      }),

      /** Two refusals, both of them cliffs a caller would otherwise fall off
          quietly: an unindexed bound is a full table scan wearing a filter's
          clothes, and a cursor beside a watermark is two walks in opposite
          directions with no single answer to give. Refused, rather than served
          slowly or resolved by a precedence rule nobody could guess. */
      opsCase(opts, "engine.list refuses a watermark on an unindexed field, and one sent beside a cursor", async (ops) => {
        const after = new Date(0).toISOString();
        await assertThrowsCode(
          () => ops.engine.list("vendo_audit", { watermark: { field: "at", after } }),
          "validation",
          "a watermark on a field vendo_audit does not declare indexed",
        );
        await assertThrowsCode(
          () => ops.engine.list("vendo_runs", { cursor: "0", watermark: { field: "started_at", after } }),
          "validation",
          "a call carrying both a cursor and a watermark",
        );
      }),

      opsCase(opts, "engine round-trips a record on an engine collection", async (ops) => {
        const put = await ops.engine.put("vendo_workspace_commits", { id: "wc_1", data: { v: 1 }, refs: { subject: "user_1" } });
        isoDateTimeSchema.parse(put.createdAt);
        isoDateTimeSchema.parse(put.updatedAt);
        const got = await ops.engine.get("vendo_workspace_commits", "wc_1");
        assertDeepEqual(got, put, "engine.get did not round-trip the stored record");
        const listed = await ops.engine.list("vendo_workspace_commits", { ids: ["wc_1"] });
        assertDeepEqual(listed.records.map((r) => r.id), ["wc_1"], "engine.list did not find the record it just stored");
        await ops.engine.delete("vendo_workspace_commits", "wc_1");
        assert(await ops.engine.get("vendo_workspace_commits", "wc_1") === null, "the deleted record remained readable");
      }),

      /** The deliveries dedupe the ingestion surface depends on
          (packages/automations/src/ingestion-surface.ts): a redelivered webhook
          must lose, and lose without touching what the first one recorded. */
      opsCase(opts, "engine.insertIfAbsent returns record on first call, null on second", async (ops) => {
        const first = await ops.engine.insertIfAbsent("automations:deliveries", { id: "dlv_1", data: { n: 1 } });
        assert(first !== null, "engine.insertIfAbsent first call should return a record");
        assert(first!.id === "dlv_1", "engine.insertIfAbsent did not echo id");
        const second = await ops.engine.insertIfAbsent("automations:deliveries", { id: "dlv_1", data: { n: 2 } });
        assert(second === null, "engine.insertIfAbsent second call should return null");
        const got = await ops.engine.get("automations:deliveries", "dlv_1");
        assertDeepEqual(got?.data, { n: 1 }, "engine.insertIfAbsent overwrote the recorded delivery");
      }),

      /** The schedule cursor claim: a runner holding a revision the schedule has
          moved past may not write its stale cursor back over the live one. */
      opsCase(opts, "engine.compareAndSwap succeeds on matching revision, null on stale", async (ops) => {
        const created = await ops.engine.put("automations:schedule", { id: "sch_1", data: { cursor: 1 } });
        assert(created.revision, "engine.put must return a revision for CAS");
        const swapped = await ops.engine.compareAndSwap("automations:schedule", { id: "sch_1", data: { cursor: 2 } }, created.revision!);
        assert(swapped !== null, "engine.compareAndSwap should succeed on matching revision");
        assertDeepEqual(swapped!.data, { cursor: 2 }, "engine.compareAndSwap did not update data");
        const stale = await ops.engine.compareAndSwap("automations:schedule", { id: "sch_1", data: { cursor: 3 } }, created.revision!);
        assert(stale === null, "engine.compareAndSwap should return null on stale revision");
      }),

      /** Sequential, not concurrent: two callers read the same slot and both try
          to take it, and the loser must be told the row moved on rather than
          stamping its own claim over the winner's. */
      opsCase(opts, "engine.claim lets exactly one of two callers win", async (ops) => {
        await ops.engine.put("vendo_placement_slots", { id: "slot_1", data: { holder: null }, refs: { o: "a" } });
        const expected = { id: "slot_1", data: { holder: null }, refs: { o: "a" } };
        const first = await ops.engine.claim("vendo_placement_slots", expected, { data: { holder: "run_1" }, refs: { o: "a" } });
        assert(first === true, "the first claim on a matching row should win");
        const second = await ops.engine.claim("vendo_placement_slots", expected, { data: { holder: "run_2" }, refs: { o: "a" } });
        assert(second === false, "the second claim on the same stale expectation should lose");
        const after = await ops.engine.get("vendo_placement_slots", "slot_1");
        assertDeepEqual(after?.data, { holder: "run_1" }, "the winner's replacement did not land");
      }),

      opsCase(opts, "engine refuses a collection outside the allowlist on every verb", async (ops) => {
        await assertThrowsCode(
          () => ops.engine.put("host_invoices", { id: "inv_1", data: { total: 1 } }),
          "blocked",
          "a non-engine collection on engine.put",
        );
        // A read verb too: the gate is on every verb, not just the writes.
        await assertThrowsCode(
          () => ops.engine.get("host_invoices", "inv_1"),
          "blocked",
          "a non-engine collection on engine.get",
        );

        // "blocked" with no explanation reads as a bug in Vendo, so the refusal
        // must name the allowlist version it judged against and the door the
        // caller actually wanted.
        const refusal = await ops.engine.get("host_invoices", "inv_1").then(() => null, (error: unknown) => error);
        const message = String((refusal as { message?: unknown } | null)?.message ?? refusal);
        assert(message.includes(`v${ENGINE_ALLOWLIST_VERSION}`), `the refusal should name the allowlist version, got ${message}`);
        assert(message.includes("appData"), `the refusal should point at the appData family, got ${message}`);

        // A gate that throws after writing is not a gate. The probe is an
        // app-scoped name — outside the allowlist exactly like `host_invoices`,
        // but reachable through the ONE surviving door onto those rows, so the
        // refused write can be looked for instead of assumed away.
        await seedApp(ops, "app_gate");
        await assertThrowsCode(
          () => ops.engine.put("app:app_gate:invoices", { id: "inv_1", data: { total: 1 } }),
          "blocked",
          "an app-scoped collection on engine.put",
        );
        assert(
          await ops.appData.get({ appId: "app_gate", collection: "invoices", owner: "user_1" }, "inv_1") === null,
          "the refused put wrote its row anyway",
        );
      }),

      /** `engine` is a NEW door onto the same routed doors the local backend
          already had, so it inherits their per-collection law. A door that
          quietly bypassed it would make the audit log deletable and the effect
          ledger re-writable — the two things neither is allowed to be. */
      opsCase(opts, "engine does not bypass the routed doors' append-only and insert-once policy", async (ops) => {
        // Shape-valid rows: both collections are TYPED doors in the real
        // backend, which refuses malformed data as `validation` long before
        // policy is reached.
        const audit = {
          id: "aud_engine_policy",
          at: new Date().toISOString(),
          kind: "tool-call",
          principal: { kind: "user", subject: "user_1" },
          venue: "chat",
          presence: "present",
        };
        await ops.engine.put("vendo_audit", { id: audit.id, data: audit });
        await assertThrowsCode(
          () => ops.engine.delete("vendo_audit", audit.id),
          "blocked",
          "deleting an audit event through the engine door",
        );
        assert(await ops.engine.get("vendo_audit", audit.id) !== null, "the refused delete erased the audit event anyway");

        const first = await ops.engine.put("vendo_effects", { id: "eff_engine_policy", data: { subject: "user_1", outcome: { sent: 1 } } });
        assertDeepEqual((first.data as Record<string, unknown>)["outcome"], { sent: 1 }, "the first receipt did not record its outcome");
        const second = await ops.engine.put("vendo_effects", { id: "eff_engine_policy", data: { subject: "user_1", outcome: { sent: 2 } } });
        assertDeepEqual(
          (second.data as Record<string, unknown>)["outcome"],
          { sent: 1 },
          "the second put overwrote a receipt instead of returning the recorded one",
        );
        const held = await ops.engine.get("vendo_effects", "eff_engine_policy");
        assertDeepEqual(
          (held?.data as Record<string, unknown> | undefined)?.["outcome"],
          { sent: 1 },
          "the effect ledger kept the second outcome",
        );
      }),

      /** There is exactly ONE dynamic engine collection and ONE builder for it.
          Pin intents are rows INSIDE the app-history collection, not a second
          drawer — a second pattern is how an allowlist rots into a wildcard. */
      opsCase(opts, "engine accepts the one dynamic app-history pattern and refuses an illegal app id", async (ops) => {
        const collection = engineAppHistory("app_x");
        const put = await ops.engine.put(collection, { id: "ver_1", data: { version: 1 } });
        const got = await ops.engine.get(collection, "ver_1");
        assertDeepEqual(got, put, "the composed app-history collection did not round-trip");

        await assertThrowsCode(
          async () => engineAppHistory(""),
          "validation",
          "an empty app id handed to the app-history builder",
        );
      }),

      // =====================================================================
      // blobs
      // =====================================================================

      opsCase(opts, "blobs.put and get round-trip bytes and contentType", async (ops) => {
        const bytes = new Uint8Array([0, 1, 2, 127, 255]);
        await ops.blobs.put("conf_brt", "file.bin", bytes, { contentType: "application/octet-stream" });
        const result = await ops.blobs.get("conf_brt", "file.bin");
        assert(result !== null, "stored blob returned null");
        assertBytesEqual(result!.bytes, bytes, "blob bytes did not round-trip");
        assert(result!.contentType === "application/octet-stream", "blob contentType did not round-trip");
      }),

      opsCase(opts, "blobs.get missing returns null", async (ops) => {
        assert(await ops.blobs.get("conf_bmiss", "absent") === null, "missing blob did not return null");
      }),

      opsCase(opts, "blobs.delete removes a blob", async (ops) => {
        await ops.blobs.put("conf_bdel", "del.bin", new Uint8Array([1]));
        await ops.blobs.delete("conf_bdel", "del.bin");
        assert(await ops.blobs.get("conf_bdel", "del.bin") === null, "deleted blob remained readable");
      }),

      opsCase(opts, "blobs.list filters by prefix", async (ops) => {
        await ops.blobs.put("conf_blist", "images/a.png", new Uint8Array([1]));
        await ops.blobs.put("conf_blist", "images/b.png", new Uint8Array([2]));
        await ops.blobs.put("conf_blist", "docs/a.txt", new Uint8Array([3]));
        assertDeepEqual(
          (await ops.blobs.list("conf_blist", "images/")).sort(),
          ["images/a.png", "images/b.png"],
          "blob prefix list returned the wrong keys",
        );
      }),

      // =====================================================================
      // appData
      // =====================================================================

      opsCase(opts, "appData.put stamps the target owner as refs.subject", async (ops) => {
        await seedApp(ops, "app_stamp");
        const target = { appId: "app_stamp", collection: "notes", owner: "own_a" };
        const put = await ops.appData.put(target, { id: "n1", data: { text: "hi" } });
        assert(
          put.refs?.["subject"] === "own_a",
          `put should stamp the owner as refs.subject, got ${String(put.refs?.["subject"])}`,
        );
        const got = await ops.appData.get(target, "n1");
        assert(got?.refs?.["subject"] === "own_a", "the stamped record did not read back for its owner");
      }),

      /** Generated code has no field for the owner, so a `refs.subject` in the
          record is a caller trying to write as someone else. Refused, never
          silently overwritten with the real owner. */
      opsCase(opts, "appData.put refuses a caller-supplied refs.subject", async (ops) => {
        await seedApp(ops, "app_putsub");
        const target = { appId: "app_putsub", collection: "notes", owner: "own_a" };
        await assertThrowsCode(
          () => ops.appData.put(target, { id: "n1", data: {}, refs: { subject: "own_b" } }),
          "validation",
          "a caller-supplied refs.subject on appData.put",
        );
        assert(await ops.appData.get(target, "n1") === null, "the refused put wrote its row anyway");
      }),

      opsCase(opts, "appData.list refuses a caller-supplied refs.subject", async (ops) => {
        await seedApp(ops, "app_listsub");
        const target = { appId: "app_listsub", collection: "notes", owner: "own_a" };
        await assertThrowsCode(
          () => ops.appData.list(target, { refs: { subject: "own_b" } }),
          "validation",
          "a caller-supplied refs.subject on appData.list",
        );
      }),

      opsCase(opts, "appData.list never returns another owner's rows", async (ops) => {
        await seedApp(ops, "app_scope");
        const a = { appId: "app_scope", collection: "notes", owner: "own_a" };
        const b = { appId: "app_scope", collection: "notes", owner: "own_b" };
        await ops.appData.put(a, { id: "mine", data: {} });
        await ops.appData.put(b, { id: "theirs", data: {} });
        assertDeepEqual(
          (await ops.appData.list(a)).records.map((r) => r.id),
          ["mine"],
          "list returned rows outside the target owner's scope",
        );
        assertDeepEqual(
          (await ops.appData.list(b)).records.map((r) => r.id),
          ["theirs"],
          "list returned rows outside the target owner's scope",
        );
      }),

      /** Both halves, deliberately — the same trap `delete` below calls out: a
          `get` that returns null for EVERYONE also passes the negative
          assertion on its own, so the owner's own read is asserted too. */
      opsCase(opts, "appData.get returns null for another owner's row", async (ops) => {
        await seedApp(ops, "app_getscope");
        const owner = { appId: "app_getscope", collection: "notes", owner: "own_a" };
        const other = { appId: "app_getscope", collection: "notes", owner: "own_b" };
        await ops.appData.put(owner, { id: "secret", data: { v: 1 } });
        assert(await ops.appData.get(other, "secret") === null, "get read another owner's row");
        const mine = await ops.appData.get(owner, "secret");
        assert(mine !== null, "get returned null for the owner's own row");
        assertDeepEqual(mine!.data, { v: 1 }, "get returned the wrong row for its owner");
      }),

      /** Both halves, deliberately: a `delete` that does nothing at all also
          leaves the other owner's row alone, so the negative assertion on its
          own is passed by an empty function. */
      opsCase(opts, "appData.delete deletes only the caller's own row", async (ops) => {
        await seedApp(ops, "app_delscope");
        const owner = { appId: "app_delscope", collection: "notes", owner: "own_a" };
        const other = { appId: "app_delscope", collection: "notes", owner: "own_b" };
        await ops.appData.put(owner, { id: "keep", data: { v: 1 } });
        await ops.appData.delete(other, "keep");
        assert(await ops.appData.get(owner, "keep") !== null, "delete destroyed another owner's row");
        await ops.appData.delete(owner, "keep");
        assert(await ops.appData.get(owner, "keep") === null, "delete left the owner's own row behind");
      }),

      /** `put` has an unconditional upsert's blast radius — an unconditional upsert on
          (collection, id) — so an id another owner holds must be refused, not
          overwritten and re-stamped into a row the loser can neither read nor
          delete. */
      opsCase(opts, "appData.put refuses an id another owner holds", async (ops) => {
        await seedApp(ops, "app_putconflict");
        const owner = { appId: "app_putconflict", collection: "notes", owner: "own_a" };
        const other = { appId: "app_putconflict", collection: "notes", owner: "own_b" };
        await ops.appData.put(owner, { id: "taken", data: { v: 1 } });
        await assertThrowsCode(
          () => ops.appData.put(other, { id: "taken", data: { v: 2 } }),
          "conflict",
          "a put against an id another owner holds",
        );
        const still = await ops.appData.get(owner, "taken");
        assert(still !== null, "the refused put destroyed the holder's row");
        assertDeepEqual(still!.data, { v: 1 }, "the refused put overwrote the holder's row");
        assert(await ops.appData.get(other, "taken") === null, "the refused put re-stamped the row");
      }),

      opsCase(opts, "appData.list honors caller refs alongside the owner scope", async (ops) => {
        await seedApp(ops, "app_refs");
        const a = { appId: "app_refs", collection: "notes", owner: "own_a" };
        const b = { appId: "app_refs", collection: "notes", owner: "own_b" };
        await ops.appData.put(a, { id: "inv", data: {}, refs: { kind: "invoice" } });
        await ops.appData.put(a, { id: "memo", data: {}, refs: { kind: "memo" } });
        await ops.appData.put(b, { id: "their_inv", data: {}, refs: { kind: "invoice" } });
        assertDeepEqual(
          (await ops.appData.list(a, { refs: { kind: "invoice" } })).records.map((r) => r.id),
          ["inv"],
          "the caller's refs filter and the owner scope did not both apply",
        );
      }),

      opsCase(opts, "appData file twins round-trip and stay owner-isolated", async (ops) => {
        await seedApp(ops, "app_files");
        const owner = { appId: "app_files", collection: "notes", owner: "own_a" };
        const other = { appId: "app_files", collection: "notes", owner: "own_b" };
        const bytes = new Uint8Array([0, 7, 255]);
        await ops.appData.putFile(owner, "receipt.bin", bytes, { contentType: "application/octet-stream" });
        const got = await ops.appData.getFile(owner, "receipt.bin");
        assert(got !== null, "the stored file returned null for its owner");
        assertBytesEqual(got!.bytes, bytes, "file bytes did not round-trip");
        assert(got!.contentType === "application/octet-stream", "file contentType did not round-trip");

        assert(await ops.appData.getFile(other, "receipt.bin") === null, "getFile read another owner's file");
        await ops.appData.deleteFile(other, "receipt.bin");
        assert(await ops.appData.getFile(owner, "receipt.bin") !== null, "deleteFile destroyed another owner's file");
        // The positive half — without it an empty deleteFile passes the line above.
        await ops.appData.deleteFile(owner, "receipt.bin");
        assert(await ops.appData.getFile(owner, "receipt.bin") === null, "deleteFile left the owner's own file behind");
      }),

      /** The owner prefix is the backend's scoping mechanism, not part of the
          caller's key space: a generated app that stored `receipt.bin` must get
          `receipt.bin` back, and its prefix filters are its own keys' prefixes. */
      opsCase(opts, "appData.listFiles returns keys without the owner prefix", async (ops) => {
        await seedApp(ops, "app_listfiles");
        const owner = { appId: "app_listfiles", collection: "notes", owner: "own_a" };
        const other = { appId: "app_listfiles", collection: "notes", owner: "own_b" };
        await ops.appData.putFile(owner, "images/a.png", new Uint8Array([1]));
        await ops.appData.putFile(owner, "docs/a.txt", new Uint8Array([2]));
        await ops.appData.putFile(other, "images/b.png", new Uint8Array([3]));

        assertDeepEqual(
          (await ops.appData.listFiles(owner)).sort(),
          ["docs/a.txt", "images/a.png"],
          "listFiles returned prefixed keys or crossed owners",
        );
        assertDeepEqual(
          await ops.appData.listFiles(owner, "images/"),
          ["images/a.png"],
          "the prefix filter was not relative to the caller's own key space",
        );
      }),

      /** The owner is the FIRST PATH SEGMENT of every appData file key
          (`<owner>/<key>`), so an owner holding "/" is not a name, it is a
          second key segment: owner "own_a/sub" reading "x.bin" reads owner
          "own_a"'s "sub/x.bin". Hosts pick their own subject spelling and
          path-like ones are ordinary, so the fence is the grammar and the
          answer is a refusal — a sanitised owner would land two people in one
          drawer. Every verb, because every verb composes the key. */
      opsCase(opts, "appData refuses an owner outside the grammar", async (ops) => {
        await seedApp(ops, "app_owner");
        const owner = { appId: "app_owner", collection: "notes", owner: "own_a" };
        await ops.appData.put(owner, { id: "n1", data: { v: 1 } });
        await ops.appData.putFile(owner, "sub/x.bin", new Uint8Array([9]));

        const crafted = { appId: "app_owner", collection: "notes", owner: "own_a/sub" };
        const verbs: [string, () => Promise<unknown>][] = [
          ["put", () => ops.appData.put(crafted, { id: "n2", data: {} })],
          ["get", () => ops.appData.get(crafted, "n1")],
          ["list", () => ops.appData.list(crafted)],
          ["delete", () => ops.appData.delete(crafted, "n1")],
          ["putFile", () => ops.appData.putFile(crafted, "y.bin", new Uint8Array([1]))],
          ["getFile", () => ops.appData.getFile(crafted, "x.bin")],
          ["listFiles", () => ops.appData.listFiles(crafted)],
          ["deleteFile", () => ops.appData.deleteFile(crafted, "x.bin")],
        ];
        for (const [verb, run] of verbs) {
          await assertThrowsCode(run, "validation", `appData.${verb} with an owner containing "/"`);
        }
        // A refusal, not a no-op that quietly worked on the foreign drawer.
        assert(
          await ops.appData.getFile(owner, "sub/x.bin") !== null,
          "a crafted owner reached the real owner's file",
        );
        await assertThrowsCode(
          () => ops.appData.get({ ...owner, owner: "" }, "n1"),
          "validation",
          "an empty appData owner",
        );

        // NOT a slug grammar: a subject is the host's own user id in the host's
        // own spelling, and "auth0|…" and "user:with:colons" are contract
        // elsewhere in this repo. Only "/" is refused.
        for (const [index, exotic] of ["auth0|64f0", "user:with:colons", "person@example.com"].entries()) {
          const target = { appId: "app_owner", collection: "notes", owner: exotic };
          const put = await ops.appData.put(target, { id: `ok_${index}`, data: { who: exotic } });
          assert(put.refs?.["subject"] === exotic, `the owner ${exotic} was not stamped`);
          await ops.appData.putFile(target, "f.bin", new Uint8Array([2]));
          assertDeepEqual(await ops.appData.listFiles(target), ["f.bin"], `listFiles broke for owner ${exotic}`);
        }
      }),

      opsCase(opts, "appData refuses a collection name outside the grammar", async (ops) => {
        await seedApp(ops, "app_grammar");
        const legal = { appId: "app_grammar", collection: "box:inbox", owner: "own_a" };
        const put = await ops.appData.put(legal, { id: "ok", data: {} });
        assert(put.id === "ok", "a legal box: collection was not accepted");

        for (const collection of ["has spaces", "a/b"]) {
          const illegal = { appId: "app_grammar", collection, owner: "own_a" };
          await assertThrowsCode(
            () => ops.appData.put(illegal, { id: "no", data: {} }),
            "validation",
            `the collection name ${JSON.stringify(collection)} on put`,
          );
          // A read verb too: the name is composed on every verb, not just writes.
          await assertThrowsCode(
            () => ops.appData.get(illegal, "no"),
            "validation",
            `the collection name ${JSON.stringify(collection)} on get`,
          );
        }

        // The appId shares the name with the collection and is parsed back out
        // of it on the assumption it holds no colon, so it carries its own
        // refusal: "app_grammar:box" + "evil" would otherwise be the same
        // drawer as "app_grammar" + "box:evil".
        await assertThrowsCode(
          () => ops.appData.put({ appId: "app_grammar:box", collection: "evil", owner: "own_a" }, { id: "no", data: {} }),
          "validation",
          "an appId containing a colon",
        );
      }),

      // =====================================================================
      // transcripts
      // =====================================================================

      opsCase(opts, "transcripts.putThread and getThread round-trip", async (ops) => {
        const thread = { id: "thr_t1", subject: "user_1", messages: [{ role: "user", text: "hi" }], title: "Hello" };
        const put = await ops.transcripts.putThread(thread);
        assert(put.id === "thr_t1", "putThread did not echo id");
        const got = await ops.transcripts.getThread("thr_t1");
        assert(got !== null, "getThread returned null after putThread");
        assertDeepEqual(got!.id, "thr_t1", "getThread returned wrong id");
        const data = got!.data as Record<string, unknown>;
        assert(data["subject"] === "user_1", "thread subject not round-tripped");
        assert(Array.isArray(data["messages"]), "thread messages not round-tripped");
      }),

      opsCase(opts, "transcripts.listThreads filters by subject", async (ops) => {
        await ops.transcripts.putThread({ id: "thr_lt1", subject: "alice", messages: [] });
        await ops.transcripts.putThread({ id: "thr_lt2", subject: "bob", messages: [] });
        await ops.transcripts.putThread({ id: "thr_lt3", subject: "alice", messages: [] });
        const result = await ops.transcripts.listThreads({ subject: "alice" });
        const ids = result.records.map((r) => r.id).sort();
        assertDeepEqual(ids, ["thr_lt1", "thr_lt3"], "listThreads subject filter returned wrong threads");
      }),

      opsCase(opts, "transcripts.listThreads paginates without loss or duplicates", async (ops) => {
        const expected = ["thr_ta", "thr_tb", "thr_tc", "thr_td", "thr_te"];
        for (const id of expected) await ops.transcripts.putThread({ id, subject: "pager", messages: [] });
        await ops.transcripts.putThread({ id: "thr_other", subject: "elsewhere", messages: [] });
        await assertPaginates("transcripts.listThreads", expected, async (cursor) => {
          const page = await ops.transcripts.listThreads({ subject: "pager", limit: PAGE, cursor });
          return { ids: page.records.map((r) => r.id), cursor: page.cursor };
        });
      }),

      /** F4: the delete is a cascade. Asserted by re-creating the id — orphaned
          messages or a surviving answer ledger surface there, where a
          `getThread() === null` check is blind to them. */
      opsCase(opts, "transcripts.deleteThread cascades to messages, answers, and harness state", async (ops) => {
        await ops.transcripts.putThread({ id: "thr_dt1", subject: "u", messages: [] });
        await ops.transcripts.putMessage("thr_dt1", { id: "msg_1", role: "user", text: "hi" });
        await ops.transcripts.recordAnswer("thr_dt1", { id: "ans_1", value: 42 });
        await ops.harness.set(harnessSlot("thr_dt1"), "u", { session: "native_1" });

        await ops.transcripts.deleteThread("thr_dt1");
        assert(await ops.transcripts.getThread("thr_dt1") === null, "deleted thread remained readable");
        assert(await ops.harness.get(harnessSlot("thr_dt1"), "u") === null, "deleted thread left its harness state behind");

        await ops.transcripts.putThread({ id: "thr_dt1", subject: "u", messages: [] });
        await ops.transcripts.recordAnswer("thr_dt1", { id: "ans_1", value: 42 });
        const revived = await ops.transcripts.getThread("thr_dt1");
        const messages = (revived!.data as Record<string, unknown>)["messages"] as unknown[];
        assert(messages.length === 1, `the re-created thread should hold only its new answer, got ${messages.length} messages`);
      }),

      opsCase(opts, "transcripts.putMessage appends to existing thread", async (ops) => {
        await ops.transcripts.putThread({ id: "thr_pm1", subject: "u", messages: [{ role: "user", text: "1" }] });
        await ops.transcripts.putMessage("thr_pm1", { role: "assistant", text: "2" });
        const got = await ops.transcripts.getThread("thr_pm1");
        const msgs = (got!.data as Record<string, unknown>)["messages"] as unknown[];
        assert(msgs.length === 2, `putMessage did not append: got ${msgs.length} messages`);
      }),

      /** putMessage is an UPSERT, not an append-only log: a message re-sent
          under an id the thread already holds REPLACES it, in place. That is
          how an edit lands and how an approval flips from pending to answered;
          appending instead leaves two messages under one id, which the thread
          engines refuse outright, so the flip could never persist. */
      opsCase(opts, "transcripts.putMessage edits by id, in place", async (ops) => {
        await ops.transcripts.putThread({ id: "thr_pm2", subject: "u", messages: [] });
        await ops.transcripts.putMessage("thr_pm2", { id: "msg_a", role: "user", text: "ask" });
        await ops.transcripts.putMessage("thr_pm2", { id: "msg_b", role: "assistant", text: "answer" });
        await ops.transcripts.putMessage("thr_pm2", { id: "msg_a", role: "user", text: "ask (edited)" });

        const got = await ops.transcripts.getThread("thr_pm2");
        const msgs = (got!.data as Record<string, unknown>)["messages"] as Array<Record<string, unknown>>;
        assert(msgs.length === 2, `the edit should not have added a message: got ${msgs.length}`);
        assertDeepEqual(
          msgs.map((message) => [message["id"], message["text"]]),
          [["msg_a", "ask (edited)"], ["msg_b", "answer"]],
          "the edit did not replace its message in place",
        );
      }),

      opsCase(opts, "transcripts.recordAnswer records answer; duplicate same-id refused as conflict", async (ops) => {
        await ops.transcripts.putThread({ id: "thr_ra1", subject: "u", messages: [] });
        await ops.transcripts.recordAnswer("thr_ra1", { id: "ans_1", value: 42 });
        await assertThrowsCode(
          () => ops.transcripts.recordAnswer("thr_ra1", { id: "ans_1", value: 42 }),
          "conflict",
          "a duplicate answer id",
        );
      }),

      // =====================================================================
      // harness
      // =====================================================================

      opsCase(opts, "harness.set and get round-trip state", async (ops) => {
        const state = { counter: 5, items: ["a", "b"] };
        await ops.harness.set("app_1", "user_1", state);
        const got = await ops.harness.get("app_1", "user_1");
        assertDeepEqual(got, state, "harness state did not round-trip");
      }),

      opsCase(opts, "harness.get missing returns null", async (ops) => {
        assert(await ops.harness.get("app_x", "user_x") === null, "missing harness state did not return null");
      }),

      opsCase(opts, "harness.clear removes state", async (ops) => {
        await ops.harness.set("app_2", "user_2", { v: 1 });
        await ops.harness.clear("app_2", "user_2");
        assert(await ops.harness.get("app_2", "user_2") === null, "cleared harness state remained readable");
      }),

      // =====================================================================
      // workspace
      // =====================================================================

      opsCase(opts, "workspace.commit and read round-trip", async (ops) => {
        await ops.workspace.commit([{ path: "a.json", data: { x: 1 } }, { path: "b.json", data: { y: 2 } }]);
        const result = await ops.workspace.read(["a.json", "b.json", "missing.json"]);
        assertDeepEqual(result["a.json"], { x: 1 }, "workspace read did not round-trip a.json");
        assertDeepEqual(result["b.json"], { y: 2 }, "workspace read did not round-trip b.json");
        assert(!("missing.json" in result), "workspace read returned a missing path");
      }),

      opsCase(opts, "workspace.index paginates without loss or duplicates", async (ops) => {
        const expected = ["xa.json", "xb.json", "xc.json", "xd.json", "xe.json"];
        await ops.workspace.commit(expected.map((path) => ({ path, data: { path } })));
        await assertPaginates("workspace.index", expected, async (cursor) => {
          const page = await ops.workspace.index({ limit: PAGE, cursor });
          return {
            ids: page.entries.map((entry) => stringField(entry, "path", "workspace.index")),
            cursor: page.cursor,
          };
        });
      }),

      opsCase(opts, "workspace.history paginates without loss or duplicates", async (ops) => {
        for (const v of [1, 2, 3, 4, 5]) await ops.workspace.commit([{ path: `h${v}.json`, data: { v } }]);
        const all = (await ops.workspace.history()).entries
          .map((entry) => stringField(entry, "commitId", "workspace.history"));
        assert(all.length === 5, `history should hold one entry per commit, got ${all.length}`);
        await assertPaginates("workspace.history", all, async (cursor) => {
          const page = await ops.workspace.history({ limit: PAGE, cursor });
          return {
            ids: page.entries.map((entry) => stringField(entry, "commitId", "workspace.history")),
            cursor: page.cursor,
          };
        });
      }),

      /** The idempotency key on the wire's ONE mutation header, proved at the
          op that carries it: a replay returns the recorded result instead of
          applying the entries a second time. */
      opsCase(opts, "workspace.commit replays an idempotency key without applying it twice", async (ops) => {
        const entries = [{ path: "idem.json", data: { v: 1 } }];
        await ops.workspace.commit(entries, { idempotencyKey: "idem_1" });
        await ops.workspace.commit([{ path: "idem.json", data: { v: 2 } }]);
        const before = (await ops.workspace.history()).entries.length;
        await ops.workspace.commit(entries, { idempotencyKey: "idem_1" });
        assertDeepEqual(
          (await ops.workspace.read(["idem.json"]))["idem.json"],
          { v: 2 },
          "the replay re-applied its entries over a later commit",
        );
        const after = (await ops.workspace.history()).entries.length;
        assert(after === before, `the replay added ${after - before} history entries`);
      }),

      opsCase(opts, "workspace.commit refuses a replayed idempotency key with a different body", async (ops) => {
        await ops.workspace.commit([{ path: "idem2.json", data: { v: 1 } }], { idempotencyKey: "idem_2" });
        await assertThrowsCode(
          () => ops.workspace.commit([{ path: "idem2.json", data: { v: 99 } }], { idempotencyKey: "idem_2" }),
          "conflict",
          "an idempotency key replayed with a different body",
        );
        assertDeepEqual(
          (await ops.workspace.read(["idem2.json"]))["idem2.json"],
          { v: 1 },
          "the refused replay applied its entries anyway",
        );
      }),

      opsCase(opts, "workspace.history records one commit per landed write", async (ops) => {
        await ops.workspace.commit([{ path: "hist.json", data: { v: 1 } }]);
        const before = new Set((await ops.workspace.history()).entries
          .map((entry) => stringField(entry, "commitId", "workspace.history")));
        await ops.workspace.commit([{ path: "hist.json", data: { v: 2 } }]);
        const added = (await ops.workspace.history()).entries
          .map((entry) => stringField(entry, "commitId", "workspace.history"))
          .filter((id) => !before.has(id));
        assert(added.length === 1, `one commit should have been added to history, got ${added.length}`);
      }),

      /** The workspace is the last op family to name its owner, and until it
          did, every end user of one deployment shared ONE drawer. Two owners,
          one path: no read, index or history may cross. */
      opsCase(opts, "workspace ops keep two owners' drawers apart", async (ops) => {
        const path = "shared.json";
        await ops.workspace.commit([{ path, data: { who: "a" } }], { owner: "own_a" });
        await ops.workspace.commit([{ path, data: { who: "b" } }], { owner: "own_b" });

        assertDeepEqual(
          (await ops.workspace.read([path], { owner: "own_a" }))[path],
          { who: "a" },
          "one owner's read returned another owner's file",
        );
        assertDeepEqual(
          (await ops.workspace.read([path], { owner: "own_b" }))[path],
          { who: "b" },
          "one owner's read returned another owner's file",
        );
        assertDeepEqual(
          await ops.workspace.read([path], { owner: "own_c" }),
          {},
          "an owner with no files read someone else's drawer",
        );
        assertDeepEqual(
          (await ops.workspace.index({ owner: "own_a" })).entries
            .map((entry) => stringField(entry, "path", "workspace.index")),
          [path],
          "one owner's index listed another owner's files",
        );
        assertDeepEqual(
          (await ops.workspace.index({ owner: "own_c" })).entries,
          [],
          "an owner with no files indexed someone else's drawer",
        );

        const commitsOf = async (owner: string): Promise<string[]> =>
          (await ops.workspace.history({ owner })).entries
            .map((entry) => stringField(entry, "commitId", "workspace.history"));
        const [ofA, ofB] = [await commitsOf("own_a"), await commitsOf("own_b")];
        assert(ofA.length === 1 && ofB.length === 1, "history did not filter by owner");
        assert(ofA[0] !== ofB[0], "two owners' histories returned the same commit");
      }),

      /** Deletion was inexpressible over the wire: a hosted workspace could
          add and overwrite files forever but never drop one. */
      opsCase(opts, "workspace.commit removes a path with a delete tombstone", async (ops) => {
        await ops.workspace.commit([{ path: "tomb.json", data: { v: 1 } }]);
        await ops.workspace.commit([{ path: "tomb.json", delete: true }]);
        assertDeepEqual(
          await ops.workspace.read(["tomb.json"]),
          {},
          "the tombstone left the file behind",
        );
        assertDeepEqual(
          (await ops.workspace.index()).entries
            .map((entry) => stringField(entry, "path", "workspace.index")),
          [],
          "the tombstoned path is still in the index",
        );
        // The tombstone is itself a commit, so the trail still says what happened.
        assert(
          (await ops.workspace.history({ path: "tomb.json" })).entries.length === 2,
          "the tombstone did not record a commit of its own",
        );
      }),

      // ---------------------------------------------------------------------
      // the path leg of history — one file's trail, rather than the whole
      // ledger filtered by hand.
      // ---------------------------------------------------------------------

      opsCase(opts, "workspace.history narrows to the commits that touched one path", async (ops) => {
        await ops.workspace.commit([{ path: "p-mine.json", data: { v: 1 } }]);
        await ops.workspace.commit([{ path: "p-other.json", data: { v: 1 } }]);
        await ops.workspace.commit([{ path: "p-mine.json", data: { v: 2 } }]);

        const commitsOf = async (path: string): Promise<unknown[]> =>
          (await ops.workspace.history({ path })).entries;
        const mine = await commitsOf("p-mine.json");
        assert(mine.length === 2, `path history should hold this path's two commits, got ${mine.length}`);
        assert(
          (await commitsOf("p-other.json")).length === 1,
          "path history returned commits that did not touch the path",
        );
        assertDeepEqual(await commitsOf("p-never.json"), [], "path history invented commits for an untouched path");

        // Newest first, and the newest one names the revision it superseded,
        // which is what distinguishes an overwrite from a create. The commit
        // that CREATED the path superseded nothing, so it names no revision.
        const newest = mine[0];
        assert(
          numberField(newest, "revision", "workspace.history") > 0,
          "the overwriting commit did not name the revision it superseded",
        );
        assert(
          (mine[1] as Record<string, unknown>)["revision"] === undefined,
          "the commit that created the path claimed to have superseded a revision",
        );
      }),

      opsCase(opts, "the path leg of history keeps two owners' drawers apart", async (ops) => {
        const path = "p-shared.json";
        for (const owner of ["pown_a", "pown_b"]) {
          await ops.workspace.commit([{ path, data: { who: owner, v: 1 } }], { owner });
          await ops.workspace.commit([{ path, data: { who: owner, v: 2 } }], { owner });
        }
        assert(
          (await ops.workspace.history({ path, owner: "pown_a" })).entries.length === 2,
          "one owner's path history did not hold that owner's two commits",
        );
        assertDeepEqual(
          (await ops.workspace.history({ path, owner: "pown_c" })).entries,
          [],
          "an owner with no files read another owner's path history",
        );
        assertDeepEqual(
          (await ops.workspace.read([path], { owner: "pown_b" }))[path],
          { who: "pown_b", v: 2 },
          "one owner's path history reached into another owner's drawer",
        );
      }),

      /** The `/orgs` mounts commit under strict compare-and-swap: a write built
          on a revision that has moved must be refused, not silently applied
          over a colleague's edit. */
      opsCase(opts, "workspace.commit refuses a stale expectedRevision and applies nothing", async (ops) => {
        await ops.workspace.commit([{ path: "cas.json", data: { v: 1 } }]);
        const revision = numberField(
          (await ops.workspace.index()).entries[0],
          "revision",
          "workspace.index",
        );
        // The head moves under the caller.
        await ops.workspace.commit([{ path: "cas.json", data: { v: 2 } }]);

        await assertThrowsCode(
          () => ops.workspace.commit([
            { path: "cas.json", data: { v: 3 }, expectedRevision: revision },
            { path: "cas-other.json", data: { v: 3 } },
          ]),
          "conflict",
          "committing against a revision that has moved",
        );
        assertDeepEqual(
          (await ops.workspace.read(["cas.json"]))["cas.json"],
          { v: 2 },
          "the refused commit overwrote the newer content",
        );
        assert(
          !("cas-other.json" in await ops.workspace.read(["cas-other.json"])),
          "the refused commit applied its non-conflicting entry anyway",
        );

        // Re-aimed at the live head, the same commit lands.
        const head = numberField(
          (await ops.workspace.index()).entries
            .find((entry) => (entry as { path?: unknown }).path === "cas.json"),
          "revision",
          "workspace.index",
        );
        await ops.workspace.commit([{ path: "cas.json", data: { v: 3 }, expectedRevision: head }]);
        assertDeepEqual(
          (await ops.workspace.read(["cas.json"]))["cas.json"],
          { v: 3 },
          "a commit aimed at the live revision did not land",
        );
      }),

      /** A DELETE is a commit against a revision too. Without this, a turn that
          checked out an org file, lost the head to a colleague, and then removed
          the path erased content it had never seen — the one mutation strict
          mounts cannot take back. */
      opsCase(opts, "workspace.commit refuses a stale expectedRevision on a tombstone", async (ops) => {
        await ops.workspace.commit([{ path: "cas-del.json", data: { v: 1 } }]);
        const revision = numberField(
          (await ops.workspace.index()).entries
            .find((entry) => (entry as { path?: unknown }).path === "cas-del.json"),
          "revision",
          "workspace.index",
        );
        // The head moves under the caller holding `revision`.
        await ops.workspace.commit([{ path: "cas-del.json", data: { v: 2 } }]);

        await assertThrowsCode(
          () => ops.workspace.commit([{ path: "cas-del.json", delete: true, expectedRevision: revision }]),
          "conflict",
          "deleting a path whose revision has moved",
        );
        assertDeepEqual(
          (await ops.workspace.read(["cas-del.json"]))["cas-del.json"],
          { v: 2 },
          "a stale tombstone deleted the newer content",
        );
      }),

      /** Bytes that happen to match the head do not make a stale commit fresh:
          the caller still read a revision that has moved, and the contract's
          answer to that is `conflict`, whatever the entry would have written. */
      opsCase(opts, "workspace.commit refuses a stale expectedRevision whose bytes already match", async (ops) => {
        await ops.workspace.commit([{ path: "cas-same.json", data: { v: 1 } }]);
        const revision = numberField(
          (await ops.workspace.index()).entries
            .find((entry) => (entry as { path?: unknown }).path === "cas-same.json"),
          "revision",
          "workspace.index",
        );
        await ops.workspace.commit([{ path: "cas-same.json", data: { v: 2 } }]);

        await assertThrowsCode(
          () => ops.workspace.commit([{ path: "cas-same.json", data: { v: 2 }, expectedRevision: revision }]),
          "conflict",
          "committing the head's own bytes against a revision that has moved",
        );
      }),

      /** Two entries for one path leave the commit with no single before-image,
          so the path's trail would name two superseded revisions under one
          commit id and neither would be THE one it replaced. Refused at the
          door instead. */
      opsCase(opts, "workspace.commit refuses the same path twice in one commit", async (ops) => {
        await assertThrowsCode(
          () => ops.workspace.commit([
            { path: "dup.json", data: { v: 1 } },
            { path: "dup.json", delete: true },
          ]),
          "validation",
          "committing one path twice",
        );
        assertDeepEqual(
          await ops.workspace.read(["dup.json"]),
          {},
          "the refused commit wrote its first entry anyway",
        );
      }),

      /** The guard's third state. A colleague who opened the mount before the
          file existed checked out NOTHING, so their base is `null`, not a
          number — and a backend that only understands numbers drops the guard
          on exactly the write that creates the shared file, which is where two
          colleagues collide most. */
      opsCase(opts, "workspace.commit refuses a create under expectedRevision null when the path exists", async (ops) => {
        // Nothing there yet: the create-only guard is satisfied and lands.
        await ops.workspace.commit([
          { path: "create-cas.json", data: { by: "first" }, expectedRevision: null },
        ]);
        assertDeepEqual(
          (await ops.workspace.read(["create-cas.json"]))["create-cas.json"],
          { by: "first" },
          "a create against an absent path did not land",
        );

        // The second creator read nothing either, and must lose rather than
        // overwrite the file that appeared under them.
        await assertThrowsCode(
          () => ops.workspace.commit([
            { path: "create-cas.json", data: { by: "second" }, expectedRevision: null },
            { path: "create-cas-other.json", data: { by: "second" } },
          ]),
          "conflict",
          "creating a path that another caller already created",
        );
        assertDeepEqual(
          (await ops.workspace.read(["create-cas.json"]))["create-cas.json"],
          { by: "first" },
          "the refused create overwrote the first creator's file",
        );
        assert(
          !("create-cas-other.json" in await ops.workspace.read(["create-cas-other.json"])),
          "the refused commit applied its non-conflicting entry anyway",
        );
      }),

      // =====================================================================
      // lifecycle
      // =====================================================================

      opsCase(opts, "lifecycle.erase removes one subject's records, threads, and harness state", async (ops) => {
        await ops.engine.put("vendo_parked_call", { id: "gone", data: {}, refs: { subject: "erase_me" } });
        await ops.engine.put("vendo_parked_call", { id: "keep", data: {}, refs: { subject: "other" } });
        await ops.transcripts.putThread({ id: "thr_erase", subject: "erase_me", messages: [] });
        await ops.transcripts.putThread({ id: "thr_keep", subject: "other", messages: [] });
        await ops.harness.set("app_erase", "erase_me", { v: 1 });

        const report = await ops.lifecycle.erase({ subject: "erase_me" });
        assert(report !== null && report !== undefined, "erase must return a report");
        assert(await ops.engine.get("vendo_parked_call", "gone") === null, "erase left the subject's record behind");
        assert(await ops.engine.get("vendo_parked_call", "keep") !== null, "erase removed another subject's record");
        assert(await ops.transcripts.getThread("thr_erase") === null, "erase left the subject's thread behind");
        assert(await ops.transcripts.getThread("thr_keep") !== null, "erase removed another subject's thread");
        assert(await ops.harness.get("app_erase", "erase_me") === null, "erase left the subject's harness state behind");
      }),

      /** Promote hands the app to an org: the app record's owning subject
          BECOMES the org id (02-store §9.5), which is the move's only
          observable through the ops surface. */
      opsCase(opts, "lifecycle.promote hands the app record to the org; an unknown app is not-found", async (ops) => {
        // A SHAPE-VALID app record: vendo_apps is a typed door, and a real
        // backend refuses data that does not parse as {subject, enabled, doc}.
        await ops.engine.put("vendo_apps", {
          id: "app_promote",
          data: {
            subject: "user_1",
            enabled: true,
            doc: { format: "vendo/app@1", id: "app_promote", name: "Promoted" },
          },
          refs: { subject: "user_1" },
        });
        await ops.lifecycle.promote("app_promote", "org_1");
        const promoted = await ops.engine.get("vendo_apps", "app_promote");
        assert(
          promoted?.refs?.["subject"] === "org_1",
          `promote should hand the app to the org, got subject ${String(promoted?.refs?.["subject"])}`,
        );
        await assertThrowsCode(() => ops.lifecycle.promote("app_absent", "org_1"), "not-found", "promoting an unknown app");
      }),

      /** The batch append: ownership is the caller's `subject`, so the mount
          checks it in its own statement and the client never downloads the
          thread to check it first. Optional — a mount that omits it is served
          by putMessage, and this case says so instead of failing it. */
      opsCase(opts, "transcripts.appendMessages lands a batch under the named subject", async (ops) => {
        const append = ops.transcripts.appendMessages;
        if (append === undefined) return;
        await ops.transcripts.putThread({ id: "thr_am1", subject: "u", messages: [] });
        const landed = await append("thr_am1", "u", [
          { id: "msg_a", role: "user", text: "one" },
          { id: "msg_b", role: "assistant", text: "two" },
        ], { title: "one" });
        assert(landed.count === 2, `appendMessages should report 2 rows, got ${landed.count}`);
        assert(typeof landed.revision === "string", "appendMessages should report the thread's new revision");
        // The answer is the revision and the count — NOT the thread. Echoing the
        // transcript back is the payload this op exists to stop paying.
        assertDeepEqual(Object.keys(landed).sort(), ["count", "revision"], "appendMessages answered with more than {revision, count}");

        const got = await ops.transcripts.getThread("thr_am1");
        const messages = (got!.data as Record<string, unknown>)["messages"] as unknown[];
        assert(messages.length === 2, `appendMessages did not land both messages: got ${messages.length}`);

        // A foreign subject is refused by the statement, not by a pre-check.
        await ops.transcripts.putThread({ id: "thr_am2", subject: "owner", messages: [] });
        await assertThrowsCode(
          () => append("thr_am2", "someone_else", [{ id: "msg_x", role: "user", text: "not mine" }]),
          "conflict",
          "appending to another subject's thread",
        );
      }),

      // =====================================================================
      // audit
      // =====================================================================

      /** The reviewer's feed and the decision tally, which are the only two
          reasons this door exists at all: three of its four filters are not
          refs (`venue` is a column, `outcome` and `decidedBy` live inside the
          event), so `engine.list`'s ref filter cannot express any of them. */
      opsCase(opts, "audit.list narrows by each of its four filters and ANDs them together", async (ops) => {
        await seedAudit(ops, [
          auditEvent("aud_c1", 1, { kind: "tool-call", venue: "chat", outcome: "ok", decidedBy: "grant" }),
          auditEvent("aud_c2", 2, { kind: "approval", venue: "app", outcome: "blocked", decidedBy: "denied" }),
          auditEvent("aud_c3", 3, { kind: "tool-call", venue: "app", outcome: "ok", decidedBy: "rule" }),
          auditEvent("aud_c4", 4, { kind: "policy-decision", venue: "chat", outcome: "error", decidedBy: "judge" }),
          auditEvent("aud_c5", 5, { kind: "tool-call", venue: "chat", outcome: "blocked", decidedBy: "grant" }),
        ]);
        const idsOf = async (query?: AuditQuery): Promise<string[]> =>
          (await ops.audit.list(query)).events.map((event) => event.id);

        // No filter is the whole drawer, newest first — an empty query is the
        // feed, not an empty answer.
        assertDeepEqual(await idsOf(), ["aud_c5", "aud_c4", "aud_c3", "aud_c2", "aud_c1"], "an unfiltered audit.list is the whole drawer, newest first");
        assertDeepEqual(await idsOf({ kind: "tool-call" }), ["aud_c5", "aud_c3", "aud_c1"], "the kind filter returned the wrong rows");
        assertDeepEqual(await idsOf({ venue: "app" }), ["aud_c3", "aud_c2"], "the venue filter returned the wrong rows");
        assertDeepEqual(await idsOf({ outcome: "blocked" }), ["aud_c5", "aud_c2"], "the outcome filter returned the wrong rows");
        assertDeepEqual(await idsOf({ decidedBy: "grant" }), ["aud_c5", "aud_c1"], "the decidedBy filter returned the wrong rows");

        // ANDed, never ORed: each of these pairs drops rows that either filter
        // alone keeps, which an OR could not do.
        assertDeepEqual(await idsOf({ kind: "tool-call", venue: "app" }), ["aud_c3"], "two filters did not AND");
        assertDeepEqual(
          await idsOf({ kind: "tool-call", venue: "chat", outcome: "blocked", decidedBy: "grant" }),
          ["aud_c5"],
          "all four filters did not AND",
        );
      }),

      opsCase(opts, "audit.list walks its cursor without loss or duplicates", async (ops) => {
        const ids = ["aud_p1", "aud_p2", "aud_p3", "aud_p4", "aud_p5"];
        await seedAudit(ops, ids.map((id, index) => auditEvent(id, index + 1, {})));
        await assertPaginates("audit.list", ids, async (cursor) => {
          const page = await ops.audit.list({ limit: PAGE, cursor });
          return { ids: page.events.map((event) => event.id), cursor: page.cursor };
        });
      }),

      /** TWO DOORS, ONE DRAWER — the case that matters more than the filters.
          `audit.list()` and `engine.list("vendo_audit")` read the same rows on
          the same keyset order, and nothing in an implementation forces that: a
          typed door sorting on the event's own `at` and a generic one sorting
          on the row's arrival agree until the two differ, and then a reviewer's
          feed and the drawer the erase cascade sweeps stop describing the same
          history. Two doors that are allowed to disagree will. */
      opsCase(opts, "audit.list and engine.list read one drawer in one order", async (ops) => {
        await seedAudit(ops, [
          auditEvent("aud_d1", 1, { kind: "tool-call", outcome: "ok", decidedBy: "grant" }),
          auditEvent("aud_d2", 2, { kind: "approval", venue: "app", outcome: "pending-approval" }),
          auditEvent("aud_d3", 3, { kind: "run", venue: "automation", outcome: "error" }),
        ]);
        const typed = (await ops.audit.list()).events;
        const generic = (await ops.engine.list("vendo_audit")).records;
        assertDeepEqual(
          typed.map((event) => event.id),
          generic.map((record) => record.id),
          "the two doors over vendo_audit returned different rows or a different order",
        );
        assertDeepEqual(
          typed,
          generic.map((record) => record.data),
          "the typed door returned events the drawer does not hold",
        );
      }),

      /** The decision tally: the same drawer, the same four filters, collapsed
          to counts per UTC hour. Three assertions and not one deep-equal on
          purpose — the three ways a group-by goes wrong (a bucket that never
          arrives, a group labelled with the wrong dimension, a count that is
          off) are three different bugs, and a case that reports them with one
          message tells whoever it caught nothing about which. */
      opsCase(opts, "audit.tally counts events per UTC hour, split by outcome and decidedBy", async (ops) => {
        await seedAudit(ops, [
          // Before the floor — and the floor is INCLUSIVE, so only this one is
          // out of the window.
          auditEvent("aud_t0", -30, { outcome: "ok", decidedBy: "grant" }),
          auditEvent("aud_t1", 0, { outcome: "ok", decidedBy: "grant" }),
          auditEvent("aud_t2", 20, { outcome: "ok", decidedBy: "grant" }),
          auditEvent("aud_t3", 40, { outcome: "blocked", decidedBy: "denied" }),
          auditEvent("aud_t4", 70, { outcome: "ok", decidedBy: "grant" }),
          // A control event: not a call, so it carries neither dimension. Its
          // group is `null`/`null` — never dropped, never merged into another.
          auditEvent("aud_t5", 80, { kind: "policy-decision" }),
        ]);
        const from = new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString() as IsoDateTime;
        const rows = await ops.audit.tally({ from });

        // Ascending by bucket, one row per (hour, outcome, decidedBy) group that
        // has events in it — and hours with none are omitted, not zero-filled.
        assertDeepEqual(
          rows.map((row) => row.bucket),
          ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", "2026-01-01T01:00:00.000Z"],
          "the tally's buckets are not the window's UTC hours, ascending",
        );
        // Sorted by outcome then decidedBy inside a bucket, with an absent
        // dimension LAST.
        assertDeepEqual(
          rows.map((row) => `${row.outcome ?? "-"}/${row.decidedBy ?? "-"}`),
          ["blocked/denied", "ok/grant", "ok/grant", "-/-"],
          "the tally labelled a group with the wrong outcome or decidedBy, or ordered the groups differently",
        );
        assertDeepEqual(
          rows.map((row) => row.count),
          [1, 2, 1, 1],
          "the tally counted the wrong number of events in a group",
        );
      }),

      /** ONE WHERE, TWO DOORS — the case that matters more than the arithmetic.
          A tally is only ever read next to the feed it summarises, so the two
          have to narrow identically: nothing in an implementation forces a
          grouped statement's filters to match a paged one's, and a tally that
          counts rows the feed does not show (or misses rows it does) is a
          number a reviewer cannot reconcile with what is on the screen. */
      opsCase(opts, "audit.tally narrows on the same four filters as audit.list, ANDed", async (ops) => {
        await seedAudit(ops, [
          auditEvent("aud_f1", 1, { kind: "tool-call", venue: "chat", outcome: "ok", decidedBy: "grant" }),
          auditEvent("aud_f2", 2, { kind: "approval", venue: "app", outcome: "blocked", decidedBy: "denied" }),
          auditEvent("aud_f3", 3, { kind: "tool-call", venue: "app", outcome: "ok", decidedBy: "rule" }),
          auditEvent("aud_f4", 4, { kind: "tool-call", venue: "chat", outcome: "blocked", decidedBy: "grant" }),
        ]);
        const from = new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString() as IsoDateTime;
        const counted = async (filters: AuditQuery): Promise<number> =>
          (await ops.audit.tally({ ...filters, from })).reduce((total, row) => total + row.count, 0);
        const listed = async (filters: AuditQuery): Promise<number> =>
          (await ops.audit.list(filters)).events.length;

        for (const filters of [
          {},
          { kind: "tool-call" },
          { venue: "app" },
          { outcome: "ok" },
          { decidedBy: "grant" },
          // ANDed, never ORed: this pair drops rows either filter alone keeps.
          { kind: "tool-call", venue: "chat" },
          { kind: "tool-call", venue: "chat", outcome: "blocked", decidedBy: "grant" },
        ] satisfies AuditQuery[]) {
          const total = await counted(filters);
          const shown = await listed(filters);
          assert(
            total === shown,
            `the tally counted ${total} events where the feed shows ${shown} for ${JSON.stringify(filters)}`,
          );
          assert(total > 0, `the case's own fixture makes ${JSON.stringify(filters)} match nothing, so it proves nothing`);
        }
      }),

      // =====================================================================
      // secrets
      // =====================================================================

      /** The vault a host's connectors authenticate out of. `get` answering
          NULL for a name nobody set — not undefined, not a throw — is what lets
          a boot path ask "is this connector configured yet" without wrapping
          the call; a throw there turns an unconfigured connector into a crash. */
      opsCase(opts, "secrets round-trip, overwrite in place, and answer null for a name nobody set", async (ops) => {
        assert(await ops.secrets.get("conf_absent") === null, "a name nobody set must read as null");
        await ops.secrets.set("conf_token", "value_1");
        assert(await ops.secrets.get("conf_token") === "value_1", "the stored secret did not round-trip");
        await ops.secrets.set("conf_token", "value_2");
        assert(await ops.secrets.get("conf_token") === "value_2", "set on a name already held did not overwrite it");
      }),

      /** `list` is the vault's inventory, and it is SORTED: "the order they
          happened to be written in" is not an answer two implementations would
          ever give alike, and an operator reading a rotation list needs the
          same order twice. */
      opsCase(opts, "secrets.list holds exactly the live names, sorted, and delete removes one", async (ops) => {
        for (const name of ["conf_b", "conf_a", "conf_c"]) await ops.secrets.set(name, `value_of_${name}`);
        assertDeepEqual(await ops.secrets.list(), ["conf_a", "conf_b", "conf_c"], "list is not the live names in sorted order");
        await ops.secrets.delete("conf_b");
        assertDeepEqual(await ops.secrets.list(), ["conf_a", "conf_c"], "a deleted name stayed in the inventory");
        assert(await ops.secrets.get("conf_b") === null, "a deleted secret remained readable");
      }),

      // =====================================================================
      // footprint
      // =====================================================================

      /** What is in the drawers, per collection, with each collection's kind
          alongside — and the kind is the reason the op is shaped this way: a
          footprint that cannot tell a retrieval corpus from an ordinary drawer
          cannot answer "what is the index costing me".
          Nothing here asserts a byte COUNT. `bytes` is an estimate of row
          content that each engine measures its own way, and a case pinning a
          number would fail every honest implementation but the one it was
          written against. */
      opsCase(opts, "footprint reports a shape-valid entry per non-empty collection, with its kind", async (ops) => {
        await ops.engine.put("vendo_workspace_commits", { id: "fp_1", data: { note: "x".repeat(64) } });
        await ops.engine.put("vendo_knowledge_docs", { id: "fp_doc_1", data: { text: "y".repeat(64) } });
        const footprint = await ops.footprint();
        for (const entry of footprint) {
          assert(typeof entry.collection === "string" && entry.collection.length > 0, `a footprint entry has no collection name: ${JSON.stringify(entry)}`);
          assert(entry.kind === "storage" || entry.kind === "knowledge", `${entry.collection} reported the kind ${JSON.stringify(entry.kind)}`);
          assert(
            typeof entry.bytes === "number" && Number.isFinite(entry.bytes) && entry.bytes >= 0,
            `${entry.collection} reported bytes ${String(entry.bytes)}`,
          );
        }
        const entryFor = (collection: string): CollectionFootprint | undefined =>
          footprint.find((entry) => entry.collection === collection);
        assert(entryFor("vendo_workspace_commits")?.kind === "storage", "a storage collection holding rows is missing from the footprint");
        assert(entryFor("vendo_knowledge_docs")?.kind === "knowledge", "the retrieval corpus was counted as ordinary storage");
        assert(
          footprint.length === new Set(footprint.map((entry) => entry.collection)).size,
          "a collection was reported more than once",
        );
      }),

      /** MONOTONIC, not exact: rows going in may only push the number up, which
          is the whole of what makes two footprints comparable. `>=` and not `>`
          on purpose — a byte accounting is allowed to be page-granular or
          otherwise coarse, and pinning strict growth would fail an engine that
          is telling the truth about a page it had already allocated. */
      opsCase(opts, "footprint bytes never decrease as a collection grows", async (ops) => {
        const collection = engineAppHistory("conf_fp");
        const bytesOf = async (): Promise<number> =>
          (await ops.footprint()).find((entry) => entry.collection === collection)?.bytes ?? -1;
        await ops.engine.put(collection, { id: "fp_seed", data: { note: "a".repeat(64) } });
        const before = await bytesOf();
        assert(before >= 0, "a collection holding rows was left out of the footprint");
        for (let index = 0; index < 10; index += 1) {
          await ops.engine.put(collection, { id: `fp_more_${index}`, data: { note: "b".repeat(512) } });
        }
        const after = await bytesOf();
        assert(after >= before, `the footprint shrank as rows were added: ${after} < ${before}`);
      }),

      // =====================================================================
      // retention — OPTIONAL (01 §12), so both cases return early on a mount
      // that omits the family rather than failing it. That is what lets every
      // mount carry them; an implementation that HAS the family is held to all
      // of it.
      // =====================================================================

      /** The sweep is a cron, so the two things that matter are the count it
          reports and its behavior on the second pass. The window is expressed
          by moving the CUTOFF rather than the rows' age, because a case can
          only write rows now: a cutoff older than every row covers them all and
          must move nothing. */
      opsCase(opts, "retention.quarantine lifts rows past the cutoff out of the live collection, and re-running it moves nothing", async (ops) => {
        const retention = ops.retention;
        if (retention === undefined) return;
        const collection = engineAppHistory("conf_ret");
        const ids = ["ret_1", "ret_2", "ret_3"];
        for (const id of ids) await ops.engine.put(collection, { id, data: { id } });

        const inWindow = await retention.quarantine(collection, new Date(0).toISOString() as IsoDateTime);
        assert(inWindow.moved === 0, `a cutoff older than every row should move nothing, moved ${inWindow.moved}`);
        assert(
          (await ops.engine.list(collection)).records.length === ids.length,
          "a quarantine that moved nothing still took rows out of the live collection",
        );

        const cutoff = new Date(Date.now() + 60_000).toISOString() as IsoDateTime;
        const swept = await retention.quarantine(collection, cutoff);
        assert(swept.moved === ids.length, `quarantine should report the ${ids.length} rows it moved, reported ${swept.moved}`);
        assertDeepEqual(
          (await ops.engine.list(collection)).records.map((record) => record.id),
          [],
          "quarantined rows stayed in the live collection",
        );
        assert(await ops.engine.get(collection, "ret_1") === null, "a quarantined row is still readable through the live door");

        const again = await retention.quarantine(collection, cutoff);
        assert(again.moved === 0, `a second quarantine at the same cutoff should move nothing, moved ${again.moved}`);
      }),

      /** The gap between the two verbs IS the feature, and the purge count is
          the only place it is observable: the engine owns the quarantine and no
          caller may name it, so "still recoverable" can only be read as a purge
          that declines to destroy. The cutoff is on the QUARANTINE time, not
          the row's age — the grace a purge honors runs from the lift. */
      opsCase(opts, "retention.purge destroys only quarantined rows lifted before its cutoff", async (ops) => {
        const retention = ops.retention;
        if (retention === undefined) return;
        const collection = engineAppHistory("conf_purge");
        const ids = ["purge_1", "purge_2"];
        for (const id of ids) await ops.engine.put(collection, { id, data: { id } });
        const lifted = await retention.quarantine(collection, new Date(Date.now() + 60_000).toISOString() as IsoDateTime);
        assert(lifted.moved === ids.length, `the sweep should have lifted ${ids.length} rows, lifted ${lifted.moved}`);

        const early = await retention.purge(collection, new Date(0).toISOString() as IsoDateTime);
        assert(early.purged === 0, `a purge cutoff predating the sweep should destroy nothing, destroyed ${early.purged}`);

        const past = new Date(Date.now() + 60_000).toISOString() as IsoDateTime;
        const destroyed = await retention.purge(collection, past);
        assert(destroyed.purged === ids.length, `the purge should report the ${ids.length} rows it destroyed, reported ${destroyed.purged}`);
        const again = await retention.purge(collection, past);
        assert(again.purged === 0, `a second purge reported ${again.purged} rows a first one had already destroyed`);
      }),

      // =====================================================================
      // status
      // =====================================================================

      opsCase(opts, "status() returns a valid StoreWireStatus", async (ops) => {
        const status = await ops.status();
        assert(status.format === VENDO_STORE_WIRE_FORMAT, `status.format should be ${VENDO_STORE_WIRE_FORMAT}`);
        assert(typeof status.ops === "number", "status.ops should be a number");
        // `ops` is a LEVEL over STORE_WIRE_PATHS' declared order, not an
        // inventory, so there is no single right number to assert: three honest
        // implementations report three (the local engine stops short of the two
        // retention ops, the memory reference has no batch append). This case
        // used to pin the count exactly, which only held while every mount was
        // the same vintage — it would now fail two implementations that are
        // telling the truth. What IS contract is the ceiling and the one
        // question a client asks the level.
        const declared = Object.keys(STORE_WIRE_PATHS).length;
        assert(status.ops <= declared, `a mount cannot serve more than the ${declared} declared ops, got ${status.ops}`);
        // The level's ONE contract use, and the only way it breaks a client: a
        // caller feature-detects the batch append on this number alone, so a
        // mount claiming the level must serve the op, and one serving the op
        // must claim the level.
        assert(
          (status.ops >= STORE_WIRE_APPEND_MESSAGES_OPS) === (ops.transcripts.appendMessages !== undefined),
          `status.ops ${status.ops} disagrees with transcripts.appendMessages being `
          + `${ops.transcripts.appendMessages === undefined ? "absent" : "served"} `
          + `(the batch append is op ${STORE_WIRE_APPEND_MESSAGES_OPS})`,
        );
      }),
    ],
  };
}
