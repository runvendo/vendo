import {
  STORE_WIRE_PATHS,
  VendoError,
  assertEngineCollection,
  canonicalJson,
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
};
const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const envelope = (code: string, message: string): Response =>
  json({ error: { code, message } }, STATUS[code] ?? 503);

/** The engine door's routes, mount-relative path -> op name, read OFF the wire
 *  contract instead of spelled out here. `engine` is the same seven verbs as
 *  `records` over the same rows, so it reaches the same dispatcher and the same
 *  in-memory state below — a test may write through one door and read back
 *  through the other, which is the only way the two can be caught disagreeing.
 *  Deriving the paths means a verb added to the contract arrives here served,
 *  and a verb renamed there cannot leave this fake answering the old spelling. */
const ENGINE_ROUTES = new Map<string, string>(
  Object.entries(STORE_WIRE_PATHS)
    .filter(([op]) => op.startsWith("engine."))
    .map(([op, path]) => [path, op.slice("engine.".length)]),
);

const sameValue = (
  current: VendoRecord,
  expected: { data: unknown; refs?: Record<string, string> },
): boolean =>
  canonicalJson(current.data) === canonicalJson(expected.data)
  && canonicalJson(current.refs ?? null) === canonicalJson(expected.refs ?? null);

/** The seven records ops, for BOTH records doors: the Store Wire v1 door takes
 *  the op from the path and the collection from the body, the per-collection
 *  legacy door takes the collection from the path and the method from the
 *  trailing segments — same seven operations, two spellings of the two atomic
 *  ones, so one dispatcher answers both and they cannot drift apart. */
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

/** The per-namespace legacy blobs door: REST verbs, bytes raw on the wire, the
 *  key in the trailing path segments. `null` for a verb it does not serve, so
 *  the router reports the hole against the whole request rather than on this
 *  door's behalf. */
async function blobsRestOp(
  blobs: BlobStore,
  request: Request,
  url: URL,
  recorded: RecordedRequest,
  keySegments: string[],
): Promise<Response | null> {
  if (keySegments.length === 0 && request.method === "GET") {
    return json({ keys: await blobs.list(url.searchParams.get("prefix") ?? "") });
  }
  const key = keySegments.join("/");
  if (request.method === "PUT") {
    const contentType = recorded.contentType ?? undefined;
    await blobs.put(key, recorded.bytes ?? new Uint8Array(), contentType === undefined ? undefined : { contentType });
    return json({ ok: true });
  }
  if (request.method === "GET") {
    const blob = await blobs.get(key);
    if (blob === null) return envelope("not-found", "Blob not found.");
    return new Response(blob.bytes.slice().buffer as ArrayBuffer, {
      headers: blob.contentType === undefined ? {} : { "content-type": blob.contentType },
    });
  }
  if (request.method === "DELETE") {
    await blobs.delete(key);
    return json({ ok: true });
  }
  return null;
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

    // Store Wire v1 records door (STORE_WIRE_PATHS): one route per op, the
    // collection rides the body. The per-collection legacy door below keeps
    // serving the StoreAdapter surface over the same in-memory state.
    if (rest[0] === "records" && rest.length === 2 && post) {
      return recordsOp(adapter.records(body.collection as string), rest[1]!, body, miss);
    }
    // The engine door: Vendo's OWN drawers, same seven verbs over the same rows,
    // with the allowlist in front. The gate is served here rather than skipped
    // because a fake that answers a collection the live door refuses lets a
    // wrong call pass every test and fail in production.
    const engineOp = post ? ENGINE_ROUTES.get(`/${rest.join("/")}`) : undefined;
    if (engineOp !== undefined) {
      const collection = body.collection as string;
      assertEngineCollection(collection);
      return recordsOp(adapter.records(collection), engineOp, body, miss);
    }
    if (rest[0] === "blobs" && rest.length === 2 && post) {
      return blobsWireOp(adapter.blobs(body.namespace as string), rest[1]!, body, miss);
    }
    if (rest[0] === "records" && post) {
      return recordsOp(adapter.records(rest[1]!), rest.slice(2).join("/"), body, miss);
    }
    if (rest[0] === "blobs") {
      const served = await blobsRestOp(adapter.blobs(rest[1]!), request, url, recorded, rest.slice(2));
      if (served !== null) return served;
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
