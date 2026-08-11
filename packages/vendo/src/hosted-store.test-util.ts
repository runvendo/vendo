import {
  STORE_WIRE_PATHS,
  VendoError,
  assertEngineCollection,
  canonicalJson,
  type AppDataTarget,
  type BlobStore,
  type RecordStore,
  type VendoRecord,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";

const decoder = new TextDecoder();

export interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  deploymentHost: string | null;
  deploymentName: string | null;
  json?: unknown;
  bytes?: Uint8Array;
}

type Body = Record<string, unknown>;

/** Reports a route this fake does not serve, already bound to the request that
 *  hit it. Returns `never`, so every caller may `return` it. */
type Miss = (detail?: string) => never;

/** A route this fake does not serve is a HOLE IN THE FAKE, and it throws out of
 * `fetch` so that nothing can read it as the console's own answer. It used to
 * answer `not-found`, which is exactly what a live console says when it refuses
 * — so a test driving an unserved op family saw a plausible rejection, concluded
 * the code handled it, and proved nothing. No production path makes `fetch`
 * reject with this name, so the signal cannot be mistaken for one. Serve the
 * route here, or assert this throw. */
function unserved(method: string, path: string, detail?: string): never {
  const error = new Error(
    `fakeConsole does not serve ${method} ${path}`
    + `${detail === undefined ? "" : ` (${detail})`} — implement it in hosted-store.test-util.ts`,
  );
  error.name = "FakeConsoleUnservedRoute";
  throw error;
}

const isUnserved = (error: unknown): boolean =>
  error instanceof Error && error.name === "FakeConsoleUnservedRoute";

const STATUS: Record<string, number> = {
  validation: 400,
  unauthorized: 401,
  blocked: 403,
  "not-found": 404,
  conflict: 409,
  "not-implemented": 501,
};
const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const envelope = (code: string, message: string): Response =>
  json({ error: { code, message } }, STATUS[code] ?? 503);

/** A family's routes, mount-relative path -> verb, read OFF the wire contract
 *  instead of spelled out here: a verb added to the contract arrives here
 *  served, and a verb renamed there cannot leave this fake answering the old
 *  spelling. */
const routesOf = (family: string): Map<string, string> => new Map(
  Object.entries(STORE_WIRE_PATHS)
    .filter(([op]) => op.startsWith(`${family}.`))
    .map(([op, path]) => [path, op.slice(family.length + 1)]),
);

const ENGINE_ROUTES = routesOf("engine");
const APP_DATA_ROUTES = routesOf("appData");

/** The ref key the appData family stamps its owner on, and the one key a caller
 *  may never supply — packages/store's APP_DATA_OWNER_REF, mirrored. */
const OWNER_REF = "subject";

const sameValue = (
  current: VendoRecord,
  expected: { data: unknown; refs?: Record<string, string> },
): boolean =>
  canonicalJson(current.data) === canonicalJson(expected.data)
  && canonicalJson(current.refs ?? null) === canonicalJson(expected.refs ?? null);

/** The seven collection-addressed ops the engine door serves: the op comes
 *  from the path, the collection from the body. The two atomic verbs keep their
 *  second spelling so a body aimed at either name lands on the same row. */
async function recordsOp(records: RecordStore, op: string, body: Body, miss: Miss): Promise<Response> {
  switch (op) {
    case "get":
      return json({ record: await records.get(body.id as string) });
    case "put":
      return json({ record: await records.put(body.record as never) });
    case "delete":
      await records.delete(body.id as string);
      return json({ ok: true });
    case "list":
      return json(await records.list((body.query ?? {}) as never));
    case "claim":
      return recordsClaim(records, body);
    case "insertIfAbsent":
    case "atomic/insert-if-absent":
      return json({ record: await records.atomic!.insertIfAbsent(body.record as never) });
    case "compareAndSwap":
    case "atomic/compare-and-swap":
      return json({
        record: await records.atomic!.compareAndSwap(
          body.record as never,
          body.expectedRevision as string,
        ),
      });
    default:
      return miss(`unknown records op: ${op}`);
  }
}

/** Compare-and-set over a whole record value: the claim lands only while the
 *  stored value still equals `expected`, and an absent `replacement` means the
 *  claim is a delete. */
async function recordsClaim(records: RecordStore, body: Body): Promise<Response> {
  const expected = body.expected as { id: string; data: unknown; refs?: Record<string, string> };
  const current = await records.get(expected.id);
  if (current === null || !sameValue(current, expected)) return json({ claimed: false });
  const replacement = body.replacement as { data: unknown; refs?: Record<string, string> } | undefined;
  if (replacement === undefined) {
    await records.delete(expected.id);
  } else {
    await records.put({
      id: expected.id,
      data: replacement.data as never,
      ...(replacement.refs === undefined ? {} : { refs: replacement.refs }),
    });
  }
  return json({ claimed: true });
}

/** Store Wire v1 blobs door: JSON POST, bytes base64 on the wire. */
async function blobsWireOp(blobs: BlobStore, op: string, body: Body, miss: Miss): Promise<Response> {
  switch (op) {
    case "put": {
      const contentType = body.contentType as string | undefined;
      await blobs.put(
        body.key as string,
        Uint8Array.from(atob(body.bytes as string), (char) => char.charCodeAt(0)),
        contentType === undefined ? undefined : { contentType },
      );
      return json({ ok: true });
    }
    case "get": {
      const blob = await blobs.get(body.key as string);
      if (blob === null) return json({ blob: null });
      let binary = "";
      for (const byte of blob.bytes) binary += String.fromCharCode(byte);
      return json({
        blob: {
          bytes: btoa(binary),
          ...(blob.contentType === undefined ? {} : { contentType: blob.contentType }),
        },
      });
    }
    case "delete":
      await blobs.delete(body.key as string);
      return json({ ok: true });
    case "list":
      return json({ keys: await blobs.list((body.prefix as string | undefined) ?? "") });
    default:
      return miss(`unknown blobs op: ${op}`);
  }
}

/** Store Wire v1 appData door: an app's own rows and files, addressed by a
 *  `{appId, collection, owner}` target instead of a collection string. Mirrors
 *  packages/store's app-data-rows.ts — rows land in `app:<appId>:<collection>`
 *  with the owner stamped on `refs.subject` (a caller that supplies it is
 *  refused), reads are scoped to that stamp, and files ride the twin blob
 *  namespace under an `<owner>/` key prefix. A fake that skipped the stamping
 *  would let an unscoped read pass here and fail against the console. */
async function appDataOp(
  records: (collection: string) => RecordStore,
  blobStore: (namespace: string) => BlobStore,
  op: string,
  body: Body,
  miss: Miss,
): Promise<Response> {
  const target = body.target as AppDataTarget;
  const scope = `app:${target.appId}:${target.collection}`;
  const rows = records(scope);
  const owned = (key: string): string => `${target.owner}/${key}`;
  const refuseCallerOwner = (refs: Record<string, string> | undefined): void => {
    if (refs?.[OWNER_REF] !== undefined) {
      throw new VendoError(
        "validation",
        `app data may not supply refs.${OWNER_REF}; the runtime stamps the owner from the host's session`,
      );
    }
  };
  switch (op) {
    case "put": {
      const record = body.record as { id: string; data: unknown; refs?: Record<string, string> };
      refuseCallerOwner(record.refs);
      const held = await rows.get(record.id);
      if (held !== null && held.refs?.[OWNER_REF] !== target.owner) {
        throw new VendoError("conflict", `app data id ${JSON.stringify(record.id)} is already held in this collection`);
      }
      return json({
        record: await rows.put({ ...record, refs: { ...record.refs, [OWNER_REF]: target.owner } } as never),
      });
    }
    case "get": {
      const record = await rows.get(body.id as string);
      return json({ record: record?.refs?.[OWNER_REF] === target.owner ? record : null });
    }
    case "list": {
      const query = (body.query ?? {}) as { refs?: Record<string, string> };
      refuseCallerOwner(query.refs);
      return json(await rows.list({ ...query, refs: { ...query.refs, [OWNER_REF]: target.owner } } as never));
    }
    case "delete": {
      const record = await rows.get(body.id as string);
      if (record?.refs?.[OWNER_REF] === target.owner) await rows.delete(body.id as string);
      return json({ ok: true });
    }
    case "putFile":
      return blobsWireOp(blobStore(scope), "put", { ...body, key: owned(body.key as string) }, miss);
    case "getFile":
      return blobsWireOp(blobStore(scope), "get", { ...body, key: owned(body.key as string) }, miss);
    case "deleteFile":
      return blobsWireOp(blobStore(scope), "delete", { ...body, key: owned(body.key as string) }, miss);
    case "listFiles": {
      const keys = await blobStore(scope).list(owned((body.prefix as string | undefined) ?? ""));
      return json({ keys: keys.map((key) => key.slice(target.owner.length + 1)) });
    }
    default:
      return miss(`unknown appData op: ${op}`);
  }
}

/** Everything the handler learns from the request before routing: the recorded
 *  shape the caller asserts against, with the body parsed into it. */
async function record(request: Request): Promise<RecordedRequest> {
  const recorded: RecordedRequest = {
    url: request.url,
    method: request.method,
    authorization: request.headers.get("authorization"),
    contentType: request.headers.get("content-type"),
    deploymentHost: request.headers.get("x-vendo-deployment-host"),
    deploymentName: request.headers.get("x-vendo-deployment-name"),
  };
  const raw = new Uint8Array(await request.arrayBuffer());
  if (recorded.contentType === "application/json") {
    recorded.json = JSON.parse(decoder.decode(raw));
  } else if (raw.length > 0) {
    recorded.bytes = raw;
  }
  return recorded;
}

/** In-memory fake of the console's /api/v1/store surface (the wire the
 * adapter must speak — see apps/console/lib/api/store-handlers.ts). Records
 * ride the reference memoryStoreAdapter, which already mirrors the store
 * engine's reserved-collection semantics (append-only audit, state id
 * grammar, cross-subject refusals), so parity failures surface as real
 * envelopes. The erase cascade itself is the console's concern (proven in the console repo against real
 * per-org engines); here it answers the wire shape and records the call. */
export function fakeConsole() {
  const adapter = memoryStoreAdapter();
  const requests: RecordedRequest[] = [];
  const eraseCalls: unknown[] = [];

  const route = async (
    request: Request,
    url: URL,
    recorded: RecordedRequest,
    miss: Miss,
  ): Promise<Response> => {
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // /api/v1/store/...
    if (segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "store") {
      miss("not the console's store mount");
    }
    const rest = segments.slice(3);
    const body = (recorded.json ?? {}) as Body;
    const post = request.method === "POST";

    // The RETIRED generic records family. Every /records/* route — the Store
    // Wire v1 door and the older per-collection one alike — answers an
    // ENVELOPED 501 that names the op the caller asked for. There was no
    // deprecation window, so this refusal is the only notice a caller who wrote
    // raw HTTP against /records/* ever gets: it must be loud, and it must be
    // the wire's own voice rather than a hole in this fake.
    if (rest[0] === "records") {
      const op = `records.${rest[rest.length - 1]}`;
      return envelope(
        "not-implemented",
        `the store wire no longer serves ${op} — the generic records family was removed.`
        + " Use the appData ops for an app's own rows and files, or the engine ops for Vendo's own collections.",
      );
    }
    // The engine door: Vendo's OWN drawers, seven collection-addressed verbs
    // with the allowlist in front. The gate is served here rather than skipped
    // because a fake that answers a collection the live door refuses lets a
    // wrong call pass every test and fail in production.
    const engineOp = post ? ENGINE_ROUTES.get(`/${rest.join("/")}`) : undefined;
    if (engineOp !== undefined) {
      const collection = body.collection as string;
      assertEngineCollection(collection);
      return recordsOp(adapter.records(collection), engineOp, body, miss);
    }
    const appDataOpName = post ? APP_DATA_ROUTES.get(`/${rest.join("/")}`) : undefined;
    if (appDataOpName !== undefined) {
      return appDataOp((c) => adapter.records(c), (n) => adapter.blobs(n), appDataOpName, body, miss);
    }
    if (rest[0] === "blobs" && rest.length === 2 && post) {
      return blobsWireOp(adapter.blobs(body.namespace as string), rest[1]!, body, miss);
    }
    if (rest[0] === "erase" && post) {
      eraseCalls.push(recorded.json);
      return json({ report: { vendo_apps: 1, vendo_threads: 2 } });
    }
    return miss();
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const recorded = await record(request);
    requests.push(recorded);
    if (recorded.authorization === null) {
      return envelope("unauthorized", "Valid API key required.");
    }
    const miss: Miss = (detail?: string) => unserved(request.method, url.pathname, detail);
    try {
      return await route(request, url, recorded, miss);
    } catch (error) {
      if (isUnserved(error)) throw error;
      if (error instanceof VendoError) return envelope(error.code, error.message);
      return envelope("unavailable", error instanceof Error ? error.message : String(error));
    }
  };

  return { adapter, requests, eraseCalls, handler };
}
