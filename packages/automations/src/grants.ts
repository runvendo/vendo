/**
 * The standing automation grants a consent moment mints and a firing runs under:
 * the one live-grant read all three fire-time questions are asked from, and the
 * mint that scopes a connector dispatch to its SLUG.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import {
  DEFAULT_TRIGGER_ID,
  descriptorHash,
  permissionGrantSchema,
  serviceToolSlug,
  USE_SERVICE_TOOL,
  type ApprovalRequest,
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
  /** Every LIVE standing grant this (app, trigger) holds for the subject. */
  liveAutomationGrants(
    subject: string,
    appId: string,
    triggerId: string,
    tool?: string,
  ): Promise<PermissionGrant[]>;
  /** Whether this exact descriptor (and service action) is already granted. */
  liveGrant(
    subject: string,
    appId: string,
    triggerId: string,
    descriptor: ToolDescriptor,
    slug?: string,
  ): Promise<boolean>;
  /** The service-action slugs THIS firing holds a live grant for. */
  grantedServiceSlugs(subject: string, appId: string, triggerId: string): Promise<string[]>;
  /** Whether the TRIGGER holds ANY live automation-source standing grant. */
  anyLiveAutomationGrant(subject: string, appId: string, triggerId: string): Promise<boolean>;
  /** The standing grant a decided approval mints, scoped to its slug. */
  mintGrant(request: ApprovalRequest, triggerId: string | undefined): Promise<string>;
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
   * Every LIVE standing grant this (app, trigger) holds for the subject — the one
   * place the three fire-time questions below are asked from, so they cannot
   * answer differently about the same row.
   *
   * A grant minted while arming ONE trigger never authorizes another: the person
   * was shown that trigger's steps and consented to those. Rows minted before an
   * app had a trigger list carry no triggerId and stay valid for the trigger they
   * were minted for, which read-time normalization names `main`.
   */
  const liveAutomationGrants = async (
    subject: string,
    appId: string,
    triggerId: string,
    tool?: string,
  ): Promise<PermissionGrant[]> => {
    const records = await allRecords(engine, GRANTS, {
      refs: { subject, app_id: appId, ...(tool === undefined ? {} : { tool }) },
    });
    const at = now().getTime();
    const grants: PermissionGrant[] = [];
    for (const record of records) {
      const parsed = permissionGrantSchema.safeParse(record.data);
      if (!parsed.success) continue;
      const grant = parsed.data;
      if (grant.subject !== subject || grant.appId !== appId) continue;
      if ((grant.triggerId ?? DEFAULT_TRIGGER_ID) !== triggerId) continue;
      if (grant.source !== "automation" || grant.duration !== "standing") continue;
      if (grant.revokedAt !== undefined) continue;
      if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= at) continue;
      grants.push(grant);
    }
    return grants;
  };

  const liveGrant = async (
    subject: string,
    appId: string,
    triggerId: string,
    descriptor: ToolDescriptor,
    slug?: string,
  ): Promise<boolean> =>
    (await liveAutomationGrants(subject, appId, triggerId, descriptor.name)).some((grant) =>
      grant.tool === descriptor.name
      && grant.descriptorHash === descriptorHash(descriptor)
      && scopeCovers(grant.scope, slug));

  /**
   * The service-action slugs THIS firing holds a live grant for.
   *
   * §12's projection withholds every `ungraded` tool from an unattended listing,
   * and the connector dispatcher is `ungraded` by construction — so without this
   * an agentic automation could never reach a connector at all, however
   * explicitly a person had allowed one action. The projection puts the
   * dispatcher back exactly when this is non-empty; the guard still decides each
   * call. Read at FIRE time rather than carried from arming, so a revoked grant
   * takes the door away on the next firing.
   */
  const grantedServiceSlugs = async (
    subject: string,
    appId: string,
    triggerId: string,
  ): Promise<string[]> => {
    const grants = await liveAutomationGrants(subject, appId, triggerId, USE_SERVICE_TOOL);
    const slugs = grants.flatMap((grant) => grant.scope.kind === "service-tool" ? [grant.scope.slug] : []);
    return [...new Set(slugs)].sort();
  };

  /** Whether the TRIGGER holds ANY live automation-source standing grant — the
   *  evidence a consent moment granted it something. Per trigger, because the
   *  deny path below disarms exactly the trigger the person said no to, and a
   *  sibling trigger's grants are not evidence about this one. */
  const anyLiveAutomationGrant = async (
    subject: string,
    appId: string,
    triggerId: string,
  ): Promise<boolean> =>
    (await liveAutomationGrants(subject, appId, triggerId)).some((grant) => grant.scope.kind !== "exact");

  return { descriptors, liveAutomationGrants, liveGrant, grantedServiceSlugs, anyLiveAutomationGrant };
};

/** The write: what a decided approval turns into. */
const createGrantMint = (
  { base: { engine, iso } }: GrantsDeps,
): Pick<GrantsAccess, "mintGrant"> => {
  const mintGrant = async (request: ApprovalRequest, triggerId: string | undefined): Promise<string> => {
    // A connector dispatch is granted at the width of its SLUG, never its tool
    // name: "allow use_service_tool" would be consent to the broker's whole
    // catalog. Every other tool keeps the tool-wide grant an automation has
    // always minted — the slug is the only thing that narrows here.
    const slug = serviceToolSlug(request.call);
    const grant: PermissionGrant = {
      id: id("grt_"),
      subject: request.ctx.principal.subject,
      tool: request.call.tool,
      descriptorHash: descriptorHash(request.descriptor),
      scope: slug === undefined ? { kind: "tool" } : { kind: "service-tool", slug },
      duration: "standing",
      ...(request.ctx.appId === undefined ? {} : { appId: request.ctx.appId }),
      // The trigger the person was actually looking at. Without it the grant
      // would be app-wide, and arming one trigger would silently authorize every
      // other trigger of the same app.
      ...(triggerId === undefined ? {} : { triggerId }),
      source: "automation",
      grantedAt: iso(),
    };
    await engine.put(GRANTS, {
      id: grant.id,
      data: grant,
      refs: {
        subject: grant.subject,
        tool: grant.tool,
        ...(grant.appId === undefined ? {} : { app_id: grant.appId }),
        // The reserved grants table derives this ref from the row's own column,
        // but a generic StoreAdapter honors what is passed here — and one that
        // filtered on `app_id` alone would hand back a sibling trigger's grant,
        // making the ref-trusting adapter WIDER than the JS filter above it.
        ...(grant.triggerId === undefined ? {} : { trigger_id: grant.triggerId }),
      },
    });
    return grant.id;
  };

  return { mintGrant };
};

export const createGrants = (deps: GrantsDeps): GrantsAccess =>
  ({ ...createGrantReads(deps), ...createGrantMint(deps) });
