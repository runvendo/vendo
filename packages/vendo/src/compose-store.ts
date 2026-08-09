/**
 * The persistence half of the ADAPTER RULE: which store composes, and the ONE
 * files adapter every consumer shares.
 *
 * Moved out of server.ts with the composition that calls it.
 */
import type { FilesAdapter } from "@vendoai/core";
import {
  createStore,
  storeFiles,
  threadMessageStore,
  type VendoStore,
} from "@vendoai/store";
import { cloudKeyOptions } from "./compose-selection.js";
import { hostedStore, type HostedStore } from "./hosted-store.js";
import { environment } from "./wire/shared.js";

/** Per-process latch for the hosted-store automations notice below — a dev
    server recomposes on nearly every request, and the paragraph is a boot
    fact, not a per-request one (self-serve audit F7). */
let hostedStoreNoticePrinted = false;

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

export function selectStore(
  configured: VendoStore | undefined,
  configuredFiles: FilesAdapter | undefined,
): {
  store: VendoStore;
  /** THE files adapter for this deployment. Every consumer takes it from here. */
  files: FilesAdapter;
} {
  const selected = ((): VendoStore => {
    if (configured !== undefined) return configured;
    const cloud = cloudKeyOptions();
    if (cloud !== undefined) return hostedStore(cloud);
    const encryptionKey = environment("VENDO_STORE_ENCRYPTION_KEY");
    return createStore(encryptionKey === undefined
      ? { allowUnencryptedSecrets: environment("NODE_ENV") !== "production" }
      : { encryption: { key: encryptionKey } });
  })();
  return { store: selected, files: selectFiles(configuredFiles, selected) };
}

/** The hosted-store automations notice, printed at most once per process. */
export function reportHostedStoreOnce(): void {
  if (hostedStoreNoticePrinted) return;
  hostedStoreNoticePrinted = true;
  console.warn(
    "[vendo] Vendo Cloud is the hosted store for this deployment: schedule and external-trigger "
    + "automations are Cloud's job (its scheduler and Composio delivery already fire them for this "
    + "deployment) — the local automations engine will not fire them itself, to avoid double-running "
    + "them. Host-event automations (vendo.emit) are unaffected.",
  );
}
