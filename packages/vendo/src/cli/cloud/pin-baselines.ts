import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pinBaselineSchema, type PinBaseline } from "@vendoai/apps";
import type { Json } from "@vendoai/core";
import { hostedStore } from "../../hosted-store.js";

/**
 * Push the pin baselines `vendo sync` captured to Vendo Cloud, so the console's
 * Remix reviews screen can render what a fork actually changed.
 *
 * Until this landed, `.vendo/remixable/<slot>.json` never left the repo and the
 * console showed an honest "baselines haven't reached Cloud yet" state. The
 * transport is the ordinary public store door (`hostedStore`, the same adapter
 * a keyed runtime uses), writing the `vendo_pin_baselines` collection the
 * console reads — one record per slot, id = slot, `data` = the captured
 * baseline validated by the OSS `pinBaselineSchema`.
 *
 * WHAT CROSSES THE WIRE, explicitly: the wrapped component's SOURCE, the
 * source of every module it imports within the capture depth, and the app-root
 * stylesheets — the whole baseline file, verbatim. That is the point (a
 * reviewer cannot review a diff against source Cloud does not have), and it
 * happens ONLY when a Vendo Cloud key resolves. Keyless / BYO stays local and
 * makes no network call at all.
 */

export const PIN_BASELINES_COLLECTION = "vendo_pin_baselines";

export interface PinBaselinePushResult {
  pushed: string[];
  /** Slots deleted from Cloud because no local baseline names them anymore. */
  pruned: string[];
}

/** Every baseline on disk, slot-keyed. Unreadable or invalid files are simply
    not baselines — capture already reported them; a push never fails a build
    over one. */
async function localBaselines(vendoDir: string): Promise<Map<string, PinBaseline>> {
  const dir = join(vendoDir, "remixable");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const baselines = new Map<string, PinBaseline>();
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const raw = await fs.readFile(join(dir, entry), "utf8").catch(() => null);
    if (raw === null) continue;
    const parsed = pinBaselineSchema.safeParse(JSON.parse(raw) as unknown);
    if (parsed.success) baselines.set(parsed.data.slot, parsed.data);
  }
  return baselines;
}

/** A remote row already carries this exact capture. `capturedAt` moves
    whenever sync rewrites the file, and `hash` covers the primary source, so
    the pair is a sufficient equality test — and keeps an unchanged sync from
    re-uploading every component's source. */
function upToDate(remote: unknown, local: PinBaseline): boolean {
  const parsed = pinBaselineSchema.safeParse(remote);
  return parsed.success
    && parsed.data.hash === local.hash
    && parsed.data.capturedAt === local.capturedAt
    && (parsed.data.review === true) === (local.review === true);
}

/**
 * Reconcile Cloud with `.vendo/remixable/`: upload what is new or changed,
 * delete what no longer exists locally. Throws on transport failure — the
 * caller notes it and moves on (a Cloud hiccup must never fail a build).
 */
export async function pushPinBaselines(options: {
  vendoDir: string;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<PinBaselinePushResult> {
  const local = await localBaselines(options.vendoDir);
  const store = hostedStore({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
  });
  const records = store.records(PIN_BASELINES_COLLECTION);

  const remote = new Map<string, unknown>();
  let cursor: string | undefined;
  do {
    const page = await records.list(cursor === undefined ? {} : { cursor });
    for (const record of page.records) remote.set(record.id, record.data);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);

  const pushed: string[] = [];
  for (const [slot, baseline] of [...local.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (remote.has(slot) && upToDate(remote.get(slot), baseline)) continue;
    await records.put({ id: slot, data: baseline as unknown as Json });
    pushed.push(slot);
  }
  const pruned: string[] = [];
  for (const slot of [...remote.keys()].sort()) {
    if (local.has(slot)) continue;
    await records.delete(slot);
    pruned.push(slot);
  }
  return { pushed, pruned };
}
