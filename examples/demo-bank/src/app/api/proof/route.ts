/**
 * Wave-1 live-proof read door (docs/verification/wave1-live/). Gated on
 * MAPLE_HARNESS being set at all, so it does not exist in the shipped demo.
 *
 * Why a route and not a script: the local store is PGlite, which is
 * single-writer — a second process cannot open the same dataDir while the dev
 * server holds it. This reads the SAME store the running server writes, through
 * the shipped public doors (`workspaceStore`, `threadMessageStore`,
 * `auditStore`, `grantStore`, `runStore`, `records`).
 *
 * Read-only apart from `?undo=<path>`, which is E3's history walk.
 */
import type { Principal } from "@vendoai/core";
import {
  auditStore,
  grantStore,
  runStore,
  threadMessageStore,
  workspaceStore,
} from "@vendoai/store";
import { resolveMapleSession } from "@/vendo/auth";
import { harnessProofEnabled } from "@/vendo/harness-proof";
import { mapleAuth, vendo } from "@/vendo/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function enabled(): boolean {
  return process.env.MAPLE_HARNESS !== undefined;
}

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return new Response("not found", { status: 404 });
  const url = new URL(request.url);
  const user = await resolveMapleSession(request);
  if (user === null) return Response.json({ error: "no session" }, { status: 401 });
  const principal: Principal = { kind: "user", subject: user.subject };
  const store = vendo.store;
  const workspaces = workspaceStore(store);

  // Build contract §9.7 — undo/history address an OWNER derived from the path,
  // so they take the caller: who they are plus the orgs Maple asserts for them.
  const caller = { principal, memberships: await mapleAuth.memberships!(principal) };

  const undoPath = url.searchParams.get("undo");
  if (undoPath !== null) {
    return Response.json({ undo: await workspaces.undo(caller, undoPath) });
  }

  const historyPath = url.searchParams.get("history");
  if (historyPath !== null) {
    return Response.json({ history: await workspaces.history(caller, historyPath) });
  }

  const readPath = url.searchParams.get("read");
  if (readPath !== null) {
    const fs = await vendo.harness.workspace(principal);
    const exists = await fs.exists(readPath);
    return Response.json({
      path: readPath,
      exists,
      content: exists ? await fs.readFile(readPath) : null,
    });
  }

  // The default snapshot.
  const fs = await vendo.harness.workspace(principal);
  const paths = fs.getAllPaths();
  const threadRows = await store.records("vendo_threads").list({ refs: { subject: user.subject } });
  const messages = threadMessageStore(store);
  const perThread: Record<string, number> = {};
  for (const row of threadRows.records) {
    perThread[row.id] = (await messages.list(principal, row.id as never)).length;
  }
  const effects = await store.records("vendo_effects").list({ refs: { subject: user.subject } });
  // Unfiltered too: an empty subject-scoped read is only evidence of "no ledger
  // row" if the row is not simply filed under a different subject ref.
  const allEffects = await store.records("vendo_effects").list({});
  const audit = await auditStore(store).query({ subject: user.subject, limit: 200 } as never);
  const grants = await grantStore(store).list(principal, { includeInactive: true });
  const runs = await runStore(store).list({ limit: 50 });

  return Response.json({
    // The one fact every other number here is only meaningful next to.
    harnessMode: harnessProofEnabled(),
    maple_harness_env: process.env.MAPLE_HARNESS ?? null,
    subject: user.subject,
    // Only the harness path opens a workspace, so a non-empty /user tree is
    // itself evidence the new runtime served the turn.
    workspace: {
      total: paths.length,
      user: paths.filter((p) => p.startsWith("/user/")),
      host: paths.filter((p) => p.startsWith("/host/")),
    },
    transcript: { threads: perThread },
    effects: effects.records.map((r) => ({ id: r.id, data: r.data })),
    effectsAllSubjects: allEffects.records.map((r) => ({ id: r.id, data: r.data })),
    audit: {
      count: audit.events.length,
      events: audit.events.map((event) => {
        const e = event as unknown as Record<string, unknown>;
        return { kind: e["kind"], tool: e["tool"], decision: e["decision"], at: e["at"] };
      }),
    },
    grants: grants.map((grant) => {
      const g = grant as unknown as Record<string, unknown>;
      return {
        id: grant.id,
        tool: grant.tool,
        appId: g["appId"] ?? null,
        descriptorHash: grant.descriptorHash,
        revokedAt: g["revokedAt"] ?? null,
        intentHash: g["intentHash"] ?? null,
      };
    }),
    runs: runs.runs.map((r) => ({ id: r.id, appId: r.appId, status: r.status })),
  });
}
