/**
 * The persistence half of the ADAPTER RULE: which store composes, and the ONE
 * files adapter every consumer shares.
 *
 * Moved out of server.ts with the composition that calls it.
 */
import type { FilesAdapter, StoreOps } from "@vendoai/core";
import {
  createStore,
  createStoreOps,
  hostedStore,
  maybeDbFor,
  storeFiles,
  threadMessageStore,
  type HostedStore,
  type VendoStore,
} from "@vendoai/store";
import { cloudKeyOptions } from "./compose-selection.js";
import { keepAliveFetch } from "./keep-alive-fetch.js";
import { environment } from "./wire/shared.js";

/** Per-PROCESS latch for the hosted-store automations notice below — a dev
    server recomposes on nearly every request, and the paragraph is a boot
    fact, not a per-request one (self-serve audit F7). On `globalThis` and not in
    module scope, for the same reason boot-summary.ts's latch is: Next's dev
    server re-instantiates the module too, so a module-scoped `let` resets with
    it and the notice comes back every couple of seconds. */
const NOTICE_PRINTED = Symbol.for("vendo.compose-store.hosted-notice");
const latches = globalThis as unknown as Record<symbol, true | undefined>;

/** A host may also pass hostedStore({...}) explicitly via createVendo({ store }).
    Recognised by the erase cascade it carries over the store wire — the one
    door no local `VendoStore` shape offers — so the automations notice and the
    /tick sweep know they are talking to Vendo Cloud. */
export function isHostedStore(store: VendoStore): store is HostedStore {
  const candidate = store as Partial<HostedStore>;
  return typeof candidate.erase?.bySubject === "function";
}

/** ADAPTER RULE, store seam (cloned from selectConnections): persistence is
    one VendoStore; which implementation composes is decided HERE. Precedence,
    top to bottom:
      1. an explicitly passed store always wins (BYO — the host's own Postgres
         or PGlite via createStore, the hard BYO rule);
      2. VENDO_API_KEY makes the Cloud hosted store the default for the seam
         the host left unfilled (VENDO_CLOUD_URL overrides the console base) —
         Vendo data lives with Vendo, tenant = the key's org, resolved
         server-side on every call;
      3. the local createStore default (02-store §4 re-derived: encryption is
         a production-owned concern — with VENDO_STORE_ENCRYPTION_KEY set,
         stored secrets encrypt at rest; without it, dev mode stores locally
         unencrypted (the data dir is gitignored) while production secret
         writes fail closed with instructions).
    The adapters themselves never read the environment. */
/** ADAPTER RULE, files seam (build contract §3.4): the one place a
    `FilesAdapter` is chosen. Explicit `files:` wins (BYO — any S3-compatible
    bucket, or the host's own); unset, the store's `vendo_blobs` backs it up
    to `FILES_STORE_MAX_BYTES`, and the over-cap error names `files:` by name.

    Deliberately NOT defaulted at each call site. The workspace writes blobs and
    the erase cascade deletes them, and if those two ever resolve separately, a
    host who wires `files:` gets rows deleted and objects left behind forever.
    One resolution, returned beside the store it may be backed by, so every
    consumer is handed the same instance. */
/** Which of the two backings that resolution landed on — the same vocabulary
    the boot summary's `files` row prints, so the upload door can name where a
    refused file would have gone. */
export type FilesVenue = "byo" | "store";

function selectFiles(configured: FilesAdapter | undefined, store: VendoStore): FilesAdapter {
  if (configured !== undefined) return configured;
  // Deferred to first use, not built at compose: `storeFiles` resolves a blob
  // handle off the store, and `createVendo` must stay I/O-free at module init
  // (the portability gate — Workers forbids work in global scope). Memoized, so
  // every consumer still shares ONE adapter, which is the whole point.
  let backing: FilesAdapter | undefined;
  const blobs = (): FilesAdapter => (backing ??= storeFiles(store));
  return {
    put: (key, bytes, meta) => blobs().put(key, bytes, meta),
    get: (key) => blobs().get(key),
    delete: (key) => blobs().delete(key),
  };
}

/**
 * Can this store keep a harness turn's transcript at all?
 *
 * Asked by attempting the transcript door and catching ITS refusal, rather than
 * re-deriving the rule here: `threadMessageStore` already knows every shape that
 * can serve one (Vendo's own tables, or an adapter that speaks StoreOps), and a
 * second copy of that knowledge would drift from it. Construction only — a
 * property read, never I/O — so it is safe where `createVendo` runs at module
 * init (Workers).
 *
 * One caller left: the `vendo_delegate` gate below. It used to pick the chat
 * route too, back when a deployment that failed this kept the shipped
 * `agent.stream` path; that second engine is gone, so a store that fails here
 * cannot serve chat either and says so on its own.
 */
export function storeServesHarnessTurns(store: VendoStore): boolean {
  try {
    threadMessageStore(store);
    return true;
  } catch {
    return false;
  }
}

/** ADAPTER RULE, the ops half of the SAME seam: one store, one named-operation
    surface, chosen here beside it. A store that carries its own `ops` wins —
    `VendoStore.ops` is declared optional for exactly this, and the hosted
    store's client is the same `vendo/store-wire@1` the local backend would be
    re-encoding, one hop shorter. A store with a SQL handle gets the local
    backend over it, holding THE files adapter so app files and blobs land in
    the one place the erase cascade reads.

    `undefined` for a store with NEITHER — the same three-way answer
    `@vendoai/store`'s own `backendOf` gives, and the reason this resolves the
    handle here instead of calling `createStoreOps` unconditionally: that call
    opens the handle eagerly, so composition would crash at boot for a host
    whose store has none, where today it refuses at the op that needed one. */
export function selectStoreOps(store: VendoStore, files: FilesAdapter): StoreOps | undefined {
  if (store.ops !== undefined) return store.ops;
  return maybeDbFor(store) === undefined ? undefined : createStoreOps(store, { files });
}

export function selectStore(
  configured: VendoStore | undefined,
  configuredFiles: FilesAdapter | undefined,
): {
  store: VendoStore;
  /** THE files adapter for this deployment. Every consumer takes it from here. */
  files: FilesAdapter;
  /** THE 42-op surface for this deployment, over that same store and adapter —
      absent when the store offers neither its own ops nor a SQL handle. */
  ops: StoreOps | undefined;
} {
  const selected = ((): VendoStore => {
    if (configured !== undefined) return configured;
    const cloud = cloudKeyOptions();
    // The kept-alive pool is the umbrella's to supply: it reaches undici, so it
    // cannot live in @vendoai/store, which @vendoai/agents composes on an edge
    // target too. A host passing its own `fetch` still wins (adapter rule).
    if (cloud !== undefined) return hostedStore({ ...cloud, fetch: keepAliveFetch });
    const encryptionKey = environment("VENDO_STORE_ENCRYPTION_KEY");
    return createStore(encryptionKey === undefined
      ? { allowUnencryptedSecrets: environment("NODE_ENV") !== "production" }
      : { encryption: { key: encryptionKey } });
  })();
  // ONE files instance, shared by the return and the ops surface below — the
  // whole reason selectFiles resolves once (the workspace writes blobs, the
  // erase cascade deletes them).
  const files = selectFiles(configuredFiles, selected);
  return { store: selected, files, ops: selectStoreOps(selected, files) };
}

/** The hosted-store automations notice, printed at most once per process. */
export function reportHostedStoreOnce(): void {
  if (latches[NOTICE_PRINTED] === true) return;
  latches[NOTICE_PRINTED] = true;
  console.warn(
    "[vendo] Vendo Cloud is the hosted store for this deployment. Every automation still runs HERE, in "
    + "this process — Cloud holds no schedule and decides nothing about what is due; it just knocks on "
    + "POST /api/vendo/tick once a minute so this engine can. A development process ticks itself.",
  );
}
