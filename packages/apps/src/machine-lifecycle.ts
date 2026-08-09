import {
  VendoError,
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
 * unapproved declared domain must never reach the provider).
 *
 * It answers with a LIST, never with `undefined`. It used to be allowed to mean
 * "no policy for this app", and the seam read that as UNRESTRICTED internet
 * (`SandboxAdapter.create` treats an absent `allowedDomains` as
 * `allowInternetAccess: true`) — so the one value a policy function produces by
 * accident was the one that removed the filter. An app with nothing to reach
 * gets `[]`, the strictest policy this seam can express.
 *
 * How strong that actually is, measured: the provider filters by DOMAIN, which
 * holds against ordinary clients and not against one that omits SNI.
 */
export type BuildMachineAllowlist = (
  app: AppDocument,
) => Promise<string[]> | string[];

export interface MachineLifecycleConfig {
  store: StoreAdapter;
  sandbox?: SandboxAdapter;
  buildEnv?: BuildMachineEnv;
  /**
   * Required, and never optional: an omitted policy used to mean UNRESTRICTED
   * egress, so a caller who simply forgot handed a machine an unfiltered
   * internet and the call site read as complete. Unnamed must mean denied — the
   * same law `disallowedTools` applies at the session and `BoxMachineOptions.allowedDomains`
   * states for the conversational box. A deployment with nothing to allow says
   * so with a function returning `[]`.
   */
  allowedDomains: BuildMachineAllowlist;
  /** Provider base template every provisioned machine boots from. */
  template?: string;
  idleMs?: number;
  clock?: LifecycleClock;
}

/**
 * Execution-v2 machine lifecycle: provision on graduation, wake on demand,
 * sleep on idle, destroy with the app. Wake single-flight and the idle timer
 * are in-process state — multi-instance hosts can wake one app twice (known
 * limit; last sleep's CAS wins).
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
  /**
   * issue #566 — the secret values that were successfully INJECTED into this
   * box, keyed by secret name, as last assembled by the buildEnv seam
   * (provision, or the pre-edit re-injection). The redaction guard
   * reuses these so a value that entered the box is always redactable WITHOUT a
   * refetch that could fail. In-memory and per-app: it is populated only for
   * apps this process built env for, dropped when the machine is destroyed, and
   * never keyed across apps — so it cannot outlive or cross a box boundary.
   * Empty map when nothing was injected (or nothing is cached in this process).
   */
  injectedSecretValues(appId: AppId): ReadonlyMap<string, string>;
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

  /**
   * THE egress policy, for every provider call that takes one.
   *
   * The `?? []` is the floor under the required type, not a second mechanism:
   * TypeScript stops a caller omitting the policy, and this stops an untyped
   * one (or a policy function that answers with nothing) from reaching the
   * provider with no `allowedDomains` at all — which the seam reads as an
   * unfiltered internet. An empty list is the only safe thing an absent answer
   * can mean.
   */
  const allowlistFor = async (app: AppDocument): Promise<string[]> =>
    (await config.allowedDomains?.(app)) ?? [];
  const idleMs = config.idleMs ?? DEFAULT_IDLE_MS;
  const clock: LifecycleClock = config.clock ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
  };

  const live = new Map<AppId, LiveEntry>();
  const waking = new Map<AppId, Promise<SandboxMachine>>();
  const provisioning = new Map<AppId, Promise<AppDocument>>();
  // issue #566 — per-box cache of the secret values that entered the box, keyed
  // by app id and refreshed on every env assembly (provision / pre-edit
  // re-injection). Redaction reads it so a successfully injected value
  // never depends on a refetch that could fail. In-memory and per-app: dropped
  // on machine destroy and never shared across apps, so it cannot outlive or
  // cross a box boundary.
  const injectedValues = new Map<AppId, Map<string, string>>();

  /** Capture the secret values a freshly assembled env carries into the box.
   *  A declared secret injects as its own name=value env entry (box-env's
   *  contract; reserved boundary vars can never be a declared secret name), so
   *  the values are exactly the declared names present in the built env. */
  const rememberInjected = (doc: AppDocument, env: Record<string, string>): void => {
    const values = new Map<string, string>();
    for (const name of new Set(doc.secrets ?? [])) {
      const value = env[name];
      if (typeof value === "string" && value.length > 0) values.set(name, value);
    }
    injectedValues.set(doc.id, values);
  };

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
    files: {
      read: (path) => raw.files.read(path),
      write: (path, bytes) => raw.files.write(path, bytes),
      list: (dir) => raw.files.list(dir),
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
      const allowlist = await allowlistFor(doc);
      const env = await buildEnv(doc);
      rememberInjected(doc, env);
      const machine = await adapter.create({
        ...(config.template === undefined ? {} : { template: config.template }),
        env,
        // ALWAYS present. Dropping the key on an empty list would ask the
        // provider for unrestricted egress, which is the opposite of what an
        // empty allowlist means.
        allowedDomains: allowlist,
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
      await allowlistFor(await currentDocument(appId));
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
      // A wake NEVER falls back to the snapshot's stored policy: that policy is
      // whatever was current when the machine was last provisioned, and the
      // grant state may have loosened or tightened since.
      const raw = await adapter.resume(doc.machine.snapshotRef, {
        allowedDomains: await allowlistFor(doc),
      });
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
    // De-graduation: the box is gone, so its injected-value cache must go too.
    injectedValues.delete(app.id);
    return updated;
  };

  const buildAppEnv = async (app: AppDocument): Promise<Record<string, string>> => {
    const doc = await currentDocument(app.id);
    const env = await buildEnv(doc);
    // Pre-edit re-injection pushes this same env to the live box, so refresh the
    // cache with what is about to enter it.
    rememberInjected(doc, env);
    return env;
  };

  const destroyResources = async (app: AppDocument): Promise<void> => {
    const entry = await takeLive(app.id);
    if (entry !== undefined) await entry.raw.destroy().catch(() => undefined);
    // Read the stored ref (the caller's copy may predate a sleep's re-snapshot)
    // and reap it directly — no document write, so a machine-cleared tree that
    // still names fn: refs cannot fail validation and strand the snapshot.
    const doc = await currentDocument(app.id).catch(() => app);
    const ref = doc.machine?.snapshotRef;
    if (ref !== undefined) await config.sandbox?.destroy(ref).catch(() => undefined);
    // The app's provider resources are reaped (delete path) — drop its cache.
    injectedValues.delete(app.id);
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
    injectedSecretValues: (appId) => injectedValues.get(appId) ?? new Map(),
  };
};
