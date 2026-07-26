/**
 * POST /api/demo/pin — record a pin on an app the caller owns, landing it in a
 * host slot. This is Maple's implementation of the thread embed's onPin seam:
 * the pin is written onto the REAL app row (`doc.pins`), which is exactly
 * what VendoSlot's self-discovery (useSlotApp) reads — so the pinned app
 * appears in the "home-hero" slot and persists across navigation and reloads.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex, type AppDocument } from "@vendoai/core";
import { badRequest, notFound, ok } from "@/server/http";
import { resolveMapleSession } from "@/vendo/auth";
import { vendo } from "@/vendo/server";

/** The reserved vendo_apps record payload (02-store §2). Access rides the
 *  PUBLIC records door so the pin write behaves identically on the local
 *  PGlite store and the Cloud hosted store. */
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

/** Pin.base must be a "sha256:" hash (01-core §9), and detectPinDrift keeps a
 *  pin quiet only while it matches the slot's captured baseline hash — so the
 *  pin records the CURRENT `.vendo/remixable/<slot>.json` hash, exactly like
 *  the runtime's own fork-pin path. Fallback (baseline missing): the app's
 *  content hash — still a valid pin, but the slot shows a drift notice. */
async function pinBase(slot: string, doc: AppDocument): Promise<string> {
  try {
    const raw = await readFile(join(process.cwd(), ".vendo", "remixable", `${slot}.json`), "utf8");
    const baseline = JSON.parse(raw) as { hash?: unknown };
    if (typeof baseline.hash === "string" && baseline.hash.startsWith("sha256:")) return baseline.hash;
  } catch {
    // fall through to the content hash
  }
  const content: Partial<AppDocument> = structuredClone(doc);
  delete content.id;
  delete content.forkedFrom;
  return `sha256:${sha256Hex(canonicalJson(content))}`;
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

  // Latest pin wins per slot (useSlotApp takes the newest pinned app); clear
  // the slot from any OTHER app this user pinned earlier so the swap is clean.
  for (const other of await listSubjectApps(user.subject)) {
    if (other.id === appId || !other.data.doc.pins?.some((pin) => pin.slot === slot)) continue;
    await apps.put({
      id: other.id,
      data: {
        ...other.data,
        doc: { ...other.data.doc, pins: other.data.doc.pins.filter((pin) => pin.slot !== slot) },
      },
    });
  }

  const pins = [
    ...(row.data.doc.pins ?? []).filter((pin) => pin.slot !== slot),
    { slot, base: await pinBase(slot, row.data.doc) },
  ];
  await apps.put({ id: appId, data: { ...row.data, doc: { ...row.data.doc, pins } } });
  return ok({ pinned: true, appId, slot });
}
