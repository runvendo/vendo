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
  storeWireRecordsGetRequestSchema,
  storeWireRecordsPutRequestSchema,
  storeWireRecordsDeleteRequestSchema,
  storeWireRecordsListRequestSchema,
  storeWireRecordsClaimRequestSchema,
  storeWireRecordsInsertIfAbsentRequestSchema,
  storeWireRecordsCompareAndSwapRequestSchema,
  storeWireBlobsPutRequestSchema,
  storeWireBlobsGetRequestSchema,
  storeWireBlobsDeleteRequestSchema,
  storeWireBlobsListRequestSchema,
  storeWireTranscriptsPutThreadRequestSchema,
  storeWireTranscriptsGetThreadRequestSchema,
  storeWireTranscriptsListThreadsRequestSchema,
  storeWireTranscriptsDeleteThreadRequestSchema,
  storeWireTranscriptsPutMessageRequestSchema,
  storeWireTranscriptsRecordAnswerRequestSchema,
  storeWireHarnessGetRequestSchema,
  storeWireHarnessSetRequestSchema,
  storeWireHarnessClearRequestSchema,
  storeWireWorkspaceIndexRequestSchema,
  storeWireWorkspaceReadRequestSchema,
  storeWireWorkspaceCommitRequestSchema,
  storeWireWorkspaceHistoryRequestSchema,
  storeWireLifecycleEraseRequestSchema,
  storeWireLifecycleAdoptRequestSchema,
  storeWireLifecyclePromoteRequestSchema,
  storeWireSessionRegisterRequestSchema,
  storeWireSessionStaleRequestSchema,
  storeWireSessionClaimRequestSchema,
  type EraseTarget,
  type StoreWireStatus,
} from "../src/index.js";

describe("vendo/store-wire@1", () => {
  it("exposes the format constant and 31+1 mount-relative paths", () => {
    expect(VENDO_STORE_WIRE_FORMAT).toBe("vendo/store-wire@1");
    // 7 families: records(7) + blobs(4) + transcripts(6) + harness(3) + workspace(4) + lifecycle(6) + status(1) = 31
    expect(Object.keys(STORE_WIRE_PATHS)).toHaveLength(31);
    expect(STORE_WIRE_PATHS.status).toBe("/status");
    expect(STORE_WIRE_PATHS["records.get"]).toBe("/records/get");
    expect(STORE_WIRE_PATHS["lifecycle.session.claim"]).toBe("/lifecycle/session/claim");
  });

  it("parses records request DTOs and rejects invalid ones", () => {
    expect(storeWireRecordsGetRequestSchema.parse({ collection: "users", id: "u1" }).id).toBe("u1");
    expect(storeWireRecordsGetRequestSchema.safeParse({ collection: "", id: "u1" }).success).toBe(false);

    expect(storeWireRecordsPutRequestSchema.parse({
      collection: "users",
      record: { id: "u1", data: { name: "Alice" } },
    }).record.id).toBe("u1");
    expect(storeWireRecordsPutRequestSchema.safeParse({ collection: "users" }).success).toBe(false);

    expect(storeWireRecordsDeleteRequestSchema.parse({ collection: "users", id: "u1" }).collection).toBe("users");

    expect(storeWireRecordsListRequestSchema.parse({ collection: "users" }).collection).toBe("users");
    expect(storeWireRecordsListRequestSchema.parse({
      collection: "users",
      query: { refs: { org: "o1" }, limit: 50 },
    }).query?.limit).toBe(50);

    expect(storeWireRecordsClaimRequestSchema.parse({
      collection: "users",
      expected: { id: "u1", data: { status: "free" } },
      replacement: { data: { status: "claimed" } },
    }).expected.id).toBe("u1");

    expect(storeWireRecordsInsertIfAbsentRequestSchema.parse({
      collection: "users",
      record: { id: "u2", data: {} },
    }).record.id).toBe("u2");

    expect(storeWireRecordsCompareAndSwapRequestSchema.parse({
      collection: "users",
      record: { id: "u1", data: {} },
      expectedRevision: "rev_1",
    }).expectedRevision).toBe("rev_1");
    expect(storeWireRecordsCompareAndSwapRequestSchema.safeParse({
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

  it("parses transcripts request DTOs", () => {
    expect(storeWireTranscriptsPutThreadRequestSchema.parse({
      thread: { id: "t1", subject: "sub_user1", messages: [{ role: "user", content: "hi" }] },
    }).thread.id).toBe("t1");
    expect(storeWireTranscriptsPutThreadRequestSchema.safeParse({
      thread: { id: "", subject: "s", messages: [] },
    }).success).toBe(false);

    expect(storeWireTranscriptsGetThreadRequestSchema.parse({ id: "t1", limit: 50 }).limit).toBe(50);
    expect(storeWireTranscriptsListThreadsRequestSchema.parse({ subject: "sub_user1" }).subject).toBe("sub_user1");
    expect(storeWireTranscriptsDeleteThreadRequestSchema.parse({ id: "t1" }).id).toBe("t1");
    expect(storeWireTranscriptsPutMessageRequestSchema.parse({ threadId: "t1", message: { role: "user", content: "test" } }).threadId).toBe("t1");
    expect(storeWireTranscriptsRecordAnswerRequestSchema.parse({ threadId: "t1", answer: { text: "done" } }).threadId).toBe("t1");
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
    expect(storeWireLifecycleEraseRequestSchema.parse({ target: { subject: "sub_1" } }).target.subject).toBe("sub_1");
    expect(storeWireLifecycleEraseRequestSchema.parse({ target: { appId: "app_1" } }).target.appId).toBe("app_1");
    // A destructive erase must name exactly one scope: no empty target...
    expect(storeWireLifecycleEraseRequestSchema.safeParse({ target: {} }).success).toBe(false);
    // ...and no ambiguous both-set target.
    expect(storeWireLifecycleEraseRequestSchema.safeParse({
      target: { subject: "sub_1", appId: "app_1" },
    }).success).toBe(false);
    expect(storeWireLifecycleEraseRequestSchema.safeParse({ target: { subject: "" } }).success).toBe(false);
    expect(storeWireLifecycleAdoptRequestSchema.parse({ from: "sub_anon", to: "sub_real" }).from).toBe("sub_anon");
    expect(storeWireLifecycleAdoptRequestSchema.safeParse({ from: "", to: "x" }).success).toBe(false);
    expect(storeWireLifecyclePromoteRequestSchema.parse({ appId: "app_1", orgId: "org_1" }).orgId).toBe("org_1");
    expect(storeWireSessionRegisterRequestSchema.parse({ subject: "sub_1", now: 1000 }).now).toBe(1000);
    expect(storeWireSessionStaleRequestSchema.parse({ idleMs: 60000 }).idleMs).toBe(60000);
    expect(storeWireSessionStaleRequestSchema.safeParse({ idleMs: 0 }).success).toBe(false);
    expect(storeWireSessionClaimRequestSchema.parse({ subject: "sub_1", idleMs: 5000 }).subject).toBe("sub_1");
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
      ops: 31,
    };
    expect(storeWireStatusSchema.parse(status).ops).toBe(31);
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

  it("parseStoreWireError: enveloped code wins, bare statuses map, junk degrades honestly", () => {
    expect(parseStoreWireError(400, { error: { code: "conflict", message: "id taken" } }).code).toBe("conflict");
    expect(parseStoreWireError(402, undefined).code).toBe("cloud-required");
    expect(parseStoreWireError(500, { error: { code: "not-a-real-code", message: "?" } }).code).toBe("not-implemented");
    expect(parseStoreWireError(503, null).code).toBe("not-implemented");
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
