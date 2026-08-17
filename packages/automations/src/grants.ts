/**
 * The standing automation grants a consent moment mints and a firing runs under:
 * the one live-grant read all three fire-time questions are asked from, and the
 * mint that scopes a connector dispatch to its SLUG.
 */
import {
  buildGrant,
  descriptorHash,
  grantRefs,
  permissionGrantSchema,
  USE_SERVICE_TOOL,
  type ApprovalRequest,
  type MintGrantInput,
  type PermissionGrant,
  type RunContext,
  type ToolDescriptor,
} from "@vendoai/core";
import type { EngineBase } from "./engine-context.js";
import { allRecords, id } from "./rows.js";
import { scopeCovers } from "./steps.js";
import { GRANTS } from "./types.js";

export type GrantsDeps = { base: EngineBase };

export interface GrantsAccess {
  /** The bound tool surface, by name, for a present-time ceremony. */
  descriptors(ctx: RunContext): Promise<Map<string, ToolDescriptor>>;
  /** Every LIVE standing grant this automation holds for the subject. */
  liveAutomationGrants(subject: string, automationId: string, tool?: string): Promise<PermissionGrant[]>;
  /** Whether this exact descriptor (and service action) is already granted. */
  liveGrant(
    subject: string,
    automationId: string,
    descriptor: ToolDescriptor,
    slug?: string,
  ): Promise<boolean>;
  /** The service-action slugs THIS firing holds a live grant for. */
  grantedServiceSlugs(subject: string, automationId: string): Promise<string[]>;
  /** Whether the automation holds ANY live automation-source standing grant. */
  anyLiveAutomationGrant(subject: string, automationId: string): Promise<boolean>;
  /** The standing grant a decided approval mints, scoped to its slug. */
  mintGrant(request: ApprovalRequest, automationId: string | undefined): Promise<string>;
}

type GrantReads = Pick<
  GrantsAccess,
  "descriptors" | "liveAutomationGrants" | "liveGrant" | "grantedServiceSlugs" | "anyLiveAutomationGrant"
>;

/** The reads: the bound surface, and the ONE live-grant query the three
 *  fire-time questions are asked from. */
const createGrantReads = ({ base: { config, engine, now } }: GrantsDeps): GrantReads => {
  // `ctx` rides through so the projection seam (design §12) is not silently
  // dropped here. Both callers — enable and dryRun — are PRESENT-time
  // ceremonies, so nothing is withheld: the owner must still see and grant
  // everything the automation declares, and dryRun must still explain it.
  const descriptors = async (ctx: RunContext): Promise<Map<string, ToolDescriptor>> =>
    new Map((await config.tools.descriptors(ctx)).map((descriptor) => [descriptor.name, descriptor]));

  /**
   * Every LIVE standing grant this automation holds for the subject — the one
   * place the three fire-time questions below are asked from, so they cannot
   * answer differently about the same row.
   *
   * A grant minted while arming ONE automation never authorizes another: the
   * person was shown that record's task and consented to that.
   */
  const liveAutomationGrants = async (
    subject: string,
    automationId: string,
    tool?: string,
  ): Promise<PermissionGrant[]> => {
    const records = await allRecords(engine, GRANTS, {
      refs: { subject, automation_id: automationId, ...(tool === undefined ? {} : { tool }) },
    });
    const at = now().getTime();
    const grants: PermissionGrant[] = [];
    for (const record of records) {
      const parsed = permissionGrantSchema.safeParse(record.data);
      if (!parsed.success) continue;
      const grant = parsed.data;
      if (grant.subject !== subject || grant.automationId !== automationId) continue;
      if (grant.source !== "automation" || grant.duration !== "standing") continue;
      if (grant.revokedAt !== undefined) continue;
      if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= at) continue;
      grants.push(grant);
    }
    return grants;
  };

  const liveGrant = async (
    subject: string,
    automationId: string,
    descriptor: ToolDescriptor,
    slug?: string,
  ): Promise<boolean> =>
    (await liveAutomationGrants(subject, automationId, descriptor.name)).some((grant) =>
      grant.tool === descriptor.name
      && grant.descriptorHash === descriptorHash(descriptor)
      && scopeCovers(grant.scope, slug));

  /**
   * The service-action slugs THIS firing holds a live grant for.
   *
   * §12's projection withholds every `ungraded` tool from an unattended listing,
   * and the connector dispatcher is `ungraded` by construction — so without this
   * a goal automation could never reach a connector at all, however explicitly a
   * person had allowed one action. The projection puts the dispatcher back
   * exactly when this is non-empty; the guard still decides each call. Read at
   * FIRE time rather than carried from arming, so a revoked grant takes the door
   * away on the next firing.
   */
  const grantedServiceSlugs = async (subject: string, automationId: string): Promise<string[]> => {
    const grants = await liveAutomationGrants(subject, automationId, USE_SERVICE_TOOL);
    const slugs = grants.flatMap((grant) => grant.scope.kind === "service-tool" ? [grant.scope.slug] : []);
    return [...new Set(slugs)].sort();
  };

  /** Whether the automation holds ANY live automation-source standing grant —
   *  the evidence a consent moment granted it something. */
  const anyLiveAutomationGrant = async (subject: string, automationId: string): Promise<boolean> =>
    (await liveAutomationGrants(subject, automationId)).some((grant) => grant.scope.kind !== "exact");

  return { descriptors, liveAutomationGrants, liveGrant, grantedServiceSlugs, anyLiveAutomationGrant };
};

/** The write: what a decided approval turns into — the guard's ONE mint when it
 *  offers one, and the identical row written here when a host's custom guard
 *  does not. Both arms build it with core's `buildGrant`, so the fallback can
 *  never drift into meaning something else. */
const createGrantMint = (
  { base: { config, engine, iso } }: GrantsDeps,
): Pick<GrantsAccess, "mintGrant"> => {
  const mintGrant = async (
    request: ApprovalRequest,
    automationId: string | undefined,
  ): Promise<string> => {
    const input: MintGrantInput = {
      request,
      remember: { duration: "standing" },
      source: "automation",
      // The record the person was actually looking at. Without it the grant
      // authorizes no away call at all, since the guard's away match is this id.
      ...(automationId === undefined ? {} : { automationId }),
    };
    const minted = await config.guard.mintGrant?.(input);
    if (minted !== undefined) return minted;
    const grant = buildGrant(input, id("grt_"), iso());
    await engine.put(GRANTS, { id: grant.id, data: grant, refs: grantRefs(grant) });
    return grant.id;
  };

  return { mintGrant };
};

export const createGrants = (deps: GrantsDeps): GrantsAccess =>
  ({ ...createGrantReads(deps), ...createGrantMint(deps) });
