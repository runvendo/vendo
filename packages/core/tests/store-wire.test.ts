import { describe, expect, it } from "vitest";
import {
  STORE_WIRE_PATHS,
  STORE_WIRE_STATUS_BY_CODE,
  VENDO_STORE_WIRE_FORMAT,
  VendoError,
  storeWireErrorBody,
  storeWireErrorSchema,
  storeWireStatusSchema,
  parseStoreWireError,
  storeWireCollectionGetRequestSchema,
  storeWireCollectionPutRequestSchema,
  storeWireCollectionDeleteRequestSchema,
  storeWireCollectionListRequestSchema,
  storeWireCollectionClaimRequestSchema,
  storeWireCollectionInsertIfAbsentRequestSchema,
  storeWireCollectionCompareAndSwapRequestSchema,
  storeWireBlobsPutRequestSchema,
  storeWireBlobsGetRequestSchema,
  storeWireBlobsDeleteRequestSchema,
  storeWireBlobsListRequestSchema,
  storeWireAppDataPutRequestSchema,
  storeWireAppDataGetRequestSchema,
  storeWireAppDataListRequestSchema,
  storeWireAppDataDeleteRequestSchema,
  storeWireAppDataPutFileRequestSchema,
  storeWireAppDataGetFileRequestSchema,
  storeWireAppDataListFilesRequestSchema,
  storeWireAppDataDeleteFileRequestSchema,
  storeWireTranscriptsPutThreadRequestSchema,
  storeWireTranscriptsGetThreadRequestSchema,
  storeWireTranscriptsListThreadsRequestSchema,
  storeWireTranscriptsDeleteThreadRequestSchema,
  storeWireTranscriptsPutMessageRequestSchema,
  storeWireTranscriptsAppendMessagesRequestSchema,
  storeWireTranscriptsRecordAnswerRequestSchema,
  storeWireHarnessGetRequestSchema,
  storeWireHarnessSetRequestSchema,
  storeWireHarnessClearRequestSchema,
  storeWireWorkspaceIndexRequestSchema,
  storeWireWorkspaceReadRequestSchema,
  storeWireWorkspaceCommitRequestSchema,
  storeWireWorkspaceHistoryRequestSchema,
  storeWireLifecycleEraseRequestSchema,
  storeWireLifecyclePromoteRequestSchema,
  storeWireAuditTallyRequestSchema,
  storeWireUsageCountRequestSchema,
  type EraseTarget,
  type StoreWireStatus,
} from "../src/index.js";

describe("vendo/store-wire@1", () => {
  it("exposes the format constant and 50 mount-relative paths", () => {
    expect(VENDO_STORE_WIRE_FORMAT).toBe("vendo/store-wire@1");
    // 14 families: engine(7) + blobs(4) + appData(8) + transcripts(7) + harness(3)
    // + workspace(4) + lifecycle(2) + audit(2) + secrets(4) + footprint(1)
    // + retention(2) + status(1) + usage(3) + turn(2) = 50
    expect(Object.keys(STORE_WIRE_PATHS)).toHaveLength(50);
    expect(STORE_WIRE_PATHS.status).toBe("/status");
    expect(STORE_WIRE_PATHS["engine.get"]).toBe("/engine/get");
    expect(STORE_WIRE_PATHS["engine.compareAndSwap"]).toBe("/engine/compareAndSwap");
    expect(STORE_WIRE_PATHS["appData.put"]).toBe("/app-data/put");
    expect(STORE_WIRE_PATHS["lifecycle.promote"]).toBe("/lifecycle/promote");
    // erase is the one door NOT under its family prefix: it shipped at /erase
    // before the wire had families and every mount serves it there. The
    // manifest records the door that EXISTS — a prettier path here would be a
    // route no client calls and no service answers.
    expect(STORE_WIRE_PATHS["lifecycle.erase"]).toBe("/erase");
  });

  // `ops` on /status is a LEVEL over this order, so an implementation that
  // stops short of the newest ops can only report an honest number when those
  // ops are the tail. The turn family is the newest one no mount answers yet,
  // and it sits behind everything a shipped mount already serves — as usage,
  // retention and the audit tally did before it.
  it("declares the ops nothing serves yet LAST, so the /status level can stay honest", () => {
    const ops = Object.keys(STORE_WIRE_PATHS).filter((op) => op !== "status");
    expect(ops.slice(-8)).toEqual([
      "retention.quarantine",
      "retention.purge",
      "audit.tally",
      "usage.record",
      "usage.count",
      "usage.tally",
      "turn.load",
      "turn.commit",
    ]);
  });

  // The rule the tail exists for, stated as the thing that would break: a new op
  // may only be APPENDED. Slot one in the middle and every number a mount is
  // already reporting silently starts naming a different op — the renumbering
  // hazard STORE_WIRE_APPEND_MESSAGES_OPS is pinned against, arriving from the
  // other side. `status` was the 44th op when it was last the end of this list,
  // and a mount reporting 44 means "everything through /status" forever.
  it("keeps every already-reported level meaning what it meant, by only ever appending", () => {
    const ops = Object.keys(STORE_WIRE_PATHS);
    expect(ops.indexOf("status") + 1).toBe(44);
    expect(ops.indexOf("audit.tally") + 1).toBe(45);
  });

  // The tally is the one read in this protocol with a REQUIRED argument, and
  // the requirement is the whole design: there is no cursor to page a tally, so
  // `from` is the only thing bounding what a mount groups. A body without one
  // asks it to group an append-only drawer's entire history.
  it("audit.tally's body carries the four filters and refuses to be sent without its floor", () => {
    const tally = (body: unknown): boolean => storeWireAuditTallyRequestSchema.safeParse(body).success;
    expect(tally({ from: "2026-08-14T00:00:00.000Z" })).toBe(true);
    expect(tally({ from: "2026-08-14T00:00:00.000Z", kind: "tool-call", venue: "chat", outcome: "ok", decidedBy: "grant" })).toBe(true);
    expect(tally({ kind: "tool-call" })).toBe(false);
    // A real datetime, unlike a watermark's opaque echo: this is a window the
    // caller authored, not a value it read back off a page.
    expect(tally({ from: "yesterday" })).toBe(false);
    // The same four enums as the feed, refused the same way — one copy of them
    // on the wire, so the two doors cannot come to narrow differently.
    expect(tally({ from: "2026-08-14T00:00:00.000Z", outcome: "allowed" })).toBe(false);
  });

  // The meter's count is either a person's or a pool's, and a body carrying
  // both is two different numbers under one name — the same rule `lifecycle.erase`
  // is refused by, and for the same reason: there is no sensible precedence a
  // caller could have guessed.
  it("usage.count's body names exactly one of subject or poolKey, over a required floor", () => {
    const count = (body: unknown): boolean => storeWireUsageCountRequestSchema.safeParse(body).success;
    const window = { action: "message", since: "2026-08-14T00:00:00.000Z" };
    expect(count({ ...window, subject: "user_1" })).toBe(true);
    expect(count({ ...window, poolKey: "team_1", until: "2026-08-15T00:00:00.000Z" })).toBe(true);
    expect(count({ ...window, subject: "user_1", poolKey: "team_1" })).toBe(false);
    expect(count(window)).toBe(false);
    // `since` is the only bound on a drawer that only ever grows, so a body
    // without one is refused rather than answered from the beginning of time.
    expect(count({ action: "message", subject: "user_1" })).toBe(false);
    // The action is the unit a host sells in, and an unknown one is a caller
    // bug this build cannot silently widen to.
    expect(count({ ...window, action: "tokens", subject: "user_1" })).toBe(false);
  });

  describe("engine.list's watermark bound", () => {
    const list = (query: unknown): boolean =>
      storeWireCollectionListRequestSchema.safeParse({ collection: "vendo_runs", query }).success;

    it("takes a watermark alongside the ordinary query fields", () => {
      expect(list({ watermark: { field: "started_at", after: "2026-08-14T00:00:00.000Z" }, limit: 50 })).toBe(true);
    });

    // A cursor walks newest-first from its own position and a watermark walks
    // oldest-first from its bound. A body carrying both is asking for two
    // different pages at once, and any precedence rule the mount picked would be
    // one the caller could not have guessed — so neither is honored.
    it("refuses a body that carries a watermark AND a cursor", () => {
      expect(list({ watermark: { field: "started_at", after: "2026-08-14T00:00:00.000Z" }, cursor: "cur_1" })).toBe(false);
    });

    // The bound is echoed back verbatim from a previous page and can carry more
    // precision than an ISO-with-milliseconds string keeps. Validating it as a
    // datetime would re-encode it, and a bound that loses precision moves
    // BACKWARDS — which re-reads a window a caller had already counted.
    it("takes the bound as an opaque string, not a datetime", () => {
      expect(list({ watermark: { field: "started_at", after: "2026-08-14 00:00:00.123456+00" } })).toBe(true);
      expect(list({ watermark: { field: "started_at", after: "" } })).toBe(false);
    });
  });

  it("every engine door is its own path, and no route is left on the retired generic family", () => {
    const verbs = ["get", "put", "delete", "list", "claim", "insertIfAbsent", "compareAndSwap"] as const;
    for (const verb of verbs) {
      expect(STORE_WIRE_PATHS[`engine.${verb}`]).toBe(`/engine/${verb}`);
    }
    // The hard cut: no op name and no path may lead back to /records/*.
    for (const [op, path] of Object.entries(STORE_WIRE_PATHS)) {
      expect(op.startsWith("records."), `${op} is a retired generic records op`).toBe(false);
      expect(path.startsWith("/records/"), `${op} still routes to ${path}`).toBe(false);
    }
    const enginePaths = Object.entries(STORE_WIRE_PATHS)
      .filter(([op]) => op.startsWith("engine."))
      .map(([, path]) => path);
    expect(enginePaths).toHaveLength(7);
    expect(enginePaths.every((path) => path.startsWith("/engine/"))).toBe(true);
  });

  it("parses collection-addressed request DTOs and rejects invalid ones", () => {
    expect(storeWireCollectionGetRequestSchema.parse({ collection: "users", id: "u1" }).id).toBe("u1");
    expect(storeWireCollectionGetRequestSchema.safeParse({ collection: "", id: "u1" }).success).toBe(false);

    expect(storeWireCollectionPutRequestSchema.parse({
      collection: "users",
      record: { id: "u1", data: { name: "Alice" } },
    }).record.id).toBe("u1");
    expect(storeWireCollectionPutRequestSchema.safeParse({ collection: "users" }).success).toBe(false);

    expect(storeWireCollectionDeleteRequestSchema.parse({ collection: "users", id: "u1" }).collection).toBe("users");

    expect(storeWireCollectionListRequestSchema.parse({ collection: "users" }).collection).toBe("users");
    expect(storeWireCollectionListRequestSchema.parse({
      collection: "users",
      query: { refs: { org: "o1" }, limit: 50 },
    }).query?.limit).toBe(50);

    expect(storeWireCollectionClaimRequestSchema.parse({
      collection: "users",
      expected: { id: "u1", data: { status: "free" } },
      replacement: { data: { status: "claimed" } },
    }).expected.id).toBe("u1");

    expect(storeWireCollectionInsertIfAbsentRequestSchema.parse({
      collection: "users",
      record: { id: "u2", data: {} },
    }).record.id).toBe("u2");

    expect(storeWireCollectionCompareAndSwapRequestSchema.parse({
      collection: "users",
      record: { id: "u1", data: {} },
      expectedRevision: "rev_1",
    }).expectedRevision).toBe("rev_1");
    expect(storeWireCollectionCompareAndSwapRequestSchema.safeParse({
      collection: "users",
      record: { id: "u1", data: {} },
      expectedRevision: "",
    }).success).toBe(false);
  });

  it("parses blobs request DTOs — bytes are base64 on the wire", () => {
    expect(storeWireBlobsPutRequestSchema.parse({
      namespace: "avatars",
      key: "u1.png",
      bytes: btoa("fake-image"),
      contentType: "image/png",
    }).contentType).toBe("image/png");
    expect(storeWireBlobsPutRequestSchema.safeParse({ namespace: "", key: "k", bytes: "x" }).success).toBe(false);

    expect(storeWireBlobsGetRequestSchema.parse({ namespace: "avatars", key: "u1.png" }).key).toBe("u1.png");
    expect(storeWireBlobsDeleteRequestSchema.parse({ namespace: "avatars", key: "u1.png" }).namespace).toBe("avatars");
    expect(storeWireBlobsListRequestSchema.parse({ namespace: "avatars", prefix: "u1" }).prefix).toBe("u1");
  });

  it("parses appData request DTOs — the collection grammar and the owner stamp bite", () => {
    const target = { appId: "app_1", collection: "invoices", owner: "sub_1" };

    expect(storeWireAppDataPutRequestSchema.parse({
      target,
      record: { id: "inv1", data: { total: 42 } },
    }).record.id).toBe("inv1");
    expect(storeWireAppDataGetRequestSchema.parse({ target, id: "inv1" }).id).toBe("inv1");
    expect(storeWireAppDataListRequestSchema.parse({
      target: { ...target, collection: "box:notes" },
      query: { limit: 50 },
    }).query?.limit).toBe(50);
    expect(storeWireAppDataDeleteRequestSchema.parse({ target, id: "inv1" }).target.appId).toBe("app_1");

    expect(storeWireAppDataPutFileRequestSchema.parse({
      target,
      key: "sub_1/scan.png",
      bytes: btoa("fake-image"),
      contentType: "image/png",
    }).contentType).toBe("image/png");
    expect(storeWireAppDataGetFileRequestSchema.parse({ target, key: "sub_1/scan.png" }).key).toBe("sub_1/scan.png");
    expect(storeWireAppDataListFilesRequestSchema.parse({ target, prefix: "sub_1/" }).prefix).toBe("sub_1/");
    expect(storeWireAppDataDeleteFileRequestSchema.parse({ target, key: "sub_1/scan.png" }).key).toBe("sub_1/scan.png");

    // Generated code invents collection names, so the grammar is the fence.
    expect(storeWireAppDataGetRequestSchema.safeParse({
      target: { ...target, collection: "has spaces" }, id: "inv1",
    }).success).toBe(false);
    expect(storeWireAppDataGetRequestSchema.safeParse({
      target: { ...target, collection: "a/b" }, id: "inv1",
    }).success).toBe(false);
    // The runtime always stamps an owner; an unstamped target is not a request.
    expect(storeWireAppDataGetRequestSchema.safeParse({
      target: { ...target, owner: "" }, id: "inv1",
    }).success).toBe(false);
  });

  /** The owner is the first path segment of every appData file key, so a "/"
      in it is a second key segment: owner "sub_1/scan" reading "png" is owner
      "sub_1" reading "scan/png". Not a slug grammar though — a subject is the
      host's own user id in the host's own spelling, and "auth0|…" and
      "user:with:colons" are contract elsewhere in this repo. */
  it("refuses an appData owner containing a slash, and keeps every other spelling", () => {
    const target = { appId: "app_1", collection: "invoices", owner: "sub_1" };
    for (const owner of ["sub_1/scan", "/sub_1", "sub_1/", "a/b/c"]) {
      expect(
        storeWireAppDataGetRequestSchema.safeParse({ target: { ...target, owner }, id: "inv1" }).success,
        `owner ${JSON.stringify(owner)} should be refused`,
      ).toBe(false);
      expect(
        storeWireAppDataPutFileRequestSchema.safeParse({ target: { ...target, owner }, key: "scan.png", bytes: btoa("x") }).success,
        `owner ${JSON.stringify(owner)} should be refused on putFile`,
      ).toBe(false);
    }
    for (const owner of ["auth0|64f0", "user:with:colons", "person@example.com", "own_a"]) {
      expect(
        storeWireAppDataGetRequestSchema.parse({ target: { ...target, owner }, id: "inv1" }).target.owner,
      ).toBe(owner);
    }
  });

  it("parses transcripts request DTOs", () => {
    expect(storeWireTranscriptsPutThreadRequestSchema.parse({
      thread: { id: "t1", subject: "sub_user1", messages: [{ role: "user", content: "hi" }] },
    }).thread.id).toBe("t1");
    expect(storeWireTranscriptsPutThreadRequestSchema.safeParse({
      thread: { id: "", subject: "s", messages: [] },
    }).success).toBe(false);

    // An id and nothing else. The `cursor`/`limit` this schema used to declare
    // were a windowing request the answer has no room to page with, so no mount
    // ever honored them; an older client still sending them is READ, not
    // refused, which is what `.passthrough()` buys.
    expect(storeWireTranscriptsGetThreadRequestSchema.parse({ id: "t1" }).id).toBe("t1");
    expect("limit" in storeWireTranscriptsGetThreadRequestSchema.shape).toBe(false);
    expect(storeWireTranscriptsGetThreadRequestSchema.safeParse({ id: "t1", limit: 50 }).success).toBe(true);
    expect(storeWireTranscriptsListThreadsRequestSchema.parse({ subject: "sub_user1" }).subject).toBe("sub_user1");
    expect(storeWireTranscriptsDeleteThreadRequestSchema.parse({ id: "t1" }).id).toBe("t1");
    expect(storeWireTranscriptsPutMessageRequestSchema.parse({ threadId: "t1", message: { role: "user", content: "test" } }).threadId).toBe("t1");
    expect(storeWireTranscriptsRecordAnswerRequestSchema.parse({ threadId: "t1", answer: { text: "done" } }).threadId).toBe("t1");

    expect(storeWireTranscriptsAppendMessagesRequestSchema.parse({
      threadId: "t1", subject: "sub_user1", messages: [{ id: "m1" }], title: "Hi",
    }).subject).toBe("sub_user1");
    // The subject IS the ownership check on this op — a body without one would
    // ask the service to append to whichever thread holds the id.
    expect(storeWireTranscriptsAppendMessagesRequestSchema.safeParse({
      threadId: "t1", messages: [{ id: "m1" }],
    }).success).toBe(false);
    expect(storeWireTranscriptsAppendMessagesRequestSchema.safeParse({
      threadId: "t1", subject: "sub_user1", messages: [],
    }).success).toBe(false);
  });

  it("parses harness request DTOs", () => {
    expect(storeWireHarnessGetRequestSchema.parse({ appId: "app_1", subject: "sub_1" }).appId).toBe("app_1");
    expect(storeWireHarnessSetRequestSchema.parse({ appId: "app_1", subject: "sub_1", state: { step: 3 } }).state).toEqual({ step: 3 });
    expect(storeWireHarnessClearRequestSchema.parse({ appId: "app_1", subject: "sub_1" }).subject).toBe("sub_1");
    expect(storeWireHarnessClearRequestSchema.safeParse({ appId: "", subject: "s" }).success).toBe(false);
  });

  it("parses workspace request DTOs", () => {
    expect(storeWireWorkspaceIndexRequestSchema.parse({ limit: 100 }).limit).toBe(100);
    expect(storeWireWorkspaceReadRequestSchema.parse({ paths: ["/a.md"] }).paths).toEqual(["/a.md"]);
    expect(storeWireWorkspaceReadRequestSchema.safeParse({ paths: [] }).success).toBe(false);
    expect(storeWireWorkspaceCommitRequestSchema.parse({ entries: [{ path: "/a.md", content: "hi" }] }).entries).toHaveLength(1);
    expect(storeWireWorkspaceHistoryRequestSchema.parse({ cursor: "c1" }).cursor).toBe("c1");
  });

  it("parses lifecycle request DTOs", () => {
    // The erase body is FLAT — the scope rides the body itself, not a `target`
    // wrapper, which is what every shipped mount reads and every client sends.
    expect(storeWireLifecycleEraseRequestSchema.parse({ subject: "sub_1" }).subject).toBe("sub_1");
    expect(storeWireLifecycleEraseRequestSchema.parse({ appId: "app_1" }).appId).toBe("app_1");
    // A destructive erase must name exactly one scope: no empty body...
    expect(storeWireLifecycleEraseRequestSchema.safeParse({}).success).toBe(false);
    // ...and no ambiguous both-set body.
    expect(storeWireLifecycleEraseRequestSchema.safeParse({ subject: "sub_1", appId: "app_1" }).success).toBe(false);
    expect(storeWireLifecycleEraseRequestSchema.safeParse({ subject: "" }).success).toBe(false);
    // A wrapped target names no scope at all, so it is not an erase request.
    expect(storeWireLifecycleEraseRequestSchema.safeParse({ target: { subject: "sub_1" } }).success).toBe(false);
    expect(storeWireLifecyclePromoteRequestSchema.parse({ appId: "app_1", orgId: "org_1" }).orgId).toBe("org_1");
  });

  it("the erase target is a compile-time discriminated selector", () => {
    const check = (target: EraseTarget) => target;
    expect(check({ subject: "sub_1" }).subject).toBe("sub_1");
    expect(check({ appId: "app_1" }).appId).toBe("app_1");
    // @ts-expect-error a destructive erase must name a scope — {} is not a target
    check({});
    // @ts-expect-error exactly one scope: subject and appId cannot both be set
    check({ subject: "sub_1", appId: "app_1" });
  });

  it("status doubles as the discovery handshake: format + ops count", () => {
    const status: StoreWireStatus = {
      format: VENDO_STORE_WIRE_FORMAT,
      ops: 35,
    };
    expect(storeWireStatusSchema.parse(status).ops).toBe(35);
    // An older mount still sending fields this build dropped is READ, not
    // refused — the body passes unknown keys through.
    expect(storeWireStatusSchema.safeParse({ ...status, deprecated: ["records.put"], minClientVersion: "0.12.0" }).success).toBe(true);
    expect(storeWireStatusSchema.safeParse({ ...status, format: "vendo/store-wire@2" }).success).toBe(false);
  });

  it("maps every VendoError code to the wire status table and back", () => {
    const { status, body } = storeWireErrorBody(new VendoError("not-found", "unknown record"));
    expect(status).toBe(404);
    expect(storeWireErrorSchema.parse(body).error.code).toBe("not-found");
    const roundTripped = parseStoreWireError(status, body);
    expect(roundTripped).toBeInstanceOf(VendoError);
    expect(roundTripped.code).toBe("not-found");
    expect(roundTripped.message).toBe("unknown record");
    expect(STORE_WIRE_STATUS_BY_CODE["cloud-required"]).toBe(402);
    expect(STORE_WIRE_STATUS_BY_CODE["validation"]).toBe(400);
  });

  /** `VendoError.detail` crosses. `workspace.commit`'s conflict names the paths
      that moved in `detail.conflicts`, and before this the envelope carried a
      code and a sentence, so a hosted caller had to re-read the whole index and
      re-derive them by hand. A refusal with no detail still sends no key. */
  it("the error envelope carries VendoError.detail, and omits it when there is none", () => {
    const conflict = new VendoError("conflict", "the workspace moved on", { conflicts: ["a.json", "b.json"] });
    const { status, body } = storeWireErrorBody(conflict);
    expect(status).toBe(409);
    expect(body.error.detail).toEqual({ conflicts: ["a.json", "b.json"] });
    expect(parseStoreWireError(status, body).detail).toEqual({ conflicts: ["a.json", "b.json"] });

    const plain = storeWireErrorBody(new VendoError("not-found", "unknown record"));
    expect("detail" in plain.body.error).toBe(false);
    expect(parseStoreWireError(plain.status, plain.body).detail).toBeUndefined();
  });

  it("parseStoreWireError: enveloped code wins, bare statuses map, junk degrades honestly", () => {
    expect(parseStoreWireError(400, { error: { code: "conflict", message: "id taken" } }).code).toBe("conflict");
    expect(parseStoreWireError(402, undefined).code).toBe("cloud-required");
    // A junk/unenveloped code at a mapped status now reads as the status's
    // own classification (`unavailable` at 500/503), not "not-implemented" —
    // see the next case for why that distinction is the whole point.
    expect(parseStoreWireError(500, { error: { code: "not-a-real-code", message: "?" } }).code).toBe("unavailable");
    expect(parseStoreWireError(503, null).code).toBe("unavailable");
  });

  it("parseStoreWireError: 429/5xx are unavailable (retryable), never not-implemented", () => {
    // Field 2026-08-14: a dropped Postgres connection under load answered a
    // bare 503, no envelope — and every one of these used to degrade to
    // "not-implemented", which told the operator Cloud store did not support
    // an op it shipped with. Each status here is independently pinned so a
    // future edit cannot drop one silently.
    for (const status of [429, 500, 502, 503, 504]) {
      expect(parseStoreWireError(status, undefined).code).toBe("unavailable");
      expect(parseStoreWireError(status, null).code).toBe("unavailable");
    }
    // 400/402/403/409 are untouched by this slice — still their own codes,
    // never folded into "unavailable".
    expect(parseStoreWireError(400, undefined).code).toBe("validation");
    expect(parseStoreWireError(402, undefined).code).toBe("cloud-required");
    expect(parseStoreWireError(403, undefined).code).toBe("blocked");
    expect(parseStoreWireError(409, undefined).code).toBe("conflict");
    // 501 keeps its own, older meaning (a real not-implemented/sandbox-unavailable
    // status) — it is not folded into the new 5xx bucket.
    expect(parseStoreWireError(501, undefined).code).toBe("not-implemented");
    // The console's own envelope for this failure (lib/api/respond.ts's
    // apiServerError) round-trips as itself now, rather than being discarded
    // by schema validation for carrying a code the old enum didn't know.
    expect(
      parseStoreWireError(503, { error: { code: "unavailable", message: "Store request failed." } }).code,
    ).toBe("unavailable");
  });

  it("only an enveloped not-found reads as record absence — a bare 404 surfaces as failure", () => {
    expect(parseStoreWireError(404, { error: { code: "not-found", message: "unknown record" } }).code).toBe("not-found");
    expect(parseStoreWireError(404, "<html>nginx 404</html>").code).toBe("not-implemented");
    expect(parseStoreWireError(404, undefined).code).toBe("not-implemented");
  });

  it("the reverse status table round-trips through the forward table", () => {
    for (const [status, code] of Object.entries({ 400: "validation", 402: "cloud-required", 403: "blocked", 409: "conflict" } as const)) {
      expect(STORE_WIRE_STATUS_BY_CODE[code]).toBe(Number(status));
      expect(parseStoreWireError(Number(status), undefined).code).toBe(code);
    }
    expect(STORE_WIRE_STATUS_BY_CODE["not-found"]).toBe(404);
    expect(parseStoreWireError(501, undefined).code).toBe("not-implemented");
  });
});
