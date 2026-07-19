import {
  VendoError,
  type AppDocument,
  type AppId,
  type ApprovalId,
  type IsoDateTime,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";

/**
 * execution-v2 Wave 2 Lane E — grant-style egress approval
 * (spec "Secrets and egress", docs/superpowers/specs/2026-07-19-execution-v2-design.md).
 *
 * The app's `egress` declaration (mirroring `vendo.json`) is an ASK, not an
 * authority: each declared domain needs a one-time owner approval before a
 * machine may provision or wake with it. The flow reuses the guard's existing
 * critical-approval machinery (the ENG-345 exposure-grant pattern — no new
 * ceremony types): an unapproved declaration parks ONE approval naming the
 * missing domains, and the decision seam commits them onto the app document's
 * `egressApproved` field. This module owns the pure policy math and the store
 * of parked requests; the runtime owns the guard round-trip.
 *
 * Grant hygiene mirrors ENG-345 structurally where it can: parked requests
 * live in their own collection keyed by app id (a copy's fresh id has none),
 * and the doc-stored `egressApproved` field is stripped at every copy mint
 * (fork/share/publish; interchange strips by field whitelist).
 */

export interface EgressApprovalRequest {
  appId: AppId;
  /** One normalized declared domain awaiting the owner's decision. */
  domain: string;
  /** The app owner's principal subject — the only principal who may approve. */
  owner: string;
  /** The parked guard approval that decides this domain (06-apps §9 model). */
  approvalId: ApprovalId;
  requestedAt: IsoDateTime;
}

/** Domains compare case-insensitively; declarations may carry stray spacing. */
export const normalizeEgressDomain = (domain: string): string => domain.trim().toLowerCase();

const normalizeList = (domains: readonly string[] | undefined): string[] =>
  [...new Set((domains ?? []).map(normalizeEgressDomain))].filter((domain) => domain !== "");

/** Declared-but-not-yet-approved domains — what still needs an owner grant. */
export const unapprovedEgress = (app: AppDocument): string[] => {
  const approved = new Set(normalizeList(app.egressApproved));
  return normalizeList(app.egress).filter((domain) => !approved.has(domain));
};

/**
 * The allowlist a machine boots or wakes with — the ONE place the box's
 * effective egress policy is assembled. Two rules:
 *
 * 1. Declared domains must ALL be approved: any unapproved declaration is a
 *    loud VendoError naming the missing domains (a machine never provisions
 *    or wakes half-approved), on every path including ctx-less ones like a
 *    schedule wake.
 * 2. The implicit skin domains ride every allowlist unconditionally: the
 *    inference endpoint, the host-callback surface, and the store surface are
 *    the box's OWN boundary (env half of the skin contract) — a box that
 *    cannot reach its own skin is broken, so these are never subject to
 *    declaration or approval. The host assembles them from the same URLs it
 *    injects as VENDO_STORE_URL / VENDO_HOST_URL / VENDO_INFERENCE_URL.
 *
 * An app that declares nothing gets the implicit skin domains only: v2
 * machine egress is deny-by-default at the network layer (the SSRF and
 * exfil answer, including for the BYO-model-key case).
 */
export const boxAllowlist = (app: AppDocument, implicitDomains: readonly string[]): string[] => {
  const unapproved = unapprovedEgress(app);
  if (unapproved.length > 0) {
    throw new VendoError(
      "blocked",
      `machine egress is not approved for: ${unapproved.join(", ")}`,
      { unapprovedDomains: unapproved },
    );
  }
  return [...new Set([...normalizeList(app.egress), ...normalizeList(implicitDomains)])];
};

/** Deterministic id so re-requesting the same (app, domain) overwrites, never duplicates. */
const recordId = (appId: AppId, domain: string): string => `egr_${appId}__${domain}`;

const COLLECTION = "vendo_egress_approval";

const requestData = (record: VendoRecord): EgressApprovalRequest => record.data as EgressApprovalRequest;

const listAll = async (
  store: StoreAdapter,
  refs: Record<string, string>,
): Promise<VendoRecord[]> => {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.records(COLLECTION).list(
      cursor === undefined ? { refs } : { refs, cursor },
    );
    records.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
};

/**
 * Persistence for PARKED egress approvals only. Approved state lives on the
 * app document (`egressApproved`), so a parked record exists exactly while an
 * approval card is undecided; both decisions clear it (approval commits to
 * the doc first, denial just clears — fail closed).
 */
export interface EgressApprovals {
  /** Parked requests for one app. */
  pending(appId: AppId): Promise<EgressApprovalRequest[]>;
  /** Park one domain on a guard approval (re-parking the same domain overwrites). */
  putPending(request: EgressApprovalRequest): Promise<void>;
  /** Parked requests riding a specific guard approval id. */
  byApproval(approvalId: ApprovalId): Promise<EgressApprovalRequest[]>;
  /** Clear one parked domain (its approval was decided, either way). */
  remove(appId: AppId, domain: string): Promise<void>;
  /** Delete every parked request for one app (app deletion cleanup). */
  clearForApp(appId: AppId): Promise<void>;
}

export const createEgressApprovals = (store: StoreAdapter): EgressApprovals => {
  const collection = store.records(COLLECTION);

  const refsFor = (request: EgressApprovalRequest): Record<string, string> => ({
    subject: request.owner,
    app_id: request.appId,
    domain: request.domain,
    approval: request.approvalId,
  });

  return {
    async pending(appId) {
      return (await listAll(store, { app_id: appId })).map(requestData);
    },
    async putPending(request) {
      await collection.put({
        id: recordId(request.appId, request.domain),
        data: request,
        refs: refsFor(request),
      });
    },
    async byApproval(approvalId) {
      return (await listAll(store, { approval: approvalId })).map(requestData);
    },
    async remove(appId, domain) {
      await collection.delete(recordId(appId, domain));
    },
    async clearForApp(appId) {
      for (const record of await listAll(store, { app_id: appId })) {
        await collection.delete(record.id);
      }
    },
  };
};
