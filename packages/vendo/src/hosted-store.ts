import {
  STORE_WIRE_PATHS,
  VendoError,
  parseStoreWireError,
  storeWireStatusSchema,
  vendoRecordSchema,
  type BlobStore,
  type RecordInput,
  type RecordQuery,
  type RecordStore,
  type StoreOps,
  type StoreWireStatus,
  type VendoRecord,
} from "@vendoai/core";
import {
  DEDICATED_RECORD_COLLECTIONS,
  RESERVED_COLLECTIONS,
  type EraseReport,
  type SubjectMergeReport,
  type VendoStore,
} from "@vendoai/store";
import { consoleSender, raiseCloudError, toArrayBuffer } from "./cloud-console.js";
import { deploymentIdentityHeaders } from "./deployment-identity.js";
import { defaultFetch } from "@vendoai/core";

/** The console mounts the hosted-store surface here
 * (apps/console/app/api/v1/store/*). */
const CONSOLE_STORE_PATH = "/api/v1/store";

/** Store calls are row/blob CRUD, not machine boots: generous enough for a
 * large blob transfer on a slow link, small enough that a hung console
 * request can't wedge a chat turn the way cloudSandbox's 300s budget would. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HostedStoreOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  /** Per-request abort timeout, in milliseconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** The hosted store handle: a plain StoreAdapter over the console wire, plus
 * the erase door (02-store §5 — the console cascades exactly like eraseStore;
 * the host-side TTL sweep is built on this call). `ensureSchema` is a client
 * no-op (the service owns its migrations), `close` holds no local resources,
 * and `raw()` fails loudly — there is no local database handle to hand out. */
export interface HostedStore extends VendoStore {
  erase: {
    bySubject(subject: string): Promise<EraseReport>;
    byApp(appId: string): Promise<EraseReport>;
  };
  /** The ephemeral-session doors (02-store §4, hosted): registration == touch
   * on every ephemeral request, adoption on sign-in, and the list/claim legs
   * of the HOST-driven TTL sweep — the sweep claims a stale subject, then
   * finishes through `erase.bySubject` (hosted-store one-pager). Millisecond
   * clocks ride the wire so an injected session clock stays authoritative. */
  sessions: {
    register(subject: string, now?: number): Promise<void>;
    adopt(from: string, to: string): Promise<SubjectMergeReport | null>;
    stale(idleMs: number, now?: number): Promise<string[]>;
    claim(subject: string, idleMs: number, now?: number): Promise<boolean>;
  };
  /** The 31-op named-operation surface over the same mount and the same key —
   * `vendo/store-wire@1` (see {@link hostedStoreOps}). Additive: the
   * StoreAdapter doors above are unchanged and keep their own routes. */
  ops: StoreOps;
}

/** Console garbage on a 2xx is the SERVICE misbehaving, never the caller's
 * fault — same posture as cloudSandbox's malformed-200 defenses. No VendoError
 * code fits "your storage backend answered nonsense", so this stays a plain
 * Error: the wire layer logs it server-side instead of blaming the client. */
const invalidResponse = (what: string): never => {
  throw new Error(`Vendo Cloud store returned an ${what} response`);
};

/** The console's "unauthorized"/"quota-exhausted" have no VendoError twin;
 * both ride the shared 402/401 → cloud-required mapping. Anything else
 * (unknown codes, 5xx, non-JSON bodies) is carried on a plain Error with the
 * server's code attached — the packages/apps cloud client's posture. */
const raiseStoreError = (response: Response): Promise<never> =>
  raiseCloudError(response, "store", (code, message) => {
    throw Object.assign(new Error(message), { code: code ?? "unavailable" });
  });

/** A console that is not serving the ephemeral-session op family
 * (/api/v1/store/sessions/*) answers Next.js's BARE 404 page, no error
 * envelope. Typed so the composition layer (hostedSessionOps in compose-store.ts)
 * can disable the session doors gracefully instead of failing anonymous
 * traffic; an ENVELOPED 404 is a live console answering "not-found" and keeps
 * the loud path, same for every other failure. Prod has served the doors
 * again since 2026-07-20 (vendo-web #88), so this is a guard, not a
 * description of today. */
export class HostedSessionDoorsMissingError extends Error {
  constructor() {
    super(
      "Vendo Cloud console did not serve /api/v1/store/sessions/* (bare 404)",
    );
    this.name = "HostedSessionDoorsMissingError";
  }
}

/** The session doors' raise: a bare 404 (no envelope) is the one
 * removed-surface signal; everything else defers to the store mapping. */
const raiseSessionsError = async (response: Response): Promise<never> => {
  if (response.status === 404) {
    let payload: unknown;
    try {
      payload = JSON.parse(await response.clone().text());
    } catch {
      payload = undefined;
    }
    const enveloped = typeof payload === "object" && payload !== null && "error" in payload;
    if (!enveloped) throw new HostedSessionDoorsMissingError();
  }
  return raiseStoreError(response);
};

function parseRecord(value: unknown): VendoRecord {
  const parsed = vendoRecordSchema.safeParse(value);
  if (!parsed.success) invalidResponse("invalid record");
  return parsed.data as VendoRecord;
}

function parseNullableRecord(value: unknown): VendoRecord | null {
  if (value === null) return null;
  return parseRecord(value);
}

/** The console's records door is PER COLLECTION: the collection rides the
 * path, the method is the next segment (`/records/{collection}/put`). */
const recordsPath = (collection: string): string => `/records/${encodeURIComponent(collection)}`;

const blobsPath = (namespace: string): string => `/blobs/${encodeURIComponent(namespace)}`;

/** Blob keys are paths ("images/a.png"); encode per segment so the key's own
 * separators survive as URL structure while each segment stays safe. */
const blobKeyPath = (namespace: string, key: string): string =>
  `${blobsPath(namespace)}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** The Cloud hosted-store adapter — the OSS side of the hosted-store seam
 * (docs/superpowers/specs/2026-07-18-hosted-store-onepager.md): a plain
 * StoreAdapter speaking RPC-over-HTTP to the console's /api/v1/store routes,
 * method for method. Tenant = the key's org, resolved server-side on every
 * call; reserved-collection semantics are enforced server-side by the same
 * engine rules as packages/store's routing. Secrets are excluded by
 * construction: the wire has no secrets surface, and storeSecrets/secretStore
 * keep requiring the local store handle. Cloned from cloudSandbox's shape:
 * behavior comes ONLY from constructor arguments (adapter rule — see
 * selectStore in compose-store.ts); the adapter never reads the environment. */
export function hostedStore(options: HostedStoreOptions): HostedStore {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? defaultFetch;

  const send = consoleSender({
    base,
    mountPath: CONSOLE_STORE_PATH,
    apiKey: options.apiKey,
    timeoutMs,
    fetchImpl,
    raise: raiseStoreError,
  });

  // Same wire, sessions-only raise — the doors are the one surface the prod
  // console may legitimately not serve (vendo-web@7cd0a02).
  const sendSessions = consoleSender({
    base,
    mountPath: CONSOLE_STORE_PATH,
    apiKey: options.apiKey,
    timeoutMs,
    fetchImpl,
    raise: raiseSessionsError,
  });

  const postJson = (sender: typeof send) => async (path: string, body: unknown): Promise<unknown> => {
    const response = await sender(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      return await response.json();
    } catch {
      return {};
    }
  };
  const sendJson = postJson(send);
  const sendSessionsJson = postJson(sendSessions);

  const records = (collection: string): RecordStore => {
    const prefix = recordsPath(collection);
    const store: RecordStore = {
      async get(id) {
        const payload = await sendJson(`${prefix}/get`, { id }) as { record?: unknown };
        if (payload.record === undefined) invalidResponse("invalid record");
        return parseNullableRecord(payload.record);
      },
      async put(record) {
        const payload = await sendJson(`${prefix}/put`, { record }) as { record?: unknown };
        if (payload.record === undefined || payload.record === null) invalidResponse("invalid record");
        return parseRecord(payload.record);
      },
      async delete(id) {
        await sendJson(`${prefix}/delete`, { id });
      },
      async list(query?: RecordQuery) {
        const payload = await sendJson(
          `${prefix}/list`,
          { query: query ?? {} },
        ) as { records?: unknown; cursor?: unknown };
        if (!Array.isArray(payload.records)) invalidResponse("invalid list");
        return {
          records: (payload.records as unknown[]).map(parseRecord),
          ...(typeof payload.cursor === "string" ? { cursor: payload.cursor } : {}),
        };
      },
    };

    // Capability mirror of the store engine's routing (02-store §2): routed
    // reserved collections expose no claim; atomic rides generic collections
    // and vendo_threads' revision counter only. Mirroring the shape here keeps
    // feature detection (`records.atomic !== undefined`) identical on both
    // sides of the wire.
    const reserved = (RESERVED_COLLECTIONS as readonly string[]).includes(collection);
    const dedicated = (DEDICATED_RECORD_COLLECTIONS as readonly string[]).includes(collection);
    if (!reserved) {
      store.claim = async (expected: RecordInput, replacement?: Pick<VendoRecord, "data" | "refs">) => {
        const payload = await sendJson(`${prefix}/claim`, {
          expected,
          ...(replacement === undefined ? {} : { replacement }),
        }) as { claimed?: unknown };
        if (typeof payload.claimed !== "boolean") invalidResponse("invalid claim");
        return payload.claimed as boolean;
      };
    }
    if ((!reserved && !dedicated) || collection === "vendo_threads") {
      store.atomic = {
        async insertIfAbsent(record) {
          const payload = await sendJson(`${prefix}/atomic/insert-if-absent`, { record }) as { record?: unknown };
          if (payload.record === undefined) invalidResponse("invalid record");
          return parseNullableRecord(payload.record);
        },
        async compareAndSwap(record, expectedRevision) {
          const payload = await sendJson(`${prefix}/atomic/compare-and-swap`, {
            record,
            expectedRevision,
          }) as { record?: unknown };
          if (payload.record === undefined) invalidResponse("invalid record");
          return parseNullableRecord(payload.record);
        },
      };
    }
    return store;
  };

  const blobs = (namespace: string): BlobStore => {
    const prefix = blobsPath(namespace);
    const keyPath = (key: string): string => blobKeyPath(namespace, key);
    return {
      async put(key, bytes, meta) {
        await send(keyPath(key), {
          method: "PUT",
          ...(meta?.contentType === undefined ? {} : { headers: { "content-type": meta.contentType } }),
          body: toArrayBuffer(bytes),
        });
      },
      async get(key) {
        const response = await fetchImpl(`${base}${CONSOLE_STORE_PATH}${keyPath(key)}`, {
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            ...(await deploymentIdentityHeaders()),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        // A missing blob is null at the seam (01-core §12) — but ONLY the
        // console's enveloped not-found says "missing blob". A bare 404 (no
        // envelope) is some other server answering — a misdeployed base URL
        // must fail loudly, not read as an empty blob store forever.
        if (response.status === 404) {
          let payload: unknown;
          try {
            payload = JSON.parse(await response.text());
          } catch {
            payload = undefined;
          }
          const code = typeof payload === "object" && payload !== null && "error" in payload
            ? (payload as { error?: { code?: unknown } }).error?.code
            : undefined;
          if (code === "not-found") return null;
          throw new Error(
            "Vendo Cloud store request failed with a bare 404 (no error envelope) — is the base URL a Vendo console?",
          );
        }
        if (!response.ok) await raiseStoreError(response);
        const contentType = response.headers.get("content-type");
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          ...(contentType === null ? {} : { contentType }),
        };
      },
      async delete(key) {
        await send(keyPath(key), { method: "DELETE" });
      },
      async list(prefixFilter?: string) {
        const query = prefixFilter === undefined || prefixFilter === ""
          ? ""
          : `?prefix=${encodeURIComponent(prefixFilter)}`;
        const response = await send(`${prefix}${query}`);
        let payload: { keys?: unknown };
        try {
          payload = await response.json() as { keys?: unknown };
        } catch {
          payload = {};
        }
        if (!Array.isArray(payload.keys) || !payload.keys.every((key) => typeof key === "string")) {
          invalidResponse("invalid blob list");
        }
        return payload.keys as string[];
      },
    };
  };

  const parseReport = (payload: unknown): EraseReport => {
    const report = typeof payload === "object" && payload !== null && "report" in payload
      ? (payload as { report?: unknown }).report
      : undefined;
    if (
      typeof report !== "object" || report === null || Array.isArray(report)
      || !Object.values(report).every((count) => typeof count === "number")
    ) {
      invalidResponse("invalid erase");
    }
    return report as EraseReport;
  };

  const parseMergeReport = (payload: unknown): SubjectMergeReport | null => {
    const report = typeof payload === "object" && payload !== null && "report" in payload
      ? (payload as { report?: unknown }).report
      : undefined;
    if (report === null) return null;
    if (
      typeof report !== "object" || report === undefined || Array.isArray(report)
      || !Object.values(report).every((count) => typeof count === "number")
    ) {
      invalidResponse("invalid adopt");
    }
    return report as SubjectMergeReport;
  };

  return {
    records,
    blobs,
    ops: hostedStoreOps(options),
    sessions: {
      async register(subject, now) {
        await sendSessionsJson("/sessions/register", { subject, ...(now === undefined ? {} : { now }) });
      },
      async adopt(from, to) {
        return parseMergeReport(await sendSessionsJson("/sessions/adopt", { from, to }));
      },
      async stale(idleMs, now) {
        const payload = await sendSessionsJson("/sessions/stale", {
          idleMs,
          ...(now === undefined ? {} : { now }),
        }) as { subjects?: unknown };
        if (!Array.isArray(payload.subjects) || !payload.subjects.every((subject) => typeof subject === "string")) {
          invalidResponse("invalid stale");
        }
        return payload.subjects as string[];
      },
      async claim(subject, idleMs, now) {
        const payload = await sendSessionsJson("/sessions/claim", {
          subject,
          idleMs,
          ...(now === undefined ? {} : { now }),
        }) as { claimed?: unknown };
        if (typeof payload.claimed !== "boolean") invalidResponse("invalid claim");
        return payload.claimed as boolean;
      },
    },
    // 02-store §5 — the subject/app cascade runs server-side with eraseStore
    // parity; the host-side ephemeral TTL sweep is built on bySubject.
    erase: {
      async bySubject(subject) {
        return parseReport(await sendJson("/erase", { subject }));
      },
      async byApp(appId) {
        return parseReport(await sendJson("/erase", { appId }));
      },
    },
    // The service owns its migrations; there is nothing to migrate from here.
    async ensureSchema() {},
    // No local pool, no PGlite handle — nothing to release.
    async close() {},
    raw() {
      throw new Error(
        "[vendo] hostedStore has no local database handle — raw() requires a local createStore store",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The 31-op StoreOps client — store design v1, `vendo/store-wire@1`
// ---------------------------------------------------------------------------

/** The 31 named ops — STORE_WIRE_PATHS' keys ARE the op names, and stay the
 * op names even where the console's door sits at a different path. */
type StoreWireOp = keyof typeof STORE_WIRE_PATHS;

/** ONE key per LOGICAL mutation. The retry below replays it verbatim — that
 * replay is the only reason the server can tell "do it again" from "you
 * already did it"; a fresh key per attempt would double-apply the write. */
const newIdempotencyKey = (): string => `idm_${globalThis.crypto.randomUUID()}`;

/** Blob bytes are base64 on the wire (storeWireBlobsPutRequestSchema) —
 * Buffer-free so the client stays runnable on edge runtimes. */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** `AbortSignal.timeout` rejects with a DOMException named TimeoutError (a
 * caller-side abort surfaces as AbortError): no answer came back, so the
 * mutation may or may not have landed — exactly the Idempotency-Key's case. */
const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/** The protocol's own client half owns the mapping (parseStoreWireError): an
 * enveloped code wins, recognized statuses map, everything else degrades to
 * not-implemented rather than blaming the caller. */
const raiseWireError = async (response: Response): Promise<never> => {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = undefined;
  }
  throw parseStoreWireError(response.status, payload);
};

/**
 * The Cloud client for the whole 31-op store contract, speaking
 * `vendo/store-wire@1` over the console's store mount: bearer key, deployment
 * identity and per-request abort budget shared with {@link hostedStore}, the
 * same adapter rule (behavior comes ONLY from the constructor arguments),
 * cursors passed through untouched (the server paginates, never the client),
 * and ONE Idempotency-Key per logical mutation, replayed verbatim on a retry.
 *
 * Records and blobs speak the EXPORTED contract: STORE_WIRE_PATHS routes with
 * the storeWire*RequestSchema bodies — collection/namespace/key ride the JSON
 * body and blob bytes are base64 on the wire — so any conforming Store Wire v1
 * service (the console's wire mount, a BYO httpStore) accepts them verbatim.
 * Transcripts, harness, workspace, `lifecycle.promote` and `/status` answer at
 * their STORE_WIRE_PATHS path too. Erase keeps `/erase`, and adopt + the
 * session verbs keep `/sessions/*` — T5's own note: they "keep their existing
 * doors until the cloud client moves them".
 */
export function hostedStoreOps(options: HostedStoreOptions): StoreOps {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const send = consoleSender({
    base,
    mountPath: CONSOLE_STORE_PATH,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? defaultFetch,
    raise: raiseWireError,
  });

  const call = async (op: StoreWireOp, path: string, init?: RequestInit): Promise<Response> => {
    const attempt = (): Promise<Response> => send(path, init);
    try {
      // The retry sends the SAME init — same key, same body — so a mutation
      // the server already applied is deduped instead of applied twice.
      return await attempt().catch((error: unknown) => (isTimeout(error) ? attempt() : Promise.reject(error)));
    } catch (error) {
      // A 501 (or an enveloped not-implemented) means this mount does not
      // serve this op: name it, and let it surface as a failure — never a
      // silent fallback, never a half-applied local mutation.
      if (error instanceof VendoError && error.code === "not-implemented") {
        throw new VendoError(
          "not-implemented",
          `Vendo Cloud store does not support the "${op}" operation — ${error.message}`,
        );
      }
      throw error;
    }
  };

  const json = async (response: Response): Promise<unknown> => response.json().catch(() => ({}));
  const get = async (op: StoreWireOp, path: string): Promise<unknown> => json(await call(op, path));
  const post = async (op: StoreWireOp, path: string, body: unknown, idempotencyKey?: string): Promise<unknown> =>
    json(await call(op, path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      body: JSON.stringify(body),
    }));

  /** Every mutation gets its key here, at the logical operation's one call. */
  const mutate = (op: StoreWireOp, path: string, body: unknown, idempotencyKey = newIdempotencyKey()): Promise<unknown> =>
    post(op, path, body, idempotencyKey);

  const field = <T>(payload: unknown, name: string, what: string, ok: (value: unknown) => boolean): T => {
    const value = (payload as Record<string, unknown> | null | undefined)?.[name];
    if (!ok(value)) invalidResponse(what);
    return value as T;
  };
  const recordOf = (payload: unknown): VendoRecord =>
    parseRecord(field(payload, "record", "invalid record", (value) => value !== undefined && value !== null));
  const nullableRecordOf = (payload: unknown): VendoRecord | null =>
    parseNullableRecord(field(payload, "record", "invalid record", (value) => value !== undefined));
  const cursorOf = (payload: unknown): { cursor?: string } => {
    const cursor = (payload as { cursor?: unknown }).cursor;
    return typeof cursor === "string" ? { cursor } : {};
  };
  const listOf = (payload: unknown): { records: VendoRecord[]; cursor?: string } => ({
    records: field<unknown[]>(payload, "records", "invalid list", Array.isArray).map(parseRecord),
    ...cursorOf(payload),
  });
  const entriesOf = (payload: unknown): { entries: unknown[]; cursor?: string } => ({
    entries: field<unknown[]>(payload, "entries", "invalid entries", Array.isArray),
    ...cursorOf(payload),
  });
  const claimedOf = (payload: unknown): boolean =>
    field<boolean>(payload, "claimed", "invalid claim", (value) => typeof value === "boolean");
  const reportOf = (payload: unknown): unknown =>
    field(payload, "report", "invalid report", (value) => value !== undefined);

  const cursorQuery = (query?: { cursor?: string; limit?: number }): Record<string, unknown> => ({ ...query });

  /** The workspace family's owner, passed through only when the caller named
      one — a mount that binds its own owner must not be handed `undefined`. */
  const owned = (opts?: { owner?: string }): Record<string, unknown> =>
    opts?.owner === undefined ? {} : { owner: opts.owner };

  const P = STORE_WIRE_PATHS;

  return {
    records: {
      async get(collection, id) {
        return nullableRecordOf(await post("records.get", P["records.get"], { collection, id }));
      },
      async put(collection, record) {
        return recordOf(await mutate("records.put", P["records.put"], { collection, record }));
      },
      async delete(collection, id) {
        await mutate("records.delete", P["records.delete"], { collection, id });
      },
      async list(collection, query) {
        return listOf(await post("records.list", P["records.list"], { collection, query: query ?? {} }));
      },
      async claim(collection, expected, replacement) {
        return claimedOf(await mutate("records.claim", P["records.claim"], {
          collection,
          expected,
          ...(replacement === undefined ? {} : { replacement }),
        }));
      },
      async insertIfAbsent(collection, record) {
        return nullableRecordOf(
          await mutate("records.insertIfAbsent", P["records.insertIfAbsent"], { collection, record }),
        );
      },
      async compareAndSwap(collection, record, expectedRevision) {
        return nullableRecordOf(
          await mutate("records.compareAndSwap", P["records.compareAndSwap"], {
            collection,
            record,
            expectedRevision,
          }),
        );
      },
    },
    blobs: {
      async put(namespace, key, bytes, meta) {
        await mutate("blobs.put", P["blobs.put"], {
          namespace,
          key,
          bytes: bytesToBase64(bytes),
          ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
        });
      },
      async get(namespace, key) {
        let payload: unknown;
        try {
          payload = await post("blobs.get", P["blobs.get"], { namespace, key });
        } catch (error) {
          // A missing blob is null at the seam (01-core §12), whether the
          // service answers `{blob: null}` or an ENVELOPED not-found. A bare
          // 404 has already degraded to not-implemented and stays loud: a
          // misdeployed base URL must not read as an empty blob store forever.
          if (error instanceof VendoError && error.code === "not-found") return null;
          throw error;
        }
        const blob = field<Record<string, unknown> | null>(
          payload,
          "blob",
          "invalid blob",
          (value) => value === null || (typeof value === "object" && value !== null && typeof (value as { bytes?: unknown }).bytes === "string"),
        );
        if (blob === null) return null;
        return {
          bytes: base64ToBytes(blob["bytes"] as string),
          ...(typeof blob["contentType"] === "string" ? { contentType: blob["contentType"] } : {}),
        };
      },
      async delete(namespace, key) {
        await mutate("blobs.delete", P["blobs.delete"], { namespace, key });
      },
      async list(namespace, prefix) {
        return field<string[]>(
          await post("blobs.list", P["blobs.list"], {
            namespace,
            ...(prefix === undefined || prefix === "" ? {} : { prefix }),
          }),
          "keys",
          "invalid blob list",
          (value) => Array.isArray(value) && value.every((key) => typeof key === "string"),
        );
      },
    },
    transcripts: {
      async putThread(thread) {
        return recordOf(await mutate("transcripts.putThread", P["transcripts.putThread"], { thread }));
      },
      async getThread(id, opts) {
        return nullableRecordOf(await post("transcripts.getThread", P["transcripts.getThread"], { id, ...cursorQuery(opts) }));
      },
      async listThreads(query) {
        return listOf(await post("transcripts.listThreads", P["transcripts.listThreads"], { ...query }));
      },
      async deleteThread(id) {
        await mutate("transcripts.deleteThread", P["transcripts.deleteThread"], { id });
      },
      async putMessage(threadId, message) {
        return recordOf(await mutate("transcripts.putMessage", P["transcripts.putMessage"], { threadId, message }));
      },
      async recordAnswer(threadId, answer) {
        return recordOf(await mutate("transcripts.recordAnswer", P["transcripts.recordAnswer"], { threadId, answer }));
      },
    },
    harness: {
      async get(appId, subject) {
        return field(
          await post("harness.get", P["harness.get"], { appId, subject }),
          "state",
          "invalid harness state",
          (value) => value !== undefined,
        );
      },
      async set(appId, subject, state) {
        await mutate("harness.set", P["harness.set"], { appId, subject, state });
      },
      async clear(appId, subject) {
        await mutate("harness.clear", P["harness.clear"], { appId, subject });
      },
    },
    // Every workspace call names its OWNER: the mount serves a whole project,
    // so without one its users would share a single drawer. Entries carry the
    // wire's tombstones (`delete: true`) and strict-CAS `expectedRevision`
    // through verbatim — the service reports a lost swap as an enveloped
    // `conflict`, which the façade reads as the frozen conflict branch.
    workspace: {
      async index(query) {
        return entriesOf(await post("workspace.index", P["workspace.index"], { ...query }));
      },
      async read(paths, opts) {
        return field<Record<string, unknown>>(
          await post("workspace.read", P["workspace.read"], { paths, ...owned(opts) }),
          "files",
          "invalid workspace read",
          (value) => typeof value === "object" && value !== null && !Array.isArray(value),
        );
      },
      async commit(entries, opts) {
        // The caller may own the key (a resumed job replaying its own commit);
        // otherwise `mutate` mints the one key for this operation.
        await mutate(
          "workspace.commit",
          P["workspace.commit"],
          { entries, ...owned(opts) },
          opts?.idempotencyKey,
        );
      },
      async history(query) {
        return entriesOf(await post("workspace.history", P["workspace.history"], { ...query }));
      },
    },
    lifecycle: {
      // The erase door takes the target FLAT (exactly one of subject/appId);
      // adopt and the session verbs are the console's registry doors.
      async erase(target) {
        return reportOf(await mutate("lifecycle.erase", "/erase", target));
      },
      async adopt(from, to) {
        return reportOf(await mutate("lifecycle.adopt", "/sessions/adopt", { from, to }));
      },
      async promote(appId, orgId) {
        await mutate("lifecycle.promote", P["lifecycle.promote"], { appId, orgId });
      },
      async sessionRegister(subject, now) {
        await mutate("lifecycle.session.register", "/sessions/register", {
          subject,
          ...(now === undefined ? {} : { now }),
        });
      },
      async sessionStale(idleMs, now) {
        const payload = await post("lifecycle.session.stale", "/sessions/stale", {
          idleMs,
          ...(now === undefined ? {} : { now }),
        });
        return field<string[]>(
          payload,
          "subjects",
          "invalid stale",
          (value) => Array.isArray(value) && value.every((subject) => typeof subject === "string"),
        );
      },
      async sessionClaim(subject, idleMs, now) {
        return claimedOf(await mutate("lifecycle.session.claim", "/sessions/claim", {
          subject,
          idleMs,
          ...(now === undefined ? {} : { now }),
        }));
      },
    },
    async status(): Promise<StoreWireStatus> {
      const parsed = storeWireStatusSchema.safeParse(await get("status", P.status));
      if (!parsed.success) invalidResponse("invalid status");
      return parsed.data as StoreWireStatus;
    },
  };
}
