import {
  VendoError,
  type AppDocument,
  type AppId,
  type StoreAdapter,
} from "@vendoai/core";
import { appRecordInput, rowFromRecord } from "./persistence.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

/** Execution-v2 wake/sleep policy: auto-sleep after 5 minutes idle. */
const DEFAULT_IDLE_MS = 5 * 60_000;
/** Bounded CAS retries before a document update reports a conflict. */
const CAS_ATTEMPTS = 3;

/**
 * Collapsed onto the seam: destroy-by-ref now lives on SandboxAdapter itself
 * (Lane A amendment). Kept as an alias so Lane B-era call sites read the same.
 * @deprecated Use SandboxAdapter directly.
 */
export type MachineSandboxAdapter = SandboxAdapter;

/** Injectable timer seam so idle auto-sleep is testable without real time. */
export interface LifecycleClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Lane C's env-assembly seam (PORT, secrets, store URL, callback URL,
 * inference endpoint). Injected here so the lanes do not collide; the default
 * assembles nothing.
 *
 * Lane E adds `grants`: the runtime resolves the app's active secret grants
 * and hands them to the host's assembler, so ONLY declared ∩ granted secrets
 * inject real values (the assembler never reads grant state itself). The
 * lifecycle calls the seam with the document only; the runtime composes the
 * grant-carrying closure.
 */
export type BuildMachineEnv = (
  app: AppDocument,
  grants?: MachineEnvGrants,
) => Promise<Record<string, string>> | Record<string, string>;

/** Lane E — grant state resolved by the runtime for the env assembler. */
export interface MachineEnvGrants {
  /** Names of declared secrets the owner granted to THIS app. */
  grantedSecrets: ReadonlySet<string>;
}

/**
 * Lane E's egress-policy seam: resolves the CURRENT allowlist a machine must
 * boot or wake with (approved declaration + implicit skin domains — see
 * boxAllowlist in egress-approval.ts, where the list is assembled). Consulted
 * on every provision AND every wake, so a grant decided while the machine
 * slept applies at the next resume; it throws to refuse the operation (an
 * unapproved declared domain must never reach the provider). `undefined`
 * result means unrestricted egress (no policy for this app). No callback →
 * pre-Lane-E behavior: create unrestricted, resume with the snapshot ref's
 * stored policy.
 */
export type BuildMachineAllowlist = (
  app: AppDocument,
) => Promise<string[] | undefined> | string[] | undefined;

export interface MachineLifecycleConfig {
  store: StoreAdapter;
  sandbox?: MachineSandboxAdapter;
  buildEnv?: BuildMachineEnv;
  allowedDomains?: BuildMachineAllowlist;
  /** Provider base template every provisioned machine boots from. */
  template?: string;
  idleMs?: number;
  clock?: LifecycleClock;
}

/**
 * Execution-v2 machine lifecycle: provision on graduation, wake on demand,
 * sleep on idle, destroy with the app. Wake single-flight and the idle timer
 * are in-process state — multi-instance hosts can wake one app twice (known
 * v2 limit; last sleep's CAS wins).
 */
export interface MachineLifecycle {
  available(): boolean;
  /** The live machine for an app, when one is awake in this process. */
  peek(appId: AppId): SandboxMachine | undefined;
  /** Create the machine from the base template, snapshot it, store the ref. Idempotent. */
  provision(app: AppDocument): Promise<AppDocument>;
  /** Resume the stored snapshot; concurrent wakes of one app share one machine. */
  wake(app: AppDocument): Promise<SandboxMachine>;
  /** Snapshot the live machine, store the new ref, stop it. No-op when not awake. */
  sleep(app: AppDocument): Promise<AppDocument>;
  /** Destroy the sandbox and clear the document's machine field. */
  destroyMachine(app: AppDocument): Promise<AppDocument>;
}

interface LiveEntry {
  raw: SandboxMachine;
  wrapped: SandboxMachine;
  timer?: unknown;
  /** Requests currently inside the box; auto-sleep defers while any are in flight. */
  inflight: number;
}

export const createMachineLifecycle = (config: MachineLifecycleConfig): MachineLifecycle => {
  const records = config.store.records("vendo_apps");
  const buildEnv: BuildMachineEnv = config.buildEnv ?? (() => ({}));
  const idleMs = config.idleMs ?? DEFAULT_IDLE_MS;
  const clock: LifecycleClock = config.clock ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
  };

  const live = new Map<AppId, LiveEntry>();
  const waking = new Map<AppId, Promise<SandboxMachine>>();
  const provisioning = new Map<AppId, Promise<AppDocument>>();

  const requireAdapter = (): MachineSandboxAdapter => {
    if (config.sandbox === undefined) {
      throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    }
    return config.sandbox;
  };

  /** Authoritative document read — the caller's copy may predate a sleep's re-snapshot. */
  const currentDocument = async (appId: AppId): Promise<AppDocument> => {
    const record = await records.get(appId);
    if (record === null) {
      throw new VendoError("not-found", `app ${appId} does not exist`, { appId });
    }
    return rowFromRecord(record).doc;
  };

  /** Read-mutate-CAS on the app row; the store's revision receipt arbitrates racers. */
  const updateDocument = async (
    appId: AppId,
    mutate: (doc: AppDocument) => AppDocument,
  ): Promise<AppDocument> => {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const record = await records.get(appId);
      if (record === null) {
        throw new VendoError("not-found", `app ${appId} does not exist`, { appId });
      }
      const row = rowFromRecord(record);
      const next = mutate(structuredClone(row.doc));
      const input = appRecordInput(next, row.subject, row.enabled);
      if (records.atomic === undefined || record.revision === undefined) {
        await records.put(input);
        return next;
      }
      const swapped = await records.atomic.compareAndSwap(input, record.revision);
      if (swapped !== null) return next;
    }
    throw new VendoError("conflict", `app ${appId} was concurrently modified`, { appId });
  };

  const armIdleTimer = (appId: AppId): void => {
    const entry = live.get(appId);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    entry.timer = clock.setTimeout(() => {
      // A request still inside the box means the machine is not idle: a request
      // outliving idleMs must never be snapshotted mid-flight. Its completion
      // re-arms; this re-arm only covers a request outliving several idleMs.
      if ((live.get(appId)?.inflight ?? 0) > 0) {
        armIdleTimer(appId);
        return;
      }
      void sleepById(appId).catch(() => undefined);
    }, idleMs);
  };

  /** Every request through the machine counts as activity and re-arms the idle timer. */
  const withIdleTracking = (appId: AppId, raw: SandboxMachine): SandboxMachine => ({
    id: raw.id,
    request: async (req) => {
      const entry = live.get(appId);
      if (entry !== undefined) entry.inflight += 1;
      armIdleTimer(appId);
      try {
        return await raw.request(req);
      } finally {
        if (entry !== undefined) entry.inflight -= 1;
        armIdleTimer(appId);
      }
    },
    snapshot: () => raw.snapshot(),
    stop: () => raw.stop(),
    destroy: () => raw.destroy(),
  });

  /** Remove an app's live entry (if any), cancel its timer, and return it. */
  const takeLive = async (appId: AppId): Promise<LiveEntry | undefined> => {
    const pending = waking.get(appId);
    if (pending !== undefined) await pending.catch(() => undefined);
    const entry = live.get(appId);
    if (entry === undefined) return undefined;
    live.delete(appId);
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    return entry;
  };

  const sleepById = async (appId: AppId): Promise<AppDocument | null> => {
    const entry = await takeLive(appId);
    if (entry === undefined) return null;
    try {
      const snapshotRef = await entry.raw.snapshot();
      // provisionedAt keeps recording provisioning; only the ref moves forward.
      // A machine field cleared by a concurrent destroy stays cleared.
      let superseded: string | undefined;
      const updated = await updateDocument(appId, (doc) => {
        if (doc.machine === undefined) return doc;
        superseded = doc.machine.snapshotRef;
        return { ...doc, machine: { ...doc.machine, snapshotRef } };
      });
      // Snapshots are independent provider resources: release whichever ref
      // lost — the superseded one normally, or ours if a concurrent destroy
      // cleared the field while we were snapshotting.
      const orphan = updated.machine?.snapshotRef === snapshotRef ? superseded : snapshotRef;
      if (orphan !== undefined && orphan !== updated.machine?.snapshotRef) {
        await config.sandbox?.destroy(orphan).catch(() => undefined);
      }
      return updated;
    } finally {
      // snapshot() leaves the source machine RUNNING (e2b semantics): the
      // checkpoint is what survives, so the live source is destroyed — a mere
      // stop would leave a paused provider resource lingering beside the ref.
      await entry.raw.destroy().catch(() => undefined);
    }
  };

  const provision = async (app: AppDocument): Promise<AppDocument> => {
    const inflight = provisioning.get(app.id);
    if (inflight !== undefined) return inflight;
    const run = (async () => {
      const doc = await currentDocument(app.id);
      if (doc.machine !== undefined) return doc;
      const adapter = requireAdapter();
      // Lane E — the egress policy gates provisioning BEFORE any provider
      // call: an unapproved declared domain throws here and no machine exists.
      const allowlist = await config.allowedDomains?.(doc);
      const machine = await adapter.create({
        ...(config.template === undefined ? {} : { template: config.template }),
        env: await buildEnv(doc),
        ...(allowlist === undefined ? {} : { allowedDomains: allowlist }),
      });
      try {
        const snapshotRef = await machine.snapshot();
        const provisionedAt = new Date().toISOString();
        // A CAS retry can re-read a document another app server already
        // provisioned; the winner's machine stays, and our snapshot is released.
        const updated = await updateDocument(app.id, (current) => current.machine === undefined
          ? { ...current, machine: { snapshotRef, provisionedAt } }
          : current);
        if (updated.machine?.snapshotRef !== snapshotRef) {
          await adapter.destroy(snapshotRef).catch(() => undefined);
        }
        return updated;
      } finally {
        // Provision ends asleep: the snapshot IS the machine until a wake, and
        // snapshot() leaves the source running — destroy it, don't just stop.
        await machine.destroy().catch(() => undefined);
      }
    })();
    provisioning.set(app.id, run);
    try {
      return await run;
    } finally {
      provisioning.delete(app.id);
    }
  };

  const wake = async (app: AppDocument): Promise<SandboxMachine> => {
    const entry = live.get(app.id);
    if (entry !== undefined) {
      armIdleTimer(app.id);
      return entry.wrapped;
    }
    const pending = waking.get(app.id);
    if (pending !== undefined) return pending;
    const run = (async () => {
      const doc = await currentDocument(app.id);
      if (doc.machine === undefined) {
        throw new VendoError("validation", `app ${app.id} has no machine to wake`, { appId: app.id });
      }
      const adapter = requireAdapter();
      // Lane E — a wake applies the CURRENT egress policy over the snapshot's
      // stored one (grants may have changed while the machine slept); it also
      // refuses loudly when a declared domain lost or never had approval.
      const raw = config.allowedDomains === undefined
        ? await adapter.resume(doc.machine.snapshotRef)
        : await adapter.resume(doc.machine.snapshotRef, {
          allowedDomains: await config.allowedDomains(doc),
        });
      const wrapped = withIdleTracking(app.id, raw);
      live.set(app.id, { raw, wrapped, inflight: 0 });
      armIdleTimer(app.id);
      return wrapped;
    })();
    waking.set(app.id, run);
    try {
      return await run;
    } finally {
      waking.delete(app.id);
    }
  };

  const sleep = async (app: AppDocument): Promise<AppDocument> => {
    const slept = await sleepById(app.id);
    return slept ?? await currentDocument(app.id);
  };

  const destroyMachine = async (app: AppDocument): Promise<AppDocument> => {
    const doc = await currentDocument(app.id);
    if (doc.machine === undefined && !live.has(app.id) && !waking.has(app.id)) {
      return doc;
    }
    const adapter = requireAdapter();
    const entry = await takeLive(app.id);
    // A live machine is its own provider resource — destroy it, not just stop.
    if (entry !== undefined) await entry.raw.destroy().catch(() => undefined);
    // Clear the field FIRST, capturing the ref from the winning write: a sleep
    // racing this destroy may have just stored a newer ref, and destroying a
    // stale read's ref would orphan the newer snapshot.
    let clearedRef: string | undefined;
    const updated = await updateDocument(app.id, (current) => {
      clearedRef = current.machine?.snapshotRef;
      const { machine: _machine, ...rest } = current;
      return rest;
    });
    if (clearedRef !== undefined) await adapter.destroy(clearedRef);
    return updated;
  };

  return {
    available: () => config.sandbox !== undefined,
    peek: (appId) => live.get(appId)?.wrapped,
    provision,
    wake,
    sleep,
    destroyMachine,
  };
};
