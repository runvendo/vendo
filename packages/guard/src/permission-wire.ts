/**
 * ONE permission wire. Five routes — the pending asks, the decision, the two
 * take-backs, the standing grants — served identically by every surface that
 * mounts them (the umbrella's `/api/vendo`, `@vendoai/agents`'s mount, a host
 * wiring the guard itself), because `@vendoai/ui`'s consent surfaces post to
 * ONE shape and a second hand-rolled copy is how they come to disagree.
 *
 * `undefined` means "not one of mine": the caller falls through to its own
 * table rather than answering not-found on someone else's path.
 */
import {
  approvalDecisionSchema,
  isVendoError,
  VendoError,
  type ApprovalDecision,
  type ApprovalId,
  type GrantId,
  type Json,
  type Principal,
  type VendoErrorCode,
} from "@vendoai/core";
import type { VendoGuard } from "./types.js";

export interface PermissionRequest {
  method: "GET" | "POST" | "DELETE";
  /** Mount-relative: `/approvals`, `/approvals/decide`, `/grants/grt_1`, … */
  path: string;
  body?: unknown;
}

export interface PermissionsHandlerDeps {
  guard: VendoGuard;
  principal: (request: Request) => Promise<Principal | null>;
  /** Where these routes are mounted; unset → the umbrella's base path. */
  mount?: string;
}

/** The umbrella's base path, and the mount `@vendoai/agents` documents. */
const DEFAULT_MOUNT = "/api/vendo";

const STATUS_BY_CODE: Partial<Record<VendoErrorCode, number>> = {
  validation: 400,
  "not-found": 404,
  conflict: 409,
  // A store missing the atomic operations a decision or a take-back needs is a
  // fact about the DEPLOYMENT, not about this person's permissions — 501, the
  // same as the umbrella's wire (packages/vendo/src/wire/shared.ts), because
  // the 403 fallback tells a client to re-prompt a person who cannot help.
  "not-implemented": 501,
};

function approvalIds(body: unknown): ApprovalId[] {
  const ids = (body as { ids?: unknown } | undefined)?.ids;
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) throw new VendoError("validation", "ids must contain at least one approval id");
  for (const id of list) {
    if (typeof id !== "string" || id.length === 0) {
      throw new VendoError("validation", "approval id must be a non-empty string");
    }
  }
  return list as ApprovalId[];
}

function approvalDecision(body: unknown): ApprovalDecision {
  const parsed = approvalDecisionSchema.safeParse((body as { decision?: unknown } | undefined)?.decision);
  if (!parsed.success) throw new VendoError("validation", "decision is invalid");
  return parsed.data as ApprovalDecision;
}

export async function handlePermissionRequest(
  guard: VendoGuard,
  principal: Principal,
  request: PermissionRequest,
): Promise<{ body: Json } | undefined> {
  const [area, id, ...rest] = request.path.split("/").filter(Boolean);
  if (rest.length > 0) return undefined;
  if (area === "approvals") {
    if (request.method === "GET" && id === undefined) {
      return { body: await guard.approvals.pending(principal) as unknown as Json };
    }
    if (request.method === "POST" && id === "decide") {
      await guard.approvals.decide(approvalIds(request.body), approvalDecision(request.body), principal);
      return { body: {} };
    }
    if (request.method === "DELETE" && id !== undefined) {
      await guard.approvals.revoke(id as ApprovalId, principal);
      return { body: {} };
    }
  }
  if (area === "grants") {
    if (request.method === "GET" && id === undefined) {
      return { body: await guard.grants.list(principal) as unknown as Json };
    }
    if (request.method === "DELETE" && id !== undefined) {
      await guard.grants.revoke(id as GrantId, principal);
      return { body: {} };
    }
  }
  return undefined;
}

/** The same five routes as a fetch handler, for a host that mounts them itself.
 *  Which AREA a path names is decided before the principal is resolved, so a
 *  neighbour on the same mount (the MCP door) falls through instead of being
 *  challenged for a credential it does not owe this handler. */
export function permissionsHandler(
  deps: PermissionsHandlerDeps,
): (request: Request) => Promise<Response | undefined> {
  // `mount` is free-form, so a host may spell it with a trailing slash. Strip it
  // once here rather than doubling it into the boundary below, which would make
  // every ordinary path fall through and leave the consent surface silently dead.
  const mount = (deps.mount ?? DEFAULT_MOUNT).replace(/\/$/, "");
  return async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    // The mount is a path BOUNDARY, not a string prefix: `/api/vendoapprovals`
    // is somebody else's route, and this handler promised to fall through.
    if (!pathname.startsWith(`${mount}/`)) return undefined;
    const path = pathname.slice(mount.length);
    const area = path.split("/").filter(Boolean)[0];
    if (area !== "approvals" && area !== "grants") return undefined;
    const principal = await deps.principal(request);
    if (principal === null) return new Response(null, { status: 401 });
    try {
      const result = await handlePermissionRequest(deps.guard, principal, {
        method: request.method as PermissionRequest["method"],
        path,
        ...(request.method === "POST" ? { body: await request.json().catch(() => undefined) } : {}),
      });
      return result === undefined ? undefined : Response.json(result.body);
    } catch (error) {
      if (!isVendoError(error)) throw error;
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: STATUS_BY_CODE[error.code] ?? 403 },
      );
    }
  };
}
