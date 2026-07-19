import {
  VendoError,
  type AppDocument,
  type AppId,
  type StoreAdapter,
} from "@vendoai/core";
import { appRecordInput, rowFromRecord } from "./persistence.js";
import type { SandboxAdapterV2, SandboxMachineV2 } from "./sandbox-v2.js";

/** Execution-v2 wake/sleep policy: auto-sleep after 5 minutes idle. */
const DEFAULT_IDLE_MS = 5 * 60_000;
/** Bounded CAS retries before a document update reports a conflict. */
const CAS_ATTEMPTS = 3;

/** Injectable timer seam so idle auto-sleep is testable without real time. */
export interface LifecycleClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Lane C's env-assembly seam (PORT, secrets, store URL, callback URL,
 * inference endpoint). Injected here so the lanes do not collide; the default
 * assembles nothing.
 */
export type BuildMachineEnv = (
  app: AppDocument,
) => Promise<Record<string, string>> | Record<string, string>;

export interface MachineLifecycleConfig {
  store: StoreAdapter;
  sandbox?: SandboxAdapterV2;
  buildEnv?: BuildMachineEnv;
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
  peek(appId: AppId): SandboxMachineV2 | undefined;
  /** Create the machine from the base template, snapshot it, store the ref. Idempotent. */
  provision(app: AppDocument): Promise<AppDocument>;
  /** Resume the stored snapshot; concurrent wakes of one app share one machine. */
  wake(app: AppDocument): Promise<SandboxMachineV2>;
  /** Snapshot the live machine, store the new ref, stop it. No-op when not awake. */
  sleep(app: AppDocument): Promise<AppDocument>;
  /** Destroy the sandbox and clear the document's machine field. */
  destroyMachine(app: AppDocument): Promise<AppDocument>;
}

interface LiveEntry {
  raw: SandboxMachineV2;
  wrapped: SandboxMachineV2;
  timer?: unknown;
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
  const waking = new Map<AppId, Promise<SandboxMachineV2>>();
  const provisioning = new Map<AppId, Promise<AppDocument>>();

  const requireAdapter = (): SandboxAdapterV2 => {
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
      void sleepById(appId).catch(() => undefined);
    }, idleMs);
  };

  /** Every request through the machine counts as activity and re-arms the idle timer. */
  const withIdleTracking = (appId: AppId, raw: SandboxMachineV2): SandboxMachineV2 => ({
    id: raw.id,
    request: async (req) => {
      armIdleTimer(appId);
      return raw.request(req);
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
      return await updateDocument(appId, (doc) => doc.machine === undefined
        ? doc
        : { ...doc, machine: { ...doc.machine, snapshotRef } });
    } finally {
      await entry.raw.stop().catch(() => undefined);
    }
  };

  const provision = async (app: AppDocument): Promise<AppDocument> => {
    const inflight = provisioning.get(app.id);
    if (inflight !== undefined) return inflight;
    const run = (async () => {
      const doc = await currentDocument(app.id);
      if (doc.machine !== undefined) return doc;
      const adapter = requireAdapter();
      const machine = await adapter.create({
        ...(config.template === undefined ? {} : { template: config.template }),
        env: await buildEnv(doc),
      });
      try {
        const snapshotRef = await machine.snapshot();
        const provisionedAt = new Date().toISOString();
        return await updateDocument(app.id, (current) => ({
          ...current,
          machine: { snapshotRef, provisionedAt },
        }));
      } finally {
        // Provision ends asleep: the snapshot is the machine until a wake.
        await machine.stop().catch(() => undefined);
      }
    })();
    provisioning.set(app.id, run);
    try {
      return await run;
    } finally {
      provisioning.delete(app.id);
    }
  };

  const wake = async (app: AppDocument): Promise<SandboxMachineV2> => {
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
      const raw = await adapter.resume(doc.machine.snapshotRef);
      const wrapped = withIdleTracking(app.id, raw);
      live.set(app.id, { raw, wrapped });
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
    if (entry !== undefined) await entry.raw.stop().catch(() => undefined);
    if (doc.machine !== undefined) await adapter.destroy(doc.machine.snapshotRef);
    return updateDocument(app.id, (current) => {
      const { machine: _machine, ...rest } = current;
      return rest;
    });
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
