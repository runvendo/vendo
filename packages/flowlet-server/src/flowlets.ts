/**
 * `/flowlets` endpoints — server-side registry for the shell's saved-flowlet
 * seam (`packages/flowlet-shell/src/seams/store.ts`'s `FlowletStore`).
 *
 * Reconciliation note (Task 15): `@flowlet/store` (Task 9) already ships
 * `createDrizzleSavedFlowletStore`, but it ports the CORE `SavedFlowletStore`
 * seam (`packages/flowlet-core/src/seams/store.ts`'s `SavedFlowlet` — a
 * `uiTree`/`query`/`originatingPrompt` shape with store-assigned ids and
 * ISO-string timestamps). The shell's `FlowletStore` — what `FlowletRoot`'s
 * client actually persists via `createWebStorage` today — is a different
 * shape (`node`/`prompt`/`components`, caller-assigned id, numeric epoch
 * timestamps). The endpoints must speak that shell shape verbatim, since
 * that's the seam the client already implements against. Rather than force a
 * lossy mapping between the two record shapes now, this file is a THIN
 * registry of its own directly over the `saved_flowlets` table (reusing the
 * same jsonb `record` column + schema from `@flowlet/store`, just typed as
 * the shell's `Flowlet`). Core's `SavedFlowletStore` port stays as Task 9
 * left it, unused by this path — reconciling the two only matters once cloud
 * sync needs one canonical shape (YAGNI otherwise).
 */
import { and, desc, eq, savedFlowlets, type FlowletDb } from "@flowlet/store";
import type { Principal } from "@flowlet/core";
import type { Flowlet, FlowletDraft } from "@flowlet/shell";
import { resolvePrincipal, threadScope } from "./guard";
import type { FlowletHandlerOptions } from "./options";

/** Principal-scoped counterpart to the shell's `FlowletStore` (which has no
 *  scope param — the browser is inherently single-user). Same four verbs. */
export interface FlowletRegistry {
  list(scope: Principal): Promise<Flowlet[]>;
  load(scope: Principal, id: string): Promise<Flowlet | null>;
  save(scope: Principal, draft: FlowletDraft): Promise<Flowlet>;
  remove(scope: Principal, id: string): Promise<void>;
}

interface OwnedFlowlet extends Flowlet {
  tenantId: string;
  subject: string;
}

const sameScope = (scope: Principal, owned: { tenantId: string; subject: string }): boolean =>
  scope.tenantId === owned.tenantId && scope.subject === owned.subject;

function keyOf(scope: Principal, id: string): string {
  return JSON.stringify([scope.tenantId, scope.subject, id]);
}

function toRecord(owned: OwnedFlowlet): Flowlet {
  const { tenantId: _t, subject: _s, ...record } = owned;
  return record;
}

/** In-memory fallback (storage: false / test-env default) — same upsert
 *  contract as `createLocalStore`/`createWebStorage`, just Principal-scoped. */
export function createInMemoryFlowletRegistry(opts: { now?: () => number } = {}): FlowletRegistry {
  const now = opts.now ?? Date.now;
  const map = new Map<string, OwnedFlowlet>();

  return {
    async list(scope) {
      return [...map.values()]
        .filter((f) => sameScope(scope, f))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(toRecord);
    },
    async load(scope, id) {
      const owned = map.get(keyOf(scope, id));
      return owned ? toRecord(owned) : null;
    },
    async save(scope, draft) {
      const key = keyOf(scope, draft.id);
      const existing = map.get(key);
      const updatedAt = draft.updatedAt ?? now();
      const createdAt = draft.createdAt ?? existing?.createdAt ?? updatedAt;
      const owned: OwnedFlowlet = {
        ...draft,
        createdAt,
        updatedAt,
        tenantId: scope.tenantId,
        subject: scope.subject,
      };
      map.set(key, owned);
      return toRecord(owned);
    },
    async remove(scope, id) {
      map.delete(keyOf(scope, id));
    },
  };
}

/** Durable registry — the whole shell `Flowlet` record lives verbatim in the
 *  `saved_flowlets.record` jsonb column; `updated_at` is denormalized onto
 *  its own column purely so `list()` can order by it without unpacking jsonb
 *  per row (same trick Task 9's core-shaped port uses on the same table). */
export function createDrizzleFlowletRegistry(
  handle: FlowletDb,
  opts: { now?: () => number } = {},
): FlowletRegistry {
  const db = handle.db;
  const now = opts.now ?? Date.now;

  async function loadOne(scope: Principal, id: string): Promise<Flowlet | null> {
    const rows = await db
      .select()
      .from(savedFlowlets)
      .where(
        and(
          eq(savedFlowlets.tenantId, scope.tenantId),
          eq(savedFlowlets.subject, scope.subject),
          eq(savedFlowlets.id, id),
        ),
      );
    return rows[0] ? (rows[0].record as Flowlet) : null;
  }

  return {
    async list(scope) {
      const rows = await db
        .select()
        .from(savedFlowlets)
        .where(and(eq(savedFlowlets.tenantId, scope.tenantId), eq(savedFlowlets.subject, scope.subject)))
        .orderBy(desc(savedFlowlets.updatedAt));
      return rows.map((row) => row.record as Flowlet);
    },
    async load(scope, id) {
      return loadOne(scope, id);
    },
    async save(scope, draft) {
      const updatedAt = draft.updatedAt ?? now();
      const createdAt = draft.createdAt ?? (await loadOne(scope, draft.id))?.createdAt ?? updatedAt;
      const flowlet: Flowlet = { ...draft, createdAt, updatedAt };
      await db
        .insert(savedFlowlets)
        .values({
          id: draft.id,
          tenantId: scope.tenantId,
          subject: scope.subject,
          record: flowlet,
          updatedAt: new Date(updatedAt).toISOString(),
        })
        .onConflictDoUpdate({
          target: [savedFlowlets.tenantId, savedFlowlets.subject, savedFlowlets.id],
          set: { record: flowlet, updatedAt: new Date(updatedAt).toISOString() },
        });
      return flowlet;
    },
    async remove(scope, id) {
      await db
        .delete(savedFlowlets)
        .where(
          and(
            eq(savedFlowlets.tenantId, scope.tenantId),
            eq(savedFlowlets.subject, scope.subject),
            eq(savedFlowlets.id, id),
          ),
        );
    },
  };
}

export interface FlowletsDeps {
  registry: FlowletRegistry;
  options: FlowletHandlerOptions;
}

/** GET flowlets | GET flowlets/<id> — principal-guarded like /threads. */
export async function handleFlowletsGet(req: Request, tail: string, deps: FlowletsDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  const scope = threadScope(guard.principal);

  if (tail === "flowlets") {
    return Response.json(await deps.registry.list(scope));
  }
  // routeTail preserves percent-encoding; ids may contain escaped chars.
  const id = decodeURIComponent(tail.slice("flowlets/".length));
  const flowlet = await deps.registry.load(scope, id);
  if (!flowlet) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(flowlet);
}

/** POST flowlets (save) | POST flowlets/<id>/delete — the verb convention
 *  every mutating endpoint here uses (GET/POST only, no DELETE method). */
export async function handleFlowletsPost(req: Request, tail: string, deps: FlowletsDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  const scope = threadScope(guard.principal);

  if (tail.endsWith("/delete")) {
    const id = decodeURIComponent(tail.slice("flowlets/".length, -"/delete".length));
    await deps.registry.remove(scope, id);
    return Response.json({ ok: true });
  }

  const draft = (await req.json().catch(() => null)) as FlowletDraft | null;
  if (!draft || typeof draft.id !== "string" || draft.id.length === 0) {
    return Response.json({ error: "invalid flowlet draft" }, { status: 400 });
  }
  const saved = await deps.registry.save(scope, draft);
  return Response.json(saved);
}
