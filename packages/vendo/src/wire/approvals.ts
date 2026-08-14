import { VendoError, type Principal } from "@vendoai/core";
import { handlePermissionRequest, type PermissionRequest, type VendoGuard } from "@vendoai/guard";
import { json, orgsCloudRequired, requestJson, route, string, type RouteEntry } from "./shared.js";

/** The five routes themselves are @vendoai/guard's ONE permission wire. What
    stays here is only what the UMBRELLA adds around them: the `?org=` clamp on
    every one of them, and the BYO `GET /approvals/:id` below. */
async function serve(
  guard: VendoGuard,
  principal: Principal,
  method: PermissionRequest["method"],
  path: string,
  body?: unknown,
): Promise<Response> {
  const result = await handlePermissionRequest(guard, principal, { method, path, body });
  if (result === undefined) throw new VendoError("not-found", `${method} ${path} is not a permission route`);
  return json(result.body);
}

/** 05-guard / 09 §3 — the approvals wire area. Org-scoped approvals
    (`?org=<id>` / body `org`) were a Vendo Cloud capability (block-actions
    design §C); orgs are cut from OSS (kill-list A5), so a request carrying an
    org param here now gets the same cloud-required error the /orgs routes
    answer, rather than silently ignoring it. */
export const approvalRoutes: RouteEntry[] = [
  route("GET", "/approvals", async ({ url, deps, context }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    return serve(deps.guard, ctx.principal, "GET", "/approvals");
  }),
  // Existing-agents Lane B — the read `<VendoApprovalEmbed>` polls for a
  // parked BYO guarded call: the frozen VendoApprovalEmbedState vocabulary,
  // carrying the full request while pending (the consent card shows real
  // inputs) and the resumed call's outcome once executed. Owner-scoped;
  // unknown and foreign ids both answer not-found. The umbrella's OWN route —
  // the shared wire has no per-approval read.
  route("GET", "/approvals/:id", async ({ url, deps, context, params }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    return json(await deps.byoApprovals.read(string(params["id"], "approval id"), ctx.principal));
  }),
  // "I take that back" — the exact mirror of DELETE /grants/:id, for the other
  // durable answer a person can give. A revoked denial stops answering its
  // call, so a misclicked no on a ceremony that re-issues a stable call id
  // (the apps runtime's secret and egress approvals) has a way out.
  route("DELETE", "/approvals/:id", async ({ url, deps, context, params }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    return serve(deps.guard, ctx.principal, "DELETE", `/approvals/${string(params["id"], "approval id")}`);
  }),
  route("POST", "/approvals/decide", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const ctx = await context("chat");
    if (body["org"] !== undefined) orgsCloudRequired();
    return serve(deps.guard, ctx.principal, "POST", "/approvals/decide", body);
  }),
];

/** Same cloud-required `?org=` scoping as approvals: standing grants scoping
    to an org is a Vendo Cloud capability. */
export const grantRoutes: RouteEntry[] = [
  route("GET", "/grants", async ({ url, deps, context }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    return serve(deps.guard, ctx.principal, "GET", "/grants");
  }),
  route("DELETE", "/grants/:id", async ({ url, deps, context, params }) => {
    const ctx = await context("chat");
    if (url.searchParams.get("org") !== null) orgsCloudRequired();
    return serve(deps.guard, ctx.principal, "DELETE", `/grants/${string(params["id"], "grant id")}`);
  }),
];
