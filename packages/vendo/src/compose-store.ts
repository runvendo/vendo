/**
 * The persistence half of the ADAPTER RULE: which store composes, the session
 * doors that travel with it, and the ONE files adapter every consumer shares.
 *
 * Moved out of server.ts with the composition that calls it.
 */
import type { FilesAdapter } from "@vendoai/core";
import {
  adoptEphemeralSubject,
  createStore,
  registerEphemeralSubject,
  storeFiles,
  sweepEphemeralSubjects,
  threadMessageStore,
  type SubjectMergeReport,
  type VendoStore,
} from "@vendoai/store";
import { cloudKeyOptions } from "./compose-selection.js";
import { HostedSessionDoorsMissingError, hostedStore, type HostedStore } from "./hosted-store.js";
import { environment } from "./wire/shared.js";

/** The ephemeral-session operations bound to the composed store (02-store §4):
    registration == touch, adoption on sign-in, and the TTL sweep. Selected
    WITH the store (selectStore below) because the local engine reaches its
    session registry over SQL while the hosted store reaches it over the
    store wire — downstream consumers (wire/context, the sweep) stay
    oblivious to which one they got. */
export interface SessionOps {
  register(subject: string, now: number): Promise<void>;
  adopt(from: string, to: string): Promise<SubjectMergeReport | null>;
  /** Erases every session idle ≥ idleMs; resolves the evicted subjects. */
  sweep(idleMs: number, now: number): Promise<string[]>;
}

/** Both doors erase workspace content, so both need the SAME files adapter the
    workspace wrote it with (build contract §3.4) — an erase against a different
    adapter drops the rows and leaves the objects, which is the blob-leak class
    lane B spent three rounds killing. `files` is therefore a required argument
    here, resolved once in {@link selectStore} and never defaulted locally. */
function localSessionOps(store: VendoStore, files: FilesAdapter): SessionOps {
  return {
    register: (subject, now) => registerEphemeralSubject(store, subject, now),
    adopt: (from, to) => adoptEphemeralSubject(store, from, to, { files }),
    sweep: (idleMs, now) => sweepEphemeralSubjects(store, { idleMs, now, files }),
  };
}

function hostedSessionOps(store: HostedStore, touchDebounceMs: number): SessionOps {
  // Last successful WIRE touch per subject. Presence means the subject is
  // registered on the console; entries retire with the session (adopt/sweep),
  // so the map tracks at most the live anonymous sessions of this process.
  const wireTouched = new Map<string, number>();
  // A console that answers a BARE 404 (no error envelope) on a session door is
  // not serving that surface at all. The doors then go quiet for the process —
  // one warn, no per-request failures, no per-interval sweep retries — because
  // anonymous traffic must keep serving and there is nothing to retry INTO.
  // The latch is per-process and re-arms on the next composition, so a console
  // that grows the doors back needs no client change (history:
  // docs/verification/existing-agents/polish/hosted-sessions-404.md).
  let doorsMissing = false;
  const disableDoors = (): void => {
    if (doorsMissing) return;
    doorsMissing = true;
    console.warn(
      "[vendo] Vendo Cloud console did not serve the hosted session doors (/api/v1/store/sessions/* answered a bare 404): "
      + "anonymous-session registration, the anonymous→signed-in merge, and the hosted TTL sweep are disabled for this process. "
      + "Hosted anonymous sessions will not be swept until the console serves those doors again.",
    );
  };
  return {
    async register(subject, now) {
      if (doorsMissing) return;
      // In-process debounce: skip the wire touch when this subject's LAST
      // successful touch is younger than sweepIntervalMs/2. TTLs are hours
      // while the debounce window is seconds, and the claim leg re-checks
      // idleness server-side, so a touched_at that is up to one debounce
      // window stale can never get a live session swept — steady-state
      // anonymous traffic costs zero extra round-trips.
      const last = wireTouched.get(subject);
      if (last !== undefined && now - last < touchDebounceMs) return;
      try {
        await store.sessions.register(subject, now);
        wireTouched.set(subject, now);
      } catch (error) {
        // The registry itself is gone: failing closed would 500 every
        // anonymous request while protecting a sweep that cannot run.
        if (error instanceof HostedSessionDoorsMissingError) {
          disableDoors();
          return;
        }
        // INVARIANT: registered ⇒ sweepable. The FIRST registration must fail
        // closed — if it doesn't land, rows written under this subject would
        // be unreachable by the TTL sweep forever. A subsequent touch only
        // refreshes idleness, so a console blip there fails OPEN with a warn:
        // the next request retries (the failed touch is not recorded), and an
        // hours-long TTL absorbs the staleness.
        if (last === undefined) throw error;
        console.warn(`[vendo] hosted session touch failed; will retry next request: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async adopt(from, to) {
      // No doors, no merge report: the caller still retires the anon cookie
      // (the linkage is unrecoverable either way) and skips the merge audit.
      if (doorsMissing) return null;
      try {
        const report = await store.sessions.adopt(from, to);
        wireTouched.delete(from);
        return report;
      } catch (error) {
        if (!(error instanceof HostedSessionDoorsMissingError)) throw error;
        disableDoors();
        wireTouched.delete(from);
        return null;
      }
    },
    // The HOST-driven sweep (hosted-store one-pager): list stale candidates,
    // claim each (the wire claim repeats the idleness predicate — a re-touch
    // defeats it, same serialization as sweepEphemeralSubjects), and finish
    // every claimed subject through the erase cascade. A claim COMMITS by
    // deleting the registry row, so a failed erase would leave the subject's
    // rows unreachable by every later stale scan — compensated below.
    async sweep(idleMs, now) {
      if (doorsMissing) return [];
      const evicted: string[] = [];
      try {
        for (const subject of await store.sessions.stale(idleMs, now)) {
          if (!(await store.sessions.claim(subject, idleMs, now))) continue;
          try {
            await store.erase.bySubject(subject);
          } catch (error) {
            // Put the claimed row back, stamped one tick past the idleness
            // cutoff so the very next sweep re-claims it instead of waiting
            // out another TTL. Best-effort: if the console is down for this
            // too, the erase failure is the one worth reporting.
            //
            // RELIES ON a console guarantee: register/touch never moves a
            // subject's touched_at BACKWARD (vendo-web
            // apps/console/lib/core/session-registry.ts, `touch` bumps under
            // `last_seen < seenAt`). Without that clamp this backdated write
            // would overwrite the fresh stamp of a visitor who returned
            // between the claim and here, and the next sweep would erase a
            // LIVE session. The client cannot enforce it — only the registry
            // can compare-and-set atomically. Pinned by "a fresh touch from a
            // returning visitor survives the compensation" below.
            await store.sessions.register(subject, now - idleMs - 1).catch(() => undefined);
            throw error;
          }
          wireTouched.delete(subject);
          evicted.push(subject);
        }
      } catch (error) {
        if (!(error instanceof HostedSessionDoorsMissingError)) throw error;
        disableDoors();
      }
      return evicted;
    },
  };
}

/** Per-process latch for the hosted-store automations notice below — a dev
    server recomposes on nearly every request, and the paragraph is a boot
    fact, not a per-request one (self-serve audit F7). */
let hostedStoreNoticePrinted = false;

/** A host may also pass hostedStore({...}) explicitly via createVendo({ store });
    the session doors it carries are then used as-is instead of the local SQL
    engine's (any other custom store keeps the local ops — and with them
    today's loud dbFor failure rather than a silent no-op). */
export function isHostedStore(store: VendoStore): store is HostedStore {
  const candidate = store as Partial<HostedStore>;
  return typeof candidate.sessions?.register === "function"
    && typeof candidate.erase?.bySubject === "function";
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
  touchDebounceMs: number,
  configuredFiles: FilesAdapter | undefined,
): {
  store: VendoStore;
  sessions: SessionOps;
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
  const files = selectFiles(configuredFiles, selected);
  return {
    store: selected,
    files,
    sessions: isHostedStore(selected)
      ? hostedSessionOps(selected, touchDebounceMs)
      : localSessionOps(selected, files),
  };
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
