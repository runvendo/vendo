/**
 * `/vendos` endpoints — server-side registry for the shell's saved-vendo
 * seam (`packages/vendo-shell/src/seams/store.ts`'s `VendoStore`).
 *
 * Reconciliation note (Task 15): `@vendoai/store` (Task 9) already ships
 * `createDrizzleSavedVendoStore`, but it ports the CORE `SavedVendoStore`
 * seam (`packages/vendo-core/src/seams/store.ts`'s `SavedVendo` — a
 * `uiTree`/`query`/`originatingPrompt` shape with store-assigned ids and
 * ISO-string timestamps). The shell's `VendoStore` — what `VendoRoot`'s
 * client actually persists via `createWebStorage` today — is a different
 * shape (`node`/`prompt`/`components`, caller-assigned id, numeric epoch
 * timestamps). The endpoints must speak that shell shape verbatim, since
 * that's the seam the client already implements against. Rather than force a
 * lossy mapping between the two record shapes now, this file is a THIN
 * registry of its own directly over the `saved_vendos` table (reusing the
 * same jsonb `record` column + schema from `@vendoai/store`, just typed as
 * the shell's `Vendo`). Core's `SavedVendoStore` port stays as Task 9
 * left it, unused by this path — reconciling the two only matters once cloud
 * sync needs one canonical shape (YAGNI otherwise).
 */
import { and, desc, eq, savedVendos, type VendoDb } from "@vendoai/store";
import type { Principal } from "@vendoai/core";
import type { Vendo, VendoDraft } from "@vendoai/shell";
import { resolvePrincipal, threadScope } from "./guard";
import type { VendoHandlerOptions } from "./options";

// KEEP IN SYNC with handler.ts's `FIRST_SEGMENTS` (not imported directly —
// handler.ts already imports this module, so importing back would cycle).
// A saved vendo's id is caller-assigned (unlike a thread's store-assigned
// UUID), so a client could pick an id that collides with a reserved
// routeTail first segment (e.g. a vendo literally named "chat"). routeTail
// scans right-to-left for the FIRST reserved segment, so such an id would
// shorten the tail and misroute GET/POST vendos/<id>[/delete] onto the
// wrong endpoint. Rejected at save time instead.
const RESERVED_VENDO_IDS = new Set([
  "chat",
  "action",
  "integrations",
  "capabilities",
  "deliveries",
  "tick",
  "resume",
  "consent",
  "fade-proposal",
  "parked-actions",
  "grants",
  "rules",
  "audit",
  "critical-tools",
  "webhooks",
  "threads",
  "vendos",
]);

/** Would this id misroute through routeTail's first-segment scan? */
function isUnsafeVendoId(id: string): boolean {
  return RESERVED_VENDO_IDS.has(id) || id.includes("/");
}

/** Principal-scoped counterpart to the shell's `VendoStore` (which has no
 *  scope param — the browser is inherently single-user). Same four verbs. */
export interface VendoRegistry {
  list(scope: Principal): Promise<Vendo[]>;
  load(scope: Principal, id: string): Promise<Vendo | null>;
  save(scope: Principal, draft: VendoDraft): Promise<Vendo>;
  remove(scope: Principal, id: string): Promise<void>;
}

interface OwnedVendo extends Vendo {
  tenantId: string;
  subject: string;
}

const sameScope = (scope: Principal, owned: { tenantId: string; subject: string }): boolean =>
  scope.tenantId === owned.tenantId && scope.subject === owned.subject;

function keyOf(scope: Principal, id: string): string {
  return JSON.stringify([scope.tenantId, scope.subject, id]);
}

function toRecord(owned: OwnedVendo): Vendo {
  const { tenantId: _t, subject: _s, ...record } = owned;
  return record;
}

/** In-memory fallback (storage: false / test-env default) — same upsert
 *  contract as `createLocalStore`/`createWebStorage`, just Principal-scoped. */
export function createInMemoryVendoRegistry(opts: { now?: () => number } = {}): VendoRegistry {
  const now = opts.now ?? Date.now;
  const map = new Map<string, OwnedVendo>();

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
      const owned: OwnedVendo = {
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

/** Durable registry — the whole shell `Vendo` record lives verbatim in the
 *  `saved_vendos.record` jsonb column; `updated_at` is denormalized onto
 *  its own column purely so `list()` can order by it without unpacking jsonb
 *  per row (same trick Task 9's core-shaped port uses on the same table). */
export function createDrizzleVendoRegistry(
  handle: VendoDb,
  opts: { now?: () => number } = {},
): VendoRegistry {
  const db = handle.db;
  const now = opts.now ?? Date.now;

  async function loadOne(scope: Principal, id: string): Promise<Vendo | null> {
    const rows = await db
      .select()
      .from(savedVendos)
      .where(
        and(
          eq(savedVendos.tenantId, scope.tenantId),
          eq(savedVendos.subject, scope.subject),
          eq(savedVendos.id, id),
        ),
      );
    return rows[0] ? (rows[0].record as Vendo) : null;
  }

  return {
    async list(scope) {
      const rows = await db
        .select()
        .from(savedVendos)
        .where(and(eq(savedVendos.tenantId, scope.tenantId), eq(savedVendos.subject, scope.subject)))
        .orderBy(desc(savedVendos.updatedAt));
      return rows.map((row) => row.record as Vendo);
    },
    async load(scope, id) {
      return loadOne(scope, id);
    },
    async save(scope, draft) {
      const updatedAt = draft.updatedAt ?? now();
      const createdAt = draft.createdAt ?? (await loadOne(scope, draft.id))?.createdAt ?? updatedAt;
      const vendo: Vendo = { ...draft, createdAt, updatedAt };
      await db
        .insert(savedVendos)
        .values({
          id: draft.id,
          tenantId: scope.tenantId,
          subject: scope.subject,
          record: vendo,
          updatedAt: new Date(updatedAt).toISOString(),
        })
        .onConflictDoUpdate({
          target: [savedVendos.tenantId, savedVendos.subject, savedVendos.id],
          set: { record: vendo, updatedAt: new Date(updatedAt).toISOString() },
        });
      return vendo;
    },
    async remove(scope, id) {
      await db
        .delete(savedVendos)
        .where(
          and(
            eq(savedVendos.tenantId, scope.tenantId),
            eq(savedVendos.subject, scope.subject),
            eq(savedVendos.id, id),
          ),
        );
    },
  };
}

export interface VendosDeps {
  registry: VendoRegistry;
  options: VendoHandlerOptions;
}

/** GET vendos | GET vendos/<id> — principal-guarded like /threads. */
export async function handleVendosGet(req: Request, tail: string, deps: VendosDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  const scope = threadScope(guard.principal);

  if (tail === "vendos") {
    return Response.json(await deps.registry.list(scope));
  }
  // routeTail preserves percent-encoding; ids may contain escaped chars.
  const id = decodeURIComponent(tail.slice("vendos/".length));
  const vendo = await deps.registry.load(scope, id);
  if (!vendo) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(vendo);
}

/** POST vendos (save) | POST vendos/<id>/delete — the verb convention
 *  every mutating endpoint here uses (GET/POST only, no DELETE method). */
export async function handleVendosPost(req: Request, tail: string, deps: VendosDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  const scope = threadScope(guard.principal);

  if (tail.endsWith("/delete")) {
    const id = decodeURIComponent(tail.slice("vendos/".length, -"/delete".length));
    await deps.registry.remove(scope, id);
    return Response.json({ ok: true });
  }

  const draft = (await req.json().catch(() => null)) as VendoDraft | null;
  if (!draft || typeof draft.id !== "string" || draft.id.length === 0) {
    return Response.json({ error: "invalid vendo draft" }, { status: 400 });
  }
  if (isUnsafeVendoId(draft.id)) {
    return Response.json(
      {
        error:
          `vendo id "${draft.id}" is reserved or invalid — ids may not equal a reserved route ` +
          `segment (${[...RESERVED_VENDO_IDS].join(", ")}) or contain "/", since either would ` +
          "misroute this vendo's GET/POST endpoints.",
      },
      { status: 400 },
    );
  }
  const saved = await deps.registry.save(scope, draft);
  return Response.json(saved);
}
