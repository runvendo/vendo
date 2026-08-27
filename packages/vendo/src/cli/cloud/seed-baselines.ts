import { promises as fs } from "node:fs";
import { join } from "node:path";
import { seedBaselineSchema, type SeedBaseline } from "@vendoai/apps";
import type { Json } from "@vendoai/core";
import { hostedStore } from "@vendoai/store";

/**
 * Push the pin baselines `vendo sync` captured to Vendo Cloud, so the console's
 * Remix reviews screen can render what a fork actually changed.
 *
 * Until this landed, `.vendo/remixable/<slot>.json` never left the repo and the
 * console showed an honest "baselines haven't reached Cloud yet" state. The
 * transport is the ordinary public store door (`hostedStore`, the same adapter
 * a keyed runtime uses), writing the `vendo_pin_baselines` collection the
 * console reads — one record per slot, id = slot, `data` = the captured
 * baseline validated by the OSS `seedBaselineSchema`.
 *
 * WHAT CROSSES THE WIRE, explicitly: the wrapped component's SOURCE, the
 * source of every module it imports within the capture depth, and the app-root
 * stylesheets — the whole baseline file, verbatim. That is the point (a
 * reviewer cannot review a diff against source Cloud does not have), and it
 * happens ONLY when a Vendo Cloud key resolves. Keyless / BYO stays local and
 * makes no network call at all.
 */

export const PIN_BASELINES_COLLECTION = "vendo_pin_baselines";

/** One wall-clock budget for the WHOLE reconcile. The per-request timeout in
 *  hostedStore is 30s, so N slots could otherwise add minutes to a `prebuild`.
 *  Blowing the budget aborts the in-flight request and degrades to the
 *  caller's warning, exactly like any other Cloud hiccup. */
const RECONCILE_BUDGET_MS = 20_000;

export interface SeedBaselinePushResult {
  pushed: string[];
  /** Slots deleted from Cloud because no local baseline FILE names them. */
  pruned: string[];
  /** Baseline files that exist but could not be read as baselines. Never a
   *  prune signal — reported so a half-written capture is visible. */
  unreadable: string[];
  /** Set when the reconcile did not finish. `pushed`/`pruned` still carry
   *  whatever actually landed before it stopped (partial accounting). */
  error?: string;
}

interface LocalBaselines {
  /** Every slot with a FILE on disk, parseable or not. This — not the parsed
   *  map — is the prune signal: a truncated or half-written capture must never
   *  read as "this slot is gone" and delete the console's review baseline. */
  present: Set<string>;
  /** The parsed, valid baselines — the push payloads. */
  valid: Map<string, SeedBaseline>;
  unreadable: string[];
}

async function localBaselines(vendoDir: string): Promise<LocalBaselines> {
  const dir = join(vendoDir, "remixable");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const local: LocalBaselines = { present: new Set(), valid: new Map(), unreadable: [] };
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    // The file stem IS the slot (capturePins writes `<slot>.json`), so presence
    // is knowable without parsing — which is the whole point.
    const slot = entry.slice(0, -".json".length);
    local.present.add(slot);
    const raw = await fs.readFile(join(dir, entry), "utf8").catch(() => null);
    let parsed: SeedBaseline | null = null;
    if (raw !== null) {
      try {
        const candidate = seedBaselineSchema.safeParse(JSON.parse(raw) as unknown);
        if (candidate.success) parsed = candidate.data;
      } catch {
        // Malformed JSON — a half-written capture, not a deletion.
      }
    }
    // Keyed by the file stem, which capturePins guarantees equals `slot`: the
    // push id and the prune signal must name the same thing or a run could
    // push a row and then delete it.
    if (parsed === null || parsed.slot !== slot) local.unreadable.push(slot);
    else local.valid.set(slot, parsed);
  }
  return local;
}

/** A remote row already carries this exact capture. `capturedAt` moves
    whenever sync rewrites the file, and `hash` covers the primary source, so
    the pair is a sufficient equality test — and keeps an unchanged sync from
    re-uploading every component's source. */
function upToDate(remote: unknown, local: SeedBaseline): boolean {
  const parsed = seedBaselineSchema.safeParse(remote);
  return parsed.success
    && parsed.data.hash === local.hash
    && parsed.data.capturedAt === local.capturedAt;
}

/**
 * Reconcile Cloud with `.vendo/remixable/`: upload what is new or changed,
 * delete only slots whose file is GONE. Never throws — a Cloud hiccup returns
 * the partial accounting plus `error`, so the caller can warn without losing
 * track of what already landed.
 */
export async function pushSeedBaselines(options: {
  vendoDir: string;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  budgetMs?: number;
}): Promise<SeedBaselinePushResult> {
  const local = await localBaselines(options.vendoDir);
  const pushed: string[] = [];
  const pruned: string[] = [];
  const budgetMs = options.budgetMs ?? RECONCILE_BUDGET_MS;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), budgetMs);
  timer.unref?.();
  const done = (error?: unknown): SeedBaselinePushResult => ({
    pushed,
    pruned,
    unreadable: local.unreadable,
    ...(error === undefined ? {} : {
      error: budget.signal.aborted
        ? `the reconcile passed its ${budgetMs / 1000}s budget`
        : error instanceof Error ? error.message : "unknown error",
    }),
  });

  // consoleSender sets its own per-request signal, so the overall budget rides
  // a wrapped fetch instead of a request option.
  const base = options.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (input, init) => base(input, {
    ...init,
    signal: init?.signal === undefined || init.signal === null
      ? budget.signal
      : AbortSignal.any([init.signal, budget.signal]),
  });

  try {
    const store = hostedStore({
      apiKey: options.apiKey,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      fetch: fetchImpl,
    });
    // A pin baseline is one of Vendo's OWN drawers, so it rides the engine family.
    const engine = store.ops.engine;

    const remote = new Map<string, unknown>();
    let cursor: string | undefined;
    do {
      const page = await engine.list(PIN_BASELINES_COLLECTION, cursor === undefined ? {} : { cursor });
      for (const record of page.records) remote.set(record.id, record.data);
      if (page.cursor === undefined || page.cursor === cursor) break;
      cursor = page.cursor;
    } while (cursor !== undefined);

    for (const [slot, baseline] of [...local.valid].sort(([left], [right]) => left.localeCompare(right))) {
      if (remote.has(slot) && upToDate(remote.get(slot), baseline)) continue;
      await engine.put(PIN_BASELINES_COLLECTION, { id: slot, data: baseline as unknown as Json });
      pushed.push(slot);
    }
    for (const slot of [...remote.keys()].sort()) {
      // Presence on disk, not parseability: an unreadable file still means the
      // host has this slot, so its Cloud row stays.
      if (local.present.has(slot)) continue;
      await engine.delete(PIN_BASELINES_COLLECTION, slot);
      pruned.push(slot);
    }
    return done();
  } catch (error) {
    return done(error);
  } finally {
    clearTimeout(timer);
  }
}
