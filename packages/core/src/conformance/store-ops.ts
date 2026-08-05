import type { VendoErrorCode } from "../errors.js";
import { isoDateTimeSchema } from "../ids.js";
import { canonicalJson } from "../jcs.js";
import { VENDO_STORE_WIRE_FORMAT } from "../store-wire.js";
import type { StoreOps } from "../store.js";
import type { ConformanceCase, ConformanceSuite } from "./index.js";

// ---------------------------------------------------------------------------
// helpers (mirrors the ones in index.ts — keep conformance self-contained)
// ---------------------------------------------------------------------------

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Canonical (key-order-insensitive) equality: Postgres jsonb normalizes
    object key order, so a byte-for-byte JSON.stringify comparison would fail
    every jsonb-backed implementation on a semantically identical value. */
const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  const a = actual === undefined ? "undefined" : canonicalJson(actual);
  const b = expected === undefined ? "undefined" : canonicalJson(expected);
  assert(a === b, `${message}: ${a} !== ${b}`);
};

const assertBytesEqual = (actual: Uint8Array, expected: Uint8Array, message: string): void => {
  assert(actual.length === expected.length, `${message}: byte lengths differ`);
  for (let i = 0; i < actual.length; i += 1) {
    assert(actual[i] === expected[i], `${message}: byte ${i} differs`);
  }
};

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
    `workspace.history` type their entries as `unknown`, but `undo(commitId)`
    has no other way to learn a commit id, so the field is contract, not shape
    guessing. */
const stringField = (entry: unknown, field: string, message: string): string => {
  const value = (entry as Record<string, unknown> | null)?.[field];
  assert(typeof value === "string", `${message}: entry ${JSON.stringify(entry)} has no string "${field}"`);
  return value;
};

/** A thread's harness state rides the harness slot under this synthetic appId
    (the store's `harnessStateKey`), which is what makes deleteThread's cascade
    onto harness state observable through the 32 ops. */
const harnessSlot = (threadId: string): string => `harness_state:${threadId}`;

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
      // records
      // =====================================================================

      opsCase(opts, "records.put echoes fields and stamps ISO timestamps", async (ops) => {
        const input = { id: "put_echo", data: { nested: [1, "two"] }, refs: { owner: "user_1" } };
        const record = await ops.records.put("conf_put", input);
        assert(record.id === input.id, "put did not echo the record id");
        assertDeepEqual(record.data, input.data, "put did not echo record data");
        assertDeepEqual(record.refs, input.refs, "put did not echo record refs");
        isoDateTimeSchema.parse(record.createdAt);
        isoDateTimeSchema.parse(record.updatedAt);
      }),

      opsCase(opts, "records.get round-trips a put record", async (ops) => {
        const put = await ops.records.put("conf_get", { id: "rt", data: { ok: true }, refs: { h: "1" } });
        const got = await ops.records.get("conf_get", "rt");
        assertDeepEqual(got, put, "get did not round-trip the stored record");
      }),

      opsCase(opts, "records.get missing returns null", async (ops) => {
        assert(await ops.records.get("conf_miss", "absent") === null, "missing record did not return null");
      }),

      opsCase(opts, "records.put same id updates without timestamp regression", async (ops) => {
        const first = await ops.records.put("conf_upd", { id: "s", data: { v: 1 }, refs: { o: "a" } });
        const second = await ops.records.put("conf_upd", { id: "s", data: { v: 2 }, refs: { o: "b" } });
        assertDeepEqual(second.data, { v: 2 }, "update did not replace data");
        assertDeepEqual(second.refs, { o: "b" }, "update did not replace refs");
        assert(second.createdAt === first.createdAt, "update changed createdAt");
        assert(second.updatedAt >= first.updatedAt, "updatedAt regressed");
      }),

      opsCase(opts, "records.delete makes get return null", async (ops) => {
        await ops.records.put("conf_del", { id: "del", data: {} });
        await ops.records.delete("conf_del", "del");
        assert(await ops.records.get("conf_del", "del") === null, "deleted record remained readable");
      }),

      opsCase(opts, "records.delete missing resolves", async (ops) => {
        await ops.records.delete("conf_delmiss", "absent");
      }),

      opsCase(opts, "records.list returns everything put", async (ops) => {
        for (const id of ["a", "b", "c"]) await ops.records.put("conf_la", { id, data: { id } });
        const result = await ops.records.list("conf_la");
        assertDeepEqual(result.records.map((r) => r.id).sort(), ["a", "b", "c"], "list omitted or added records");
      }),

      opsCase(opts, "records.list ids filters exactly", async (ops) => {
        for (const id of ["ia", "ib", "ic"]) await ops.records.put("conf_li", { id, data: { id } });
        const result = await ops.records.list("conf_li", { ids: ["ia", "ic"] });
        assertDeepEqual(result.records.map((r) => r.id).sort(), ["ia", "ic"], "ids filter returned the wrong records");
      }),

      opsCase(opts, "records.list refs filters by exact containment", async (ops) => {
        await ops.records.put("conf_lr", { id: "match", data: {}, refs: { owner: "one", kind: "inv" } });
        await ops.records.put("conf_lr", { id: "wrong", data: {}, refs: { owner: "two", kind: "inv" } });
        await ops.records.put("conf_lr", { id: "miss", data: {}, refs: { owner: "one" } });
        const result = await ops.records.list("conf_lr", { refs: { owner: "one", kind: "inv" } });
        assertDeepEqual(result.records.map((r) => r.id), ["match"], "refs filter was not exact key/value containment");
      }),

      opsCase(opts, "records.list limit and cursor paginate without loss or duplicates", async (ops) => {
        const expected = ["pa", "pb", "pc", "pd", "pe"];
        for (const id of expected) await ops.records.put("conf_pg", { id, data: { id } });
        await assertPaginates("records.list", expected, async (cursor) => {
          const page = await ops.records.list("conf_pg", { limit: PAGE, cursor });
          return { ids: page.records.map((r) => r.id), cursor: page.cursor };
        });
      }),

      opsCase(opts, "records.list repeats an identical query in the same order", async (ops) => {
        for (const id of ["da", "db", "dc", "dd"]) await ops.records.put("conf_det", { id, data: { id } });
        const first = await ops.records.list("conf_det");
        const repeat = await ops.records.list("conf_det");
        assertDeepEqual(repeat.records.map((r) => r.id), first.records.map((r) => r.id), "identical list calls returned different orders");
        const firstPage = await ops.records.list("conf_det", { limit: PAGE });
        const repeatPage = await ops.records.list("conf_det", { limit: PAGE });
        assertDeepEqual(repeatPage.records.map((r) => r.id), firstPage.records.map((r) => r.id), "identical first pages returned different records");
        assert(repeatPage.cursor === firstPage.cursor, "identical first pages returned different cursors");
      }),

      /** Store wire v1: every list op defaults to 100 per page and caps at 1000. */
      opsCase(opts, "records.list defaults to 100 per page and refuses or clamps a limit above 1000", async (ops) => {
        const ids = Array.from({ length: 101 }, (_, i) => `cap_${String(i).padStart(3, "0")}`);
        for (const id of ids) await ops.records.put("conf_cap", { id, data: { id } });
        const defaulted = await ops.records.list("conf_cap");
        assert(defaulted.records.length === 100, `the default page should hold 100 records, got ${defaulted.records.length}`);
        assert(defaulted.cursor !== undefined, "a truncated default page must return a cursor");
        const overMax = await ops.records.list("conf_cap", { limit: 5000 }).catch((error: unknown) => {
          assert((error as { code?: unknown }).code === "validation", `a limit above the 1000 max must be refused as validation, got ${String(error)}`);
          return null;
        });
        if (overMax !== null) assert(overMax.records.length <= 1000, "an accepted over-max limit was not clamped to 1000");
      }),

      opsCase(opts, "records.claim returns true on match, false on mismatch", async (ops) => {
        await ops.records.put("conf_cl", { id: "cl1", data: { v: 1 }, refs: { o: "a" } });
        const miss = await ops.records.claim("conf_cl", { id: "cl1", data: { v: 999 } });
        assert(miss === false, "claim should return false on mismatch");
        const hit = await ops.records.claim("conf_cl", { id: "cl1", data: { v: 1 }, refs: { o: "a" } }, { data: { v: 2 }, refs: { o: "b" } });
        assert(hit === true, "claim should return true on match");
        const after = await ops.records.get("conf_cl", "cl1");
        assertDeepEqual(after?.data, { v: 2 }, "claim did not apply replacement");
      }),

      opsCase(opts, "records.insertIfAbsent returns record on first call, null on second", async (ops) => {
        const first = await ops.records.insertIfAbsent("conf_iia", { id: "iia1", data: { n: 1 } });
        assert(first !== null, "insertIfAbsent first call should return a record");
        assert(first!.id === "iia1", "insertIfAbsent did not echo id");
        const second = await ops.records.insertIfAbsent("conf_iia", { id: "iia1", data: { n: 2 } });
        assert(second === null, "insertIfAbsent second call should return null");
        // original data unchanged
        const got = await ops.records.get("conf_iia", "iia1");
        assertDeepEqual(got?.data, { n: 1 }, "insertIfAbsent overwrote existing record");
      }),

      opsCase(opts, "records.compareAndSwap succeeds on matching revision, null on stale", async (ops) => {
        const created = await ops.records.put("conf_cas", { id: "cas1", data: { v: 1 } });
        assert(created.revision, "put must return a revision for CAS");
        const swapped = await ops.records.compareAndSwap("conf_cas", { id: "cas1", data: { v: 2 } }, created.revision!);
        assert(swapped !== null, "compareAndSwap should succeed on matching revision");
        assertDeepEqual(swapped!.data, { v: 2 }, "compareAndSwap did not update data");
        const stale = await ops.records.compareAndSwap("conf_cas", { id: "cas1", data: { v: 3 } }, created.revision!);
        assert(stale === null, "compareAndSwap should return null on stale revision");
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

      opsCase(opts, "workspace.undo restores the values its commit replaced", async (ops) => {
        await ops.workspace.commit([{ path: "undo.json", data: { v: 1 } }]);
        const before = new Set((await ops.workspace.history()).entries
          .map((entry) => stringField(entry, "commitId", "workspace.history")));
        await ops.workspace.commit([{ path: "undo.json", data: { v: 2 } }]);
        const added = (await ops.workspace.history()).entries
          .map((entry) => stringField(entry, "commitId", "workspace.history"))
          .filter((id) => !before.has(id));
        assert(added.length === 1, `one commit should have been added to history, got ${added.length}`);
        await ops.workspace.undo(added[0]!);
        assertDeepEqual(
          (await ops.workspace.read(["undo.json"]))["undo.json"],
          { v: 1 },
          "undo did not restore the value its commit replaced",
        );
        await assertThrowsCode(() => ops.workspace.undo("commit_absent"), "not-found", "undoing an unknown commit");
      }),

      // =====================================================================
      // lifecycle
      // =====================================================================

      opsCase(opts, "lifecycle.erase removes one subject's records, threads, harness state, and session", async (ops) => {
        await ops.records.put("conf_erase", { id: "gone", data: {}, refs: { subject: "erase_me" } });
        await ops.records.put("conf_erase", { id: "keep", data: {}, refs: { subject: "other" } });
        await ops.transcripts.putThread({ id: "thr_erase", subject: "erase_me", messages: [] });
        await ops.transcripts.putThread({ id: "thr_keep", subject: "other", messages: [] });
        await ops.harness.set("app_erase", "erase_me", { v: 1 });
        await ops.lifecycle.sessionRegister("erase_me", 1000);

        const report = await ops.lifecycle.erase({ subject: "erase_me" });
        assert(report !== null && report !== undefined, "erase must return a report");
        assert(await ops.records.get("conf_erase", "gone") === null, "erase left the subject's record behind");
        assert(await ops.records.get("conf_erase", "keep") !== null, "erase removed another subject's record");
        assert(await ops.transcripts.getThread("thr_erase") === null, "erase left the subject's thread behind");
        assert(await ops.transcripts.getThread("thr_keep") !== null, "erase removed another subject's thread");
        assert(await ops.harness.get("app_erase", "erase_me") === null, "erase left the subject's harness state behind");
        assertDeepEqual(await ops.lifecycle.sessionStale(1, 100000), [], "erase left the subject's session registered");
      }),

      opsCase(opts, "lifecycle.adopt moves records, threads, harness state, and the session", async (ops) => {
        await ops.records.put("conf_adopt", { id: "moved", data: {}, refs: { subject: "anon_1" } });
        await ops.transcripts.putThread({ id: "thr_adopt", subject: "anon_1", messages: [] });
        await ops.harness.set("app_adopt", "anon_1", { v: 7 });
        await ops.lifecycle.sessionRegister("anon_1", 1000);

        const report = await ops.lifecycle.adopt("anon_1", "user_1");
        assert(report !== null && report !== undefined, "adopt must return a report");
        assertDeepEqual(
          (await ops.records.list("conf_adopt", { refs: { subject: "user_1" } })).records.map((r) => r.id),
          ["moved"],
          "adopt did not move the record to the new subject",
        );
        assertDeepEqual(
          (await ops.records.list("conf_adopt", { refs: { subject: "anon_1" } })).records.map((r) => r.id),
          [],
          "adopt left the record on the old subject",
        );
        assertDeepEqual(
          (await ops.transcripts.listThreads({ subject: "user_1" })).records.map((r) => r.id),
          ["thr_adopt"],
          "adopt did not move the thread to the new subject",
        );
        assertDeepEqual(
          (await ops.transcripts.listThreads({ subject: "anon_1" })).records.map((r) => r.id),
          [],
          "adopt left the thread on the old subject",
        );
        assertDeepEqual(await ops.harness.get("app_adopt", "user_1"), { v: 7 }, "adopt did not move harness state");
        assert(await ops.harness.get("app_adopt", "anon_1") === null, "adopt left harness state on the old subject");
        assertDeepEqual(await ops.lifecycle.sessionStale(1, 100000), ["user_1"], "adopt did not move the session registration");
      }),

      /** Promote hands the app to an org: the app record's owning subject
          BECOMES the org id (02-store §9.5), which is the move's only
          observable through the ops surface. */
      opsCase(opts, "lifecycle.promote hands the app record to the org; an unknown app is not-found", async (ops) => {
        // A SHAPE-VALID app record: vendo_apps is a typed door, and a real
        // backend refuses data that does not parse as {subject, enabled, doc}.
        await ops.records.put("vendo_apps", {
          id: "app_promote",
          data: {
            subject: "user_1",
            enabled: true,
            doc: { format: "vendo/app@1", id: "app_promote", name: "Promoted" },
          },
          refs: { subject: "user_1" },
        });
        await ops.lifecycle.promote("app_promote", "org_1");
        const promoted = await ops.records.get("vendo_apps", "app_promote");
        assert(
          promoted?.refs?.["subject"] === "org_1",
          `promote should hand the app to the org, got subject ${String(promoted?.refs?.["subject"])}`,
        );
        await assertThrowsCode(() => ops.lifecycle.promote("app_absent", "org_1"), "not-found", "promoting an unknown app");
      }),

      opsCase(opts, "lifecycle.sessionRegister and sessionStale work together", async (ops) => {
        const now = 1000000;
        await ops.lifecycle.sessionRegister("stale_1", now - 5000);
        await ops.lifecycle.sessionRegister("fresh_1", now);
        const stale = await ops.lifecycle.sessionStale(3000, now);
        assert(stale.includes("stale_1"), "stale session not returned");
        assert(!stale.includes("fresh_1"), "fresh session incorrectly returned as stale");
      }),

      opsCase(opts, "lifecycle.sessionClaim claims a stale subject", async (ops) => {
        const now = 1000000;
        await ops.lifecycle.sessionRegister("claim_1", now - 5000);
        const claimed = await ops.lifecycle.sessionClaim("claim_1", 3000, now);
        assert(claimed === true, "sessionClaim should return true for stale session");
        const again = await ops.lifecycle.sessionClaim("claim_1", 3000, now);
        assert(again === false, "sessionClaim should return false after already claimed");
      }),

      // =====================================================================
      // status
      // =====================================================================

      opsCase(opts, "status() returns a valid StoreWireStatus", async (ops) => {
        const status = await ops.status();
        assert(status.format === VENDO_STORE_WIRE_FORMAT, `status.format should be ${VENDO_STORE_WIRE_FORMAT}`);
        assert(typeof status.ops === "number", "status.ops should be a number");
        assert(status.ops === 32, `status.ops should be 32, got ${status.ops}`);
      }),
    ],
  };
}
