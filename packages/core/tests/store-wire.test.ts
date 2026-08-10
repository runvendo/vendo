import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  STORE_WIRE_DEPRECATED_OPS,
  STORE_WIRE_DEPRECATED_REMOVED_IN,
  STORE_WIRE_MIN_CLIENT_VERSION,
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
  type EraseTarget,
  type StoreWireStatus,
} from "../src/index.js";

describe("vendo/store-wire@1", () => {
  it("exposes the format constant and 42 mount-relative paths", () => {
    expect(VENDO_STORE_WIRE_FORMAT).toBe("vendo/store-wire@1");
    // 9 families: records(7) + engine(7) + blobs(4) + appData(8) + transcripts(6) + harness(3) + workspace(4) + lifecycle(2) + status(1) = 42
    expect(Object.keys(STORE_WIRE_PATHS)).toHaveLength(42);
    expect(STORE_WIRE_PATHS.status).toBe("/status");
    expect(STORE_WIRE_PATHS["records.get"]).toBe("/records/get");
    expect(STORE_WIRE_PATHS["engine.get"]).toBe("/engine/get");
    expect(STORE_WIRE_PATHS["engine.compareAndSwap"]).toBe("/engine/compareAndSwap");
    expect(STORE_WIRE_PATHS["appData.put"]).toBe("/app-data/put");
    expect(STORE_WIRE_PATHS["lifecycle.promote"]).toBe("/lifecycle/promote");
  });

  it("every engine door is its own path, distinct from its records twin", () => {
    const verbs = ["get", "put", "delete", "list", "claim", "insertIfAbsent", "compareAndSwap"] as const;
    for (const verb of verbs) {
      const engine = STORE_WIRE_PATHS[`engine.${verb}`];
      expect(engine).toBe(`/engine/${verb}`);
      expect(engine).not.toBe(STORE_WIRE_PATHS[`records.${verb}`]);
    }
    const enginePaths = Object.entries(STORE_WIRE_PATHS)
      .filter(([op]) => op.startsWith("engine."))
      .map(([, path]) => path);
    expect(enginePaths).toHaveLength(7);
    expect(enginePaths.every((path) => path.startsWith("/engine/"))).toBe(true);
  });

  it("names every records.* op as deprecated, and nothing else", () => {
    expect([...STORE_WIRE_DEPRECATED_OPS].sort()).toEqual([
      "records.claim",
      "records.compareAndSwap",
      "records.delete",
      "records.get",
      "records.insertIfAbsent",
      "records.list",
      "records.put",
    ]);
    // Advertised only — every deprecated op is still a served path.
    for (const op of STORE_WIRE_DEPRECATED_OPS) {
      expect(Object.keys(STORE_WIRE_PATHS)).toContain(op);
    }
    // The removal release must be a real version, not a placeholder.
    expect(STORE_WIRE_DEPRECATED_REMOVED_IN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("advertises the release it ships in as minClientVersion", async () => {
    // scripts/sync-version-constants.mjs rewrites the constant at release cut,
    // the same invariant cli/shared.test.ts pins for CLI_VERSION — so the
    // handshake can never name a release this build did not ship in.
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(STORE_WIRE_MIN_CLIENT_VERSION).toBe(pkg.version);
  });

  it("the storeWireRecords* names are aliases of the shared collection bodies", () => {
    // Same shape serves /records/* and /engine/*; the old names stay exported
    // until the removal slice, so they must BE the renamed schemas, not copies.
    expect(storeWireRecordsGetRequestSchema).toBe(storeWireCollectionGetRequestSchema);
    expect(storeWireRecordsPutRequestSchema).toBe(storeWireCollectionPutRequestSchema);
    expect(storeWireRecordsDeleteRequestSchema).toBe(storeWireCollectionDeleteRequestSchema);
    expect(storeWireRecordsListRequestSchema).toBe(storeWireCollectionListRequestSchema);
    expect(storeWireRecordsClaimRequestSchema).toBe(storeWireCollectionClaimRequestSchema);
    expect(storeWireRecordsInsertIfAbsentRequestSchema).toBe(storeWireCollectionInsertIfAbsentRequestSchema);
    expect(storeWireRecordsCompareAndSwapRequestSchema).toBe(storeWireCollectionCompareAndSwapRequestSchema);
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
      ops: 42,
    };
    expect(storeWireStatusSchema.parse(status).ops).toBe(42);
    expect(storeWireStatusSchema.parse({ ...status, deprecated: ["records.put"] }).deprecated).toEqual(["records.put"]);
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
