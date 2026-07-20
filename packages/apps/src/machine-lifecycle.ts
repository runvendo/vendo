import {
  VendoError,
  safeErrorMessage,
  type AppDocument,
  type AppId,
  type StoreAdapter,
} from "@vendoai/core";
import { rowFromRecord, updateAppRow } from "./persistence.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

/** Execution-v2 wake/sleep policy: auto-sleep after 5 minutes idle. */
const DEFAULT_IDLE_MS = 5 * 60_000;

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
  sandbox?: SandboxAdapter;
  buildEnv?: BuildMachineEnv;
  allowedDomains?: BuildMachineAllowlist;
  /**
   * Wave 7 — push a freshly assembled boundary env into a LIVE machine (the
   * runtime wires the box control port's env door, which restarts the app).
   * A wake of a machine whose document carries `machine.envStaleAt` (a secret
   * grant changed while it slept — resumes restore the SNAPSHOT's env on
   * every provider) rebuilds the env through this seam and clears the marker.
   * Fail-closed: an injection failure destroys the resumed machine and fails
   * the wake (a box we cannot re-police must not serve — a revoked secret
   * would stay usable inside it); the marker and ref survive for the retry.
   */
  injectEnv?: (machine: SandboxMachine, env: Record<string, string>) => Promise<void>;
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
  /**
   * execution-v2 Wave 3 — drop the live machine WITHOUT snapshotting it,
   * leaving the document's `machine.snapshotRef` untouched: the app rolls back
   * to its pre-edit snapshot (the next wake re-provisions from the prior ref).
   * This is the failed-edit rollback — no new fork machinery, just "don't keep
   * what the box just did". No-op when the app is not awake.
   */
  discard(app: AppDocument): Promise<void>;
  /** Destroy the sandbox and clear the document's machine field. */
  destroyMachine(app: AppDocument): Promise<AppDocument>;
  /**
   * execution-v2 Wave 3 — reap ALL provider resources for an app (live machine
   * + stored snapshot) WITHOUT rewriting the document. The delete path uses
   * this: the row is about to be removed, so re-validating a machine-cleared
   * document (which a graduated tree's `fn:` refs would fail) must never block
   * the provider cleanup. Best-effort and idempotent.
   */
  destroyResources(app: AppDocument): Promise<void>;
  /**
   * execution-v2 Wave 3 — the CURRENT boundary env for an app (PORT, granted
   * secrets, skin URLs, inference), assembled by the injected buildEnv seam.
   * The Wave-3 edit flow pushes this to the box's control port before an edit
   * so a grant flipped while the machine slept lands via the in-box restart
   * loop (Lane E's env-baked-at-provision gap).
   */
  buildAppEnv(app: AppDocument): Promise<Record<string, string>>;
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

  const requireAdapter = (): SandboxAdapter => {
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
  const updateDocument = (
    appId: AppId,
    mutate: (doc: AppDocument) => AppDocument,
  ): Promise<AppDocument> => updateAppRow(records, appId, mutate);

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

  /** The seam's dead-machine signal (sandbox.ts): a request() throwing
   *  not-found means the PROVIDER lost the machine (TTL, sweep) — an app-level
   *  status never throws through the seam. */
  const isMachineGone = (error: unknown): boolean =>
    error instanceof VendoError && error.code === "not-found";

  /** One tracked request against a specific live raw machine (no recovery). */
  const requestOnce = async (
    appId: AppId,
    raw: SandboxMachine,
    req: Parameters<SandboxMachine["request"]>[0],
  ): Promise<Awaited<ReturnType<SandboxMachine["request"]>>> => {
    const entry = live.get(appId);
    const tracked = entry !== undefined && entry.raw === raw;
    if (tracked) entry.inflight += 1;
    armIdleTimer(appId);
    try {
      return await raw.request(req);
    } finally {
      if (tracked) entry.inflight -= 1;
      armIdleTimer(appId);
    }
  };

  /** Wave 7 — drop a live entry whose provider state died out from under us.
   *  Guarded on the exact raw machine so a racing recovery (or a fresh wake)
   *  is never evicted by a stale handle's late failure. */
  const evictDead = async (appId: AppId, raw: SandboxMachine): Promise<void> => {
    const entry = live.get(appId);
    if (entry === undefined || entry.raw !== raw) return;
    live.delete(appId);
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    // Best-effort: the provider already reaped it; never snapshot a dead box.
    await entry.raw.destroy().catch(() => undefined);
  };

  /** Every request through the machine counts as activity and re-arms the idle
   *  timer. A dead-machine failure (provider TTL/sweep) evicts the live entry
   *  and retries ONCE from the durable snapshot ref; a second failure
   *  surfaces. */
  const withIdleTracking = (appId: AppId, raw: SandboxMachine): SandboxMachine => ({
    id: raw.id,
    request: async (req) => {
      try {
        return await requestOnce(appId, raw, req);
      } catch (error) {
        if (!isMachineGone(error)) throw error;
        await evictDead(appId, raw);
        // Re-wake from the stored snapshot ref (concurrent recoveries coalesce
        // on the waking single-flight); the retry targets the fresh raw
        // machine directly so a second dead-machine failure surfaces instead
        // of recursing into another recovery.
        await wakeById(appId);
        const fresh = live.get(appId);
        if (fresh === undefined) throw error;
        return await requestOnce(appId, fresh.raw, req);
      }
    },
    url: (port) => raw.url(port),
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

  const wake = async (app: AppDocument): Promise<SandboxMachine> => wakeById(app.id);

  /**
   * Wave 7 — rebuild a machine's boundary env when its document carries the
   * env-stale marker (a secret grant changed after the last injection), then
   * clear the marker. Clearing is guarded on the marker VALUE seen — a grant
   * committed during the rebuild keeps its own fresher marker for the next
   * wake (markers are strictly increasing, so values never collide). A failed
   * clear is benign: the env is fresh and the re-push is idempotent. Throws
   * on injection failure; the CALLER owns tearing the machine down (fail
   * closed — a box we cannot re-police must not serve).
   */
  const rebuildStaleEnv = async (
    appId: AppId,
    doc: AppDocument,
    machine: SandboxMachine,
  ): Promise<void> => {
    const staleAt = doc.machine?.envStaleAt;
    if (staleAt === undefined || config.injectEnv === undefined) return;
    try {
      await config.injectEnv(machine, await buildEnv(doc));
    } catch (error) {
      throw new VendoError(
        "sandbox-unavailable",
        `machine env rebuild failed for ${appId} after a grant change`,
        { appId, reason: safeErrorMessage(error) },
      );
    }
    await updateDocument(appId, (current) => {
      if (current.machine === undefined || current.machine.envStaleAt !== staleAt) return current;
      const { envStaleAt: _stale, ...rest } = current.machine;
      return { ...current, machine: rest };
    }).catch(() => undefined);
  };

  const wakeById = async (appId: AppId): Promise<SandboxMachine> => {
    const entry = live.get(appId);
    if (entry !== undefined) {
      // Lane E — a live machine answers to the CURRENT policy too: a
      // declaration that lost (or never had) approval refuses here rather
      // than riding the warm entry. (A running provider machine's network
      // policy cannot be re-tightened in place — the refusal plus the idle
      // sleep is the containment; the next wake re-applies the policy.)
      // Evaluated over the authoritative row, not the caller's copy — a
      // grant committed since the caller loaded its document must count.
      if (config.allowedDomains !== undefined || config.injectEnv !== undefined) {
        const doc = await currentDocument(appId);
        if (config.allowedDomains !== undefined) await config.allowedDomains(doc);
        // Wave 7 — a durable env-stale marker written by ANOTHER process
        // (whose grant commit cannot reach this process's live entry to
        // sleep it) must not ride the warm entry until the idle sweep.
        try {
          await rebuildStaleEnv(appId, doc, entry.raw);
        } catch (error) {
          const taken = await takeLive(appId);
          await taken?.raw.destroy().catch(() => undefined);
          throw error;
        }
      }
      armIdleTimer(appId);
      return entry.wrapped;
    }
    const pending = waking.get(appId);
    if (pending !== undefined) return pending;
    const run = (async () => {
      const doc = await currentDocument(appId);
      if (doc.machine === undefined) {
        throw new VendoError("validation", `app ${appId} has no machine to wake`, { appId });
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
      // Wave 7 — a grant changed while the machine slept: the resumed snapshot
      // carries the OLD env (every provider restores snapshot env), so rebuild
      // the boundary env through the control port before anything rides this
      // wake. A failed rebuild fails the wake CLOSED — registering the machine
      // live would let a revoked secret keep serving until the idle sweep. The
      // marker and the document ref survive, so the next wake retries.
      try {
        await rebuildStaleEnv(appId, doc, raw);
      } catch (error) {
        await raw.destroy().catch(() => undefined);
        throw error;
      }
      const wrapped = withIdleTracking(appId, raw);
      live.set(appId, { raw, wrapped, inflight: 0 });
      armIdleTimer(appId);
      return wrapped;
    })();
    waking.set(appId, run);
    try {
      return await run;
    } finally {
      waking.delete(appId);
    }
  };

  const sleep = async (app: AppDocument): Promise<AppDocument> => {
    const slept = await sleepById(app.id);
    return slept ?? await currentDocument(app.id);
  };

  const discard = async (app: AppDocument): Promise<void> => {
    // Rollback: take the live machine off the books and destroy it WITHOUT a
    // snapshot, so the document keeps pointing at its pre-edit ref. A mere
    // stop would leave a paused provider resource beside the untouched ref.
    const entry = await takeLive(app.id);
    if (entry !== undefined) await entry.raw.destroy().catch(() => undefined);
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

  const buildAppEnv = async (app: AppDocument): Promise<Record<string, string>> =>
    buildEnv(await currentDocument(app.id));

  const destroyResources = async (app: AppDocument): Promise<void> => {
    const entry = await takeLive(app.id);
    if (entry !== undefined) await entry.raw.destroy().catch(() => undefined);
    // Read the stored ref (the caller's copy may predate a sleep's re-snapshot)
    // and reap it directly — no document write, so a machine-cleared tree that
    // still names fn: refs cannot fail validation and strand the snapshot.
    const doc = await currentDocument(app.id).catch(() => app);
    const ref = doc.machine?.snapshotRef;
    if (ref !== undefined) await config.sandbox?.destroy(ref).catch(() => undefined);
  };

  return {
    available: () => config.sandbox !== undefined,
    peek: (appId) => live.get(appId)?.wrapped,
    provision,
    wake,
    sleep,
    discard,
    destroyMachine,
    destroyResources,
    buildAppEnv,
  };
};
