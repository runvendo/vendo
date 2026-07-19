import { VendoError, approvalDecisionSchema, type ApprovalDecision } from "@vendoai/core";
import { json, orgsCloudRequired, requestJson, route, string, type RouteEntry } from "./shared.js";

/** 05-guard / 09 §3 — the approvals wire area. Org-scoped approvals
    (`?org=<id>` / body `org`) were a Vendo Cloud capability (block-actions
    design §C); orgs are cut from OSS (kill-list A5), so a request carrying an
    org param here now gets the same cloud-required error the /orgs routes
    answer, rather than silently ignoring it. */
export const approvalRoutes: RouteEntry[] = [
  route("GET", "/approvals", async ({ url, deps, context }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    return json(await deps.guard.approvals.pending(ctx.principal));
  }),
  route("POST", "/approvals/decide", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const ids = Array.isArray(body["ids"]) ? body["ids"].map((id) => string(id, "approval id")) : [];
    if (ids.length === 0) throw new VendoError("validation", "ids must contain at least one approval id");
    const decision = approvalDecisionSchema.safeParse(body["decision"]);
    if (!decision.success) throw new VendoError("validation", "decision is invalid");
    const ctx = await context("chat");
    if (body["org"] !== undefined) orgsCloudRequired();
    await deps.guard.approvals.decide(ids, decision.data as ApprovalDecision, ctx.principal);
    return json({});
  }),
];

/** Same cloud-required `?org=` scoping as approvals: standing grants scoping
    to an org is a Vendo Cloud capability. */
export const grantRoutes: RouteEntry[] = [
  route("GET", "/grants", async ({ url, deps, context }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    return json(await deps.guard.grants.list(ctx.principal));
  }),
  route("DELETE", "/grants/:id", async ({ url, deps, context, params }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    await deps.guard.grants.revoke(string(params["id"], "grant id"), ctx.principal);
    return json({});
  }),
];
