import {
  type BlobStore,
  cloudStandingError,
  consoleSender,
  defaultFetch,
  parseStoreWireError,
  raiseCloudError,
  type RecordInput,
  type RecordQuery,
  type RecordStore,
  STORE_WIRE_PATHS,
  type StoreOps,
  storeWireErrorSchema,
  type StoreWireStatus,
  storeWireStatusSchema,
  VendoError,
  type VendoRecord,
  vendoRecordSchema,
} from "@vendoai/core";
import type { EraseReport } from "./erase.js";
import { DEDICATED_RECORD_COLLECTIONS, RESERVED_COLLECTIONS } from "./routing.js";
import type { VendoStore } from "./store.js";

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
  /** Whose drawer the StoreAdapter façade addresses when the collection (or
   * blob namespace) is app-scoped — `app:<appId>:<name>`, which the appData
   * family serves, and appData scopes every read and stamps every write with an
   * owner. The op surface (`ops.appData`) is unaffected: every one of its verbs
   * already carries the owner in its target.
   *
   * This option exists because the façade's signature has nowhere to put one:
   * `records(collection)` takes a string, and the caller never had to think
   * about ownership while the generic records family served these rows
   * unscoped. It cannot be inferred — an owner is the host's own user id in the
   * host's own spelling — so it is bound here, once, exactly as
   * `createStoreOps`' `workspaceOwner` binds the workspace drawer.
   *
   * READ THIS BEFORE LEAVING IT UNSET. The default is the single-player
   * `"user_local"`, and it is a real footgun for anyone else: a host that
   * serves MORE THAN ONE end user through one `hostedStore` instance and takes
   * the default puts every user's app rows and files in ONE owner's drawer,
   * where they read each other's data. Nothing refuses it — `"user_local"` is a
   * legal owner — so the symptom is cross-user reads in production, not an
   * error at composition. A multi-user mount constructs one `hostedStore` per
   * end user with that user's subject here, or stays on `ops.appData`, whose
   * every verb names its owner at the call. */
  owner?: string;
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
  /** The 36-op named-operation surface over the same mount and the same key —
   * `vendo/store-wire@1` (see {@link hostedStoreOps}). The StoreAdapter doors
   * above are built ON these ops: engine for Vendo's own collections, appData
   * for an app's own drawers. */
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

function parseRecord(value: unknown): VendoRecord {
  const parsed = vendoRecordSchema.safeParse(value);
  if (!parsed.success) invalidResponse("invalid record");
  return parsed.data as VendoRecord;
}

function parseNullableRecord(value: unknown): VendoRecord | null {
  if (value === null) return null;
  return parseRecord(value);
}

/** `app:<appId>:<collection>` is the app-scoped spelling of a record collection
 * and of a blob namespace alike (01-core §12). Split back into the appData
 * target it addresses, or undefined for a name that is not app-scoped. The
 * appId segment is colon-free by construction, so the FIRST colon after the
 * prefix ends it and everything after is the collection (`box:`-prefixed names
 * keep their own colon). */
const APP_SCOPE = /^app:([^:]+):(.+)$/;

const appScope = (scope: string): { appId: string; collection: string } | undefined => {
  const match = APP_SCOPE.exec(scope);
  return match === null ? undefined : { appId: match[1]!, collection: match[2]! };
};

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

  // The StoreAdapter façade rides the SAME 36 ops as `ops` below — it has no
  // doors of its own since the generic records family left the wire. A
  // collection (or blob namespace) either names an app's own drawer, which the
  // appData family serves with the owner stamped on, or it names one of Vendo's
  // own, which the engine family serves behind its allowlist. There is no third
  // home, so a host collection the allowlist does not know is refused by the
  // service rather than quietly written somewhere. It reads a failure the way
  // this adapter always has (raiseStoreError), not the way the protocol client
  // does — see storeWireClient.
  const facade = storeWireClient(options, raiseStoreError);
  const owner = options.owner ?? "user_local";
  const targetFor = (scope: { appId: string; collection: string }) => ({ ...scope, owner });

  const records = (collection: string): RecordStore => {
    const scope = appScope(collection);
    if (scope !== undefined) {
      const target = targetFor(scope);
      // No claim and no atomic: the appData family has no compare-and-set verbs
      // on the wire, and an adapter that advertises a capability it cannot
      // serve is worse than one that omits it (01-core §12 makes both optional).
      return {
        get: (id) => facade.appData.get(target, id),
        put: (record) => facade.appData.put(target, record),
        delete: (id) => facade.appData.delete(target, id),
        list: (query?: RecordQuery) => facade.appData.list(target, query),
      };
    }

    const store: RecordStore = {
      get: (id) => facade.engine.get(collection, id),
      put: (record) => facade.engine.put(collection, record),
      delete: (id) => facade.engine.delete(collection, id),
      list: (query?: RecordQuery) => facade.engine.list(collection, query),
    };

    // Capability mirror of the store engine's routing (02-store §2): routed
    // reserved collections expose no claim; atomic rides generic collections
    // and vendo_threads' revision counter only. Mirroring the shape here keeps
    // feature detection (`records.atomic !== undefined`) identical on both
    // sides of the wire.
    const reserved = (RESERVED_COLLECTIONS as readonly string[]).includes(collection);
    const dedicated = (DEDICATED_RECORD_COLLECTIONS as readonly string[]).includes(collection);
    if (!reserved) {
      store.claim = (expected: RecordInput, replacement?: Pick<VendoRecord, "data" | "refs">) =>
        facade.engine.claim(collection, expected, replacement);
    }
    if ((!reserved && !dedicated) || collection === "vendo_threads") {
      store.atomic = {
        insertIfAbsent: (record) => facade.engine.insertIfAbsent(collection, record),
        compareAndSwap: (record, expectedRevision) => facade.engine.compareAndSwap(collection, record, expectedRevision),
      };
    }
    return store;
  };

  const blobs = (namespace: string): BlobStore => {
    const scope = appScope(namespace);
    if (scope !== undefined) {
      const target = targetFor(scope);
      return {
        put: (key, bytes, meta) => facade.appData.putFile(target, key, bytes, meta),
        get: (key) => facade.appData.getFile(target, key),
        delete: (key) => facade.appData.deleteFile(target, key),
        list: (prefix) => facade.appData.listFiles(target, prefix),
      };
    }
    return {
      put: (key, bytes, meta) => facade.blobs.put(namespace, key, bytes, meta),
      get: (key) => facade.blobs.get(namespace, key),
      delete: (key) => facade.blobs.delete(namespace, key),
      list: (prefix) => facade.blobs.list(namespace, prefix),
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

  return {
    records,
    blobs,
    ops: hostedStoreOps(options),
    // 02-store §5 — the subject/app cascade runs server-side with eraseStore
    // parity.
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
// The 36-op StoreOps client — store design v1, `vendo/store-wire@1`
// ---------------------------------------------------------------------------

/** The 36 named ops — STORE_WIRE_PATHS' keys ARE the op names, and stay the
 * op names even where the console's door sits at a different path. */
type StoreWireOp = keyof typeof STORE_WIRE_PATHS;

/** Measurement instrument, not a feature: with VENDO_STORE_TRACE set, every
 * call through the store client below — the 35 ops AND the StoreAdapter façade,
 * which rides the same client — emits one greppable stderr line naming the op,
 * its path, the round trip in milliseconds (the body read included, since that
 * is what the caller waits for), the response size in bytes and the outcome.
 * Read ONCE at import, like the skew latch below: a debug switch belongs to the
 * process, so the adapter itself still reads nothing at construction or on any
 * call, and unset there is no wrapper to pay for. */
const TRACE = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.VENDO_STORE_TRACE !== undefined;

/** The `outcome=` field of a FAILED call's trace line. Failures are the tail of
 * the latency distribution, not an afterthought: an exhausted 30s budget is the
 * slowest call this client ever makes, so tracing successes alone would drop
 * exactly the calls the measurement exists to find and make a turn read as fast
 * as its lucky requests. The server's code where there is one (VendoError and
 * the console's mapped errors both carry it), else the error's name —
 * `TimeoutError` for a spent budget. */
const traceOutcome = (error: unknown): string => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
};

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
 * not-implemented rather than blaming the caller. The one exception is a BARE
 * standing refusal (401/402 with no wire-legal envelope), which this client —
 * a Vendo Cloud client, not a BYO mount's — reads as cloud-required with the
 * console's own message, so a revoked key never masquerades as an unsupported
 * op. The console's own refusals are always bare in that sense: `unauthorized`
 * and `meter-exhausted` are not wire codes, so a 401/402 that DOES carry a
 * recognized envelope came from the service's protocol half and keeps it. */
const raiseWireError = async (response: Response): Promise<never> => {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = undefined;
  }
  if (storeWireErrorSchema.safeParse(payload).success) throw parseStoreWireError(response.status, payload);
  throw cloudStandingError(response.status, payload, `Vendo Cloud store request failed with ${response.status}`)
    ?? parseStoreWireError(response.status, payload);
};

/**
 * The Cloud client for the whole 36-op store contract, speaking
 * `vendo/store-wire@1` over the console's store mount: bearer key, deployment
 * identity and per-request abort budget shared with {@link hostedStore}, the
 * same adapter rule (behavior comes ONLY from the constructor arguments),
 * cursors passed through untouched (the server paginates, never the client),
 * and ONE Idempotency-Key per logical mutation, replayed verbatim on a retry.
 *
 * Every family speaks the EXPORTED contract: STORE_WIRE_PATHS routes with the
 * storeWire*RequestSchema bodies — collection/namespace/key ride the JSON body
 * and blob bytes are base64 on the wire — so any conforming Store Wire v1
 * service (the console's wire mount, a BYO httpStore) accepts them verbatim.
 * Transcripts, harness, workspace, `lifecycle.promote` and `/status` answer at
 * their STORE_WIRE_PATHS path too; erase keeps `/erase` — T5's own note: it
 * "keeps its existing door until the cloud client moves it".
 */
export function hostedStoreOps(options: HostedStoreOptions): StoreOps {
  return storeWireClient(options, raiseWireError);
}

/** The client above, with the error mapping left to the caller. The two
 * surfaces over this ONE wire read a failure differently and always have: the
 * op surface is the PROTOCOL's client, so it reads the protocol's own envelope
 * ({@link parseStoreWireError}); the StoreAdapter façade is the CONSOLE's
 * client, so it keeps the console's mapping — the 402 meter refusal's crafted
 * dollar sentence and the 401 key story are console answers no BYO mount
 * sends. Same routes, same bodies, same key; only the reading of a non-2xx
 * differs, exactly as it did when the façade had doors of its own. */
function storeWireClient(
  options: HostedStoreOptions,
  raise: (response: Response) => Promise<never>,
): StoreOps {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const send = consoleSender({
    base,
    mountPath: CONSOLE_STORE_PATH,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? defaultFetch,
    raise,
  });

  const wire = async (op: StoreWireOp, path: string, init?: RequestInit): Promise<Response> => {
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
        // "Unknown store operation" is the console's catch-all for an op it
        // has never heard of — which, for an op this client SHIPPED with,
        // means the console moved past the client (#1251; field 2026-08-13:
        // every thread route silently 501'd through an hour of "chat is
        // broken" before the skew was diagnosed). Say the real cause, and
        // log it once so a server operator sees it without a debugger.
        const skew = error.message.includes("Unknown store operation");
        if (skew) reportStoreSkewOnce(op, error.message);
        throw new VendoError(
          "not-implemented",
          `Vendo Cloud store does not support the "${op}" operation — ${error.message}`
            + (skew
              ? " The console no longer serves this operation, which usually means this @vendoai/vendo is older than the console — update the package to restore Cloud persistence."
              : ""),
        );
      }
      throw error;
    }
  };

  /** Untraced, `call` IS `wire` — see {@link TRACE}. */
  const call: typeof wire = !TRACE ? wire : async (op, path, init) => {
    const started = performance.now();
    const line = (bytes: number, outcome: string): void =>
      console.error(
        `vendo-store-trace op=${op} path=${path} ms=${Math.round(performance.now() - started)} bytes=${bytes} outcome=${outcome}`,
      );
    let response: Response;
    try {
      response = await wire(op, path, init);
    } catch (error) {
      // A refusal has a body, but `wire` already consumed it to build this
      // error — the bytes are gone and the failure is what mattered anyway.
      line(0, traceOutcome(error));
      throw error;
    }
    // Measure a CLONE and hand back the response `wire` returned, untouched.
    // Rebuilding it instead would be a real behavior change on a null-body
    // status — `new Response(body, { status: 204 })` throws — and would put the
    // instrument in the path of every hosted call it is supposed to observe.
    //
    // Measuring must never FAIL the call it is measuring either. A body stream
    // that breaks mid-read is not an error to this client: `json`'s catch reads
    // it as `{}`, which a void mutation ignores entirely and a payload reader
    // reports as service misbehavior. Letting the measurement's own rejection
    // escape would turn tracing on into "some calls now fail", which is the one
    // thing an instrument may not do — so a broken read is a fact ABOUT the
    // call, recorded in the line, not a fact that changes it.
    let bytes = 0;
    let outcome = "ok";
    try {
      bytes = (await response.clone().arrayBuffer()).byteLength;
    } catch {
      outcome = "unreadable-body";
    }
    line(bytes, outcome);
    return response;
  };

  const json = async (response: Response): Promise<unknown> => response.json().catch(() => ({}));
  // One loud line per PROCESS when the console rejects a shipped op (#1251).
  // The flag rides globalThis via Symbol.for: dev module churn re-creates
  // this factory freely, and the operator still gets exactly one diagnosis.
  const reportStoreSkewOnce = (op: StoreWireOp, message: string): void => {
    const host = globalThis as unknown as Record<symbol, unknown>;
    const flag = Symbol.for("vendo.hosted-store-skew-reported");
    if (host[flag] === true) return;
    host[flag] = true;
    console.error(
      `[vendo] Vendo Cloud rejected the "${op}" store operation (${message}) — the console is newer than this @vendoai/vendo. Update the package; until then, store-backed routes fail with 501.`,
    );
  };
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

  /** The one file-read posture, shared by `blobs.get` and `appData.getFile` so
      the two can never drift: a missing file is null at the seam (01-core §12),
      whether the service answers `{blob: null}` or an ENVELOPED not-found. A
      bare 404 has already degraded to not-implemented and stays loud — a
      misdeployed base URL must not read as an empty blob store forever. */
  const fileOf = async (
    op: StoreWireOp,
    path: string,
    body: unknown,
  ): Promise<{ bytes: Uint8Array; contentType?: string } | null> => {
    let payload: unknown;
    try {
      payload = await post(op, path, body);
    } catch (error) {
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
  };

  const keysOf = (payload: unknown): string[] =>
    field<string[]>(
      payload,
      "keys",
      "invalid blob list",
      (value) => Array.isArray(value) && value.every((key) => typeof key === "string"),
    );

  /** The workspace family's owner, passed through only when the caller named
      one — a mount that binds its own owner must not be handed `undefined`. */
  const owned = (opts?: { owner?: string }): Record<string, unknown> =>
    opts?.owner === undefined ? {} : { owner: opts.owner };

  const P = STORE_WIRE_PATHS;

  return {
    // Vendo's OWN engine drawers, over collection-addressed bodies, with the
    // allowlist gated service-side on every verb.
    engine: {
      async get(collection, id) {
        return nullableRecordOf(await post("engine.get", P["engine.get"], { collection, id }));
      },
      async put(collection, record) {
        return recordOf(await mutate("engine.put", P["engine.put"], { collection, record }));
      },
      async delete(collection, id) {
        await mutate("engine.delete", P["engine.delete"], { collection, id });
      },
      async list(collection, query) {
        return listOf(await post("engine.list", P["engine.list"], { collection, query: query ?? {} }));
      },
      async claim(collection, expected, replacement) {
        return claimedOf(await mutate("engine.claim", P["engine.claim"], {
          collection,
          expected,
          ...(replacement === undefined ? {} : { replacement }),
        }));
      },
      async insertIfAbsent(collection, record) {
        return nullableRecordOf(
          await mutate("engine.insertIfAbsent", P["engine.insertIfAbsent"], { collection, record }),
        );
      },
      async compareAndSwap(collection, record, expectedRevision) {
        return nullableRecordOf(
          await mutate("engine.compareAndSwap", P["engine.compareAndSwap"], {
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
        return fileOf("blobs.get", P["blobs.get"], { namespace, key });
      },
      async delete(namespace, key) {
        await mutate("blobs.delete", P["blobs.delete"], { namespace, key });
      },
      async list(namespace, prefix) {
        return keysOf(await post("blobs.list", P["blobs.list"], {
          namespace,
          ...(prefix === undefined || prefix === "" ? {} : { prefix }),
        }));
      },
    },
    // Everything generated apps invent. The whole address rides ONE `target`
    // (appId + collection + owner) instead of a collection string, because the
    // owner is the runtime's stamp: the service scopes reads and stamps writes
    // from it, so no verb here takes a subject.
    appData: {
      async put(target, record) {
        return recordOf(await mutate("appData.put", P["appData.put"], { target, record }));
      },
      async get(target, id) {
        return nullableRecordOf(await post("appData.get", P["appData.get"], { target, id }));
      },
      async list(target, query) {
        return listOf(await post("appData.list", P["appData.list"], { target, query: query ?? {} }));
      },
      async delete(target, id) {
        await mutate("appData.delete", P["appData.delete"], { target, id });
      },
      async putFile(target, key, bytes, meta) {
        await mutate("appData.putFile", P["appData.putFile"], {
          target,
          key,
          bytes: bytesToBase64(bytes),
          ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
        });
      },
      async getFile(target, key) {
        return fileOf("appData.getFile", P["appData.getFile"], { target, key });
      },
      async listFiles(target, prefix) {
        return keysOf(await post("appData.listFiles", P["appData.listFiles"], {
          target,
          ...(prefix === undefined || prefix === "" ? {} : { prefix }),
        }));
      },
      async deleteFile(target, key) {
        await mutate("appData.deleteFile", P["appData.deleteFile"], { target, key });
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
      /** The answer is `{revision, count}`, NOT the thread: a batch append that
       *  echoed the transcript back would put the whole conversation on the
       *  wire on every turn, which is the download this op exists to delete.
       *  The subject in the body is what lets the service check ownership in
       *  its own statement instead of the client reading the thread first. */
      async appendMessages(threadId, subject, messages, opts) {
        const payload = await mutate("transcripts.appendMessages", P["transcripts.appendMessages"], {
          threadId,
          subject,
          messages,
          ...(opts?.title === undefined ? {} : { title: opts.title }),
        });
        return {
          revision: field<string>(payload, "revision", "invalid append", (value) => typeof value === "string"),
          count: field<number>(payload, "count", "invalid append", (value) => typeof value === "number"),
        };
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
      // The erase door takes the target FLAT (exactly one of subject/appId).
      async erase(target) {
        return reportOf(await mutate("lifecycle.erase", "/erase", target));
      },
      async promote(appId, orgId) {
        await mutate("lifecycle.promote", P["lifecycle.promote"], { appId, orgId });
      },
    },
    async status(): Promise<StoreWireStatus> {
      const parsed = storeWireStatusSchema.safeParse(await get("status", P.status));
      if (!parsed.success) invalidResponse("invalid status");
      return parsed.data as StoreWireStatus;
    },
  };
}
