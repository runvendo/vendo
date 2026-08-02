/**
 * POST /api/demo/pin — record a placement on an app the caller owns, landing
 * it in a host slot. This is Maple's implementation of the thread embed's
 * onPin seam: the placement is written onto the REAL app row
 * (`doc.placements`), which is exactly what VendoSlot's self-discovery
 * (useSlotApp) reads — so the app appears in the "home-hero" slot and
 * persists across navigation and reloads. A placement is a slot NAME only
 * (2026-08-02 pins/placements split); `doc.pins` records fork provenance and
 * is never written here.
 */
import type { AppDocument } from "@vendoai/core";
import { badRequest, notFound, ok } from "@/server/http";
import { resolveMapleSession } from "@/vendo/auth";
import { vendo } from "@/vendo/server";

/** The reserved vendo_apps record payload (02-store §2). Access rides the
 *  PUBLIC records door so the placement write behaves identically on the
 *  local PGlite store and the Cloud hosted store. */
interface AppData {
  subject: string;
  enabled: boolean;
  doc: AppDocument;
}

interface AppRecord {
  id: string;
  data: AppData;
}

function appRecord(record: { id: string; data: unknown } | null): AppRecord | null {
  if (record === null) return null;
  return { id: record.id, data: record.data as AppData };
}

/** Every vendo_apps row this subject owns (the records door pages; a demo
 *  user has a handful of rows, so the loop settles in one or two pages). */
async function listSubjectApps(subject: string): Promise<AppRecord[]> {
  const apps = vendo.store.records("vendo_apps");
  const rows: AppRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await apps.list({ refs: { subject }, ...(cursor === undefined ? {} : { cursor }) });
    for (const record of page.records) rows.push({ id: record.id, data: record.data as AppData });
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLOTS = new Set(["home-hero"]);

export async function POST(request: Request) {
  const user = await resolveMapleSession(request);
  if (user === null) return badRequest("Sign in to pin a view.");
  let body: { appId?: unknown; slot?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest("Expected a JSON body.");
  }
  const appId = typeof body.appId === "string" ? body.appId : undefined;
  const slot = typeof body.slot === "string" ? body.slot : undefined;
  if (!appId || !slot || !SLOTS.has(slot)) return badRequest("Expected { appId, slot: \"home-hero\" }.");

  const apps = vendo.store.records("vendo_apps");
  const row = appRecord(await apps.get(appId));
  if (row === null || row.data.subject !== user.subject) return notFound("App not found.");

  // Latest placement wins per slot (useSlotApp takes the newest placed app);
  // clear the slot from any OTHER app this user placed earlier so the swap is
  // clean.
  for (const other of await listSubjectApps(user.subject)) {
    if (other.id === appId || !other.data.doc.placements?.includes(slot)) continue;
    await apps.put({
      id: other.id,
      data: {
        ...other.data,
        doc: { ...other.data.doc, placements: other.data.doc.placements.filter((name) => name !== slot) },
      },
    });
  }

  const placements = [...(row.data.doc.placements ?? []).filter((name) => name !== slot), slot];
  await apps.put({ id: appId, data: { ...row.data, doc: { ...row.data.doc, placements } } });
  return ok({ pinned: true, appId, slot });
}
