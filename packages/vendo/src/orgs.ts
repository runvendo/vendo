import {
  isOrgSubject,
  isReservedSubject,
  orgIdFromSubject,
  orgPrincipal,
  VendoError,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import {
  appStore,
  orgStore,
  transferAppSubject,
  type OrgMemberRow,
  type OrgRole,
  type OrgRow,
  type VendoStore,
} from "@vendoai/store";
import { parseContractV2, type ContractV2 } from "./cli/cloud/entitlements.js";

/** Block-actions design §C — full org semantics, key-gated activation. All the
 * machinery ships OSS (tables, roles, wire, chrome); ACTIVATION rides the
 * console's existing `/api/v1/keys/validate` contract: no VENDO_API_KEY, or a
 * key whose plan lacks the `orgs` capability, and every org API returns the
 * posture error (`cloud-required`) — the same code the connections cloud seam
 * uses for 402s. Role model: members run, admins approve and manage, owners
 * additionally control the owner set. */
export interface OrgsService {
  posture: "cloud" | false;
  create(principal: Principal, name: string): Promise<OrgRow>;
  list(principal: Principal): Promise<Array<OrgRow & { role: OrgRole }>>;
  get(principal: Principal, orgId: string): Promise<{ org: OrgRow; role: OrgRole; members: OrgMemberRow[] }>;
  addMember(principal: Principal, orgId: string, subject: string, role: OrgRole): Promise<OrgMemberRow>;
  setRole(principal: Principal, orgId: string, subject: string, role: OrgRole): Promise<OrgMemberRow>;
  removeMember(principal: Principal, orgId: string, subject: string): Promise<void>;
  /** Transfer a durable app (automations are apps) to the org subject. */
  transferApp(principal: Principal, orgId: string, appId: string): Promise<void>;
  /** The caller's memberships — [] (not an error) when orgs are unactivated,
   * so passive surfaces (app listing) degrade instead of failing. */
  memberships(principal: Principal): Promise<Array<OrgRow & { role: OrgRole }>>;
  /** Re-contextualize a request onto an org-owned app: the ctx principal
   * becomes the org, `actor` stays the human (audit enrichment). Returns the
   * ctx unchanged when the app is not org-owned or the caller is no member. */
  appContext(ctx: RunContext, appId: string, need: "run" | "manage"): Promise<RunContext>;
  /** Admin-gated org context for approvals/grants surfaces: throws `blocked`
   * for plain members — org members run; admins approve and manage. */
  adminContext(ctx: RunContext, orgId: string): Promise<RunContext>;
}

const VALIDATE_PATH = "/api/v1/keys/validate";
/** Fallback cadences when the contract carries none (mirrors entitlements DEFAULT_CACHE). */
const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_STALE_SECONDS = 86_400;

interface OrgsOptions {
  store: VendoStore;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
}

function postureError(message: string): VendoError {
  return new VendoError("cloud-required", message);
}

function guardActingPrincipal(principal: Principal): void {
  if (principal.ephemeral === true) {
    throw new VendoError("blocked", "orgs require a signed-in user; sign in first");
  }
  if (isReservedSubject(principal.subject) || principal.subject.startsWith("webhook:")) {
    throw new VendoError("validation", "reserved synthetic subjects cannot use orgs");
  }
}

export function createOrgs(options: OrgsOptions): OrgsService {
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const apiKey = env.VENDO_API_KEY;
  const baseUrl = (env.VENDO_CLOUD_URL ?? "https://console.vendo.run").replace(/\/$/, "");
  const active = typeof apiKey === "string" && apiKey.length > 0;

  // Lazy store helpers: a host may compose createVendo around a bare
  // StoreAdapter double (conformance/memory stores) that has no SQL handle —
  // org machinery then reports not-implemented instead of crashing composition.
  type Helpers = { orgs: ReturnType<typeof orgStore>; apps: ReturnType<typeof appStore> };
  let lazyHelpers: Helpers | null | undefined;
  function helpers(): Helpers {
    if (lazyHelpers === undefined) {
      try {
        lazyHelpers = { orgs: orgStore(options.store), apps: appStore(options.store) };
      } catch {
        lazyHelpers = null;
      }
    }
    if (lazyHelpers === null) {
      throw new VendoError("not-implemented", "orgs require the composed Vendo store (createStore); the configured store adapter has no SQL surface");
    }
    return lazyHelpers;
  }

  // In-memory entitlement cache, refreshed per the contract's own cache policy;
  // a validation outage serves the stale contract inside its stale window and
  // fails CLOSED (posture error) beyond it.
  let cached: { contract: ContractV2; fetchedAt: number } | undefined;

  async function fetchContract(): Promise<ContractV2> {
    const response = await fetchImpl(`${baseUrl}${VALIDATE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw postureError(
        response.status === 401
          ? "VENDO_API_KEY was rejected by the Vendo console (401)"
          : `key validation failed with ${response.status}`,
      );
    }
    const contract = parseContractV2(await response.json().catch(() => null));
    if (contract === null) throw postureError("key validation returned an unrecognized contract");
    return contract;
  }

  async function requireEntitlement(): Promise<void> {
    if (!active) {
      throw postureError(
        "orgs are a Vendo Cloud capability: set VENDO_API_KEY (get one at vendo.run) to activate org workspaces",
      );
    }
    const age = cached === undefined ? Infinity : (now() - cached.fetchedAt) / 1_000;
    const ttl = cached?.contract.cache.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    let contract: ContractV2;
    if (cached !== undefined && age <= ttl) {
      contract = cached.contract;
    } else {
      try {
        contract = await fetchContract();
        cached = { contract, fetchedAt: now() };
      } catch (error) {
        const staleFor = cached?.contract.cache.stale_if_error_seconds ?? DEFAULT_STALE_SECONDS;
        if (cached !== undefined && age <= staleFor) {
          contract = cached.contract; // stale-if-error window
        } else {
          throw error instanceof VendoError ? error : postureError("key validation is unreachable");
        }
      }
    }
    if (contract.capabilities.orgs !== true) {
      throw postureError("this key's plan does not include orgs (capability 'orgs'); upgrade at vendo.run");
    }
  }

  async function requireRole(orgId: string, principal: Principal, atLeast: OrgRole): Promise<OrgRole> {
    const role = await helpers().orgs.roleOf(orgId, principal.subject);
    if (role === null) throw new VendoError("not-found", `org not found: ${orgId}`);
    const rank: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };
    if (rank[role] < rank[atLeast]) {
      throw new VendoError(
        "blocked",
        atLeast === "owner"
          ? "only an org owner can change the owner set"
          : "org members can run; approving and managing needs an org admin",
      );
    }
    return role;
  }

  return {
    posture: active ? "cloud" : false,

    async create(principal, name) {
      await requireEntitlement();
      guardActingPrincipal(principal);
      return helpers().orgs.create(name, principal.subject);
    },

    async list(principal) {
      await requireEntitlement();
      return helpers().orgs.listByMember(principal.subject);
    },

    async get(principal, orgId) {
      await requireEntitlement();
      const role = await requireRole(orgId, principal, "member");
      const org = await helpers().orgs.get(orgId);
      if (org === null) throw new VendoError("not-found", `org not found: ${orgId}`);
      return { org, role, members: await helpers().orgs.members(orgId) };
    },

    async addMember(principal, orgId, subject, role) {
      await requireEntitlement();
      await requireRole(orgId, principal, role === "owner" ? "owner" : "admin");
      return helpers().orgs.addMember(orgId, subject, role);
    },

    async setRole(principal, orgId, subject, role) {
      await requireEntitlement();
      const current = await helpers().orgs.roleOf(orgId, subject);
      // Touching the owner set (either direction) is owner-only; other role
      // changes are admin territory.
      const ownerInvolved = role === "owner" || current === "owner";
      await requireRole(orgId, principal, ownerInvolved ? "owner" : "admin");
      return helpers().orgs.setRole(orgId, subject, role);
    },

    async removeMember(principal, orgId, subject) {
      await requireEntitlement();
      if (subject !== principal.subject) {
        const current = await helpers().orgs.roleOf(orgId, subject);
        await requireRole(orgId, principal, current === "owner" ? "owner" : "admin");
      } else {
        await requireRole(orgId, principal, "member"); // self-leave (store guards the last owner)
      }
      await helpers().orgs.removeMember(orgId, subject);
    },

    async transferApp(principal, orgId, appId) {
      await requireEntitlement();
      guardActingPrincipal(principal);
      await requireRole(orgId, principal, "admin");
      const org = await helpers().orgs.get(orgId);
      if (org === null) throw new VendoError("not-found", `org not found: ${orgId}`);
      await transferAppSubject(options.store, appId, principal.subject, `vendo:org:${orgId}`);
    },

    async memberships(principal) {
      if (principal.ephemeral === true || isReservedSubject(principal.subject)) return [];
      try {
        await requireEntitlement();
        return await helpers().orgs.listByMember(principal.subject);
      } catch {
        return []; // unactivated orgs (or a store without SQL) degrade passively on read surfaces
      }
    },

    async appContext(ctx, appId, need) {
      let app: Awaited<ReturnType<Helpers["apps"]["get"]>>;
      try {
        app = await helpers().apps.get(appId);
      } catch {
        return ctx; // no SQL surface → no org-owned rows can exist
      }
      if (app === null || !isOrgSubject(app.subject)) return ctx;
      const orgId = orgIdFromSubject(app.subject);
      if (orgId === null) return ctx;
      await requireEntitlement();
      const role = await helpers().orgs.roleOf(orgId, ctx.principal.subject);
      if (role === null) return ctx; // not a member → the route 404s exactly as before
      if (need === "manage" && role === "member") {
        throw new VendoError("blocked", "org members can run this app; changing it needs an org admin");
      }
      const org = await helpers().orgs.get(orgId);
      return { ...ctx, principal: orgPrincipal(orgId, org?.name), actor: ctx.principal };
    },

    async adminContext(ctx, orgId) {
      await requireEntitlement();
      await requireRole(orgId, ctx.principal, "admin");
      const org = await helpers().orgs.get(orgId);
      return { ...ctx, principal: orgPrincipal(orgId, org?.name), actor: ctx.principal };
    },
  };
}
