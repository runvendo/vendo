import {
  type AppId,
  type ApprovalId,
  type IsoDateTime,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";
import { listAllRecords } from "./persistence.js";

/**
 * ENG-345 — the guarded per-secret in-sandbox exposure grant (secrets
 * fast-follow to the Option B gateway pick).
 *
 * Option B stays the DEFAULT: a declared secret enters the sandbox as an opaque
 * handle and is substituted only at the egress proxy (06-apps §4.3). This grant
 * is the EXCEPTION path — an explicit, per-secret × per-app, owner-only opt-in
 * that places the REAL value into the sandbox env instead of a handle. It is:
 *   - off by default (no record → handle),
 *   - owner-only (only the principal who owns the app copy can set it),
 *   - gated by the guard's existing high-risk approval flow (written `active`
 *     only after the parked critical approval is decided approved),
 *   - audited per run (machine.ts emits one exposed-run event per run), and
 *   - NEVER carried by shares/remixes.
 *
 * The last invariant is enforced structurally, not by stripping: these grants
 * live in their OWN store collection keyed by the app's id, and are never part
 * of the app document that exportApp/share/publish/fork/importApp copy. A copy
 * always gets a fresh AppId (06-apps §7), which by construction has no grants —
 * so a copied app can never inherit an exposure grant.
 */
export interface SecretExposureGrant {
  appId: AppId;
  secretName: string;
  /** The app owner's principal subject — the only principal who may set this. */
  owner: string;
  /** `pending` = parked on a high-risk approval; `active` = approved and live. */
  status: "pending" | "active";
  /** The guard approval that gates turning this on (06-apps §9 approval model). */
  approvalId: ApprovalId;
  requestedAt: IsoDateTime;
  grantedAt?: IsoDateTime;
}

/** Deterministic id so re-requesting the same (app, secret) overwrites, never duplicates. */
const recordId = (appId: AppId, secretName: string): string => `xpo_${appId}__${secretName}`;

const COLLECTION = "vendo_secret_exposure";

const grantData = (record: VendoRecord): SecretExposureGrant => record.data as SecretExposureGrant;

const listAll = (store: StoreAdapter, refs: Record<string, string>): Promise<VendoRecord[]> =>
  listAllRecords(store.records(COLLECTION), { refs });

/** ENG-345 — persistence for per-secret × per-app in-sandbox exposure grants. */
export interface SecretExposure {
  /** Active grants for one app (owner-scoped by construction). */
  active(appId: AppId): Promise<SecretExposureGrant[]>;
  /** Names of secrets currently exposed in-sandbox for one app. */
  activeNames(appId: AppId): Promise<Set<string>>;
  /** Every grant (pending + active) for one app. */
  list(appId: AppId): Promise<SecretExposureGrant[]>;
  /** Park a grant on a high-risk approval (status `pending`). */
  putPending(grant: Omit<SecretExposureGrant, "status">): Promise<void>;
  /** Flip a parked grant to `active` once its approval is approved. Returns the grant, or null if none pending. */
  activate(appId: AppId, secretName: string): Promise<SecretExposureGrant | null>;
  /** Turn a secret off — reverts to the Option B handle default. */
  revoke(appId: AppId, secretName: string): Promise<void>;
  /** Grants (pending/active) parked on a specific approval id. */
  byApproval(approvalId: ApprovalId): Promise<SecretExposureGrant[]>;
  /** Delete every grant for one app (app deletion cleanup). */
  clearForApp(appId: AppId): Promise<void>;
}

export const createSecretExposure = (store: StoreAdapter): SecretExposure => {
  const collection = store.records(COLLECTION);

  const refsFor = (grant: SecretExposureGrant): Record<string, string> => ({
    subject: grant.owner,
    app_id: grant.appId,
    secret: grant.secretName,
    status: grant.status,
    approval: grant.approvalId,
  });

  const list = async (appId: AppId): Promise<SecretExposureGrant[]> =>
    (await listAll(store, { app_id: appId })).map(grantData);

  return {
    list,
    async active(appId) {
      return (await list(appId)).filter((grant) => grant.status === "active");
    },
    async activeNames(appId) {
      return new Set((await list(appId)).filter((grant) => grant.status === "active").map((grant) => grant.secretName));
    },
    async putPending(grant) {
      const full: SecretExposureGrant = { ...grant, status: "pending" };
      await collection.put({ id: recordId(grant.appId, grant.secretName), data: full, refs: refsFor(full) });
    },
    async activate(appId, secretName) {
      const record = await collection.get(recordId(appId, secretName));
      if (record === null) return null;
      const grant = grantData(record);
      if (grant.status === "active") return grant;
      const activated: SecretExposureGrant = { ...grant, status: "active", grantedAt: new Date().toISOString() };
      await collection.put({ id: record.id, data: activated, refs: refsFor(activated) });
      return activated;
    },
    async revoke(appId, secretName) {
      await collection.delete(recordId(appId, secretName));
    },
    async byApproval(approvalId) {
      return (await listAll(store, { approval: approvalId })).map(grantData);
    },
    async clearForApp(appId) {
      for (const record of await listAll(store, { app_id: appId })) {
        await collection.delete(record.id);
      }
    },
  };
};
