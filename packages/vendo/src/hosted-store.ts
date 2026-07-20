import {
  vendoRecordSchema,
  type BlobStore,
  type RecordInput,
  type RecordQuery,
  type RecordStore,
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

/** vendo-web@7cd0a02 (2026-07-19) deleted the console's ephemeral-session op
 * family (/api/v1/store/sessions/*) per spec — the removed routes answer
 * Next.js's BARE 404 page, no error envelope. Typed so the composition layer
 * (hostedSessionOps in server.ts) can disable the session doors gracefully
 * instead of failing anonymous traffic; an ENVELOPED 404 is a live console
 * answering "not-found" and keeps the loud path, same for every other
 * failure. */
export class HostedSessionDoorsMissingError extends Error {
  constructor() {
    super(
      "Vendo Cloud console does not serve /api/v1/store/sessions/* (removed in vendo-web@7cd0a02)",
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

/** The Cloud hosted-store adapter — the OSS side of the hosted-store seam
 * (docs/superpowers/specs/2026-07-18-hosted-store-onepager.md): a plain
 * StoreAdapter speaking RPC-over-HTTP to the console's /api/v1/store routes,
 * method for method. Tenant = the key's org, resolved server-side on every
 * call; reserved-collection semantics are enforced server-side by the same
 * engine rules as packages/store's routing. Secrets are excluded by
 * construction: the wire has no secrets surface, and storeSecrets/secretStore
 * keep requiring the local store handle. Cloned from cloudSandbox's shape:
 * behavior comes ONLY from constructor arguments (adapter rule — see
 * selectStore in server.ts); the adapter never reads the environment. */
export function hostedStore(options: HostedStoreOptions): HostedStore {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;

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
    const prefix = `/records/${encodeURIComponent(collection)}`;
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
    const prefix = `/blobs/${encodeURIComponent(namespace)}`;
    // Blob keys are paths ("images/a.png"); encode per segment so the key's
    // own separators survive as URL structure while each segment stays safe.
    const keyPath = (key: string): string =>
      `${prefix}/${key.split("/").map(encodeURIComponent).join("/")}`;
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
