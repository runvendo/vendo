import { promises as fs } from "node:fs";
import { join } from "node:path";
import { capturedHostComponentSchema, capturedModuleSchema, type CapturedHostComponent } from "@vendoai/actions";
import type { Json } from "@vendoai/core";
import { hostedStore } from "../../hosted-store.js";

/**
 * Push the registered-component corpus `vendo sync` captured to Vendo Cloud, so
 * the console's Apps gallery renders the host's own components for real instead
 * of a grey labeled placeholder.
 *
 * WHAT CROSSES THE WIRE: the source of every component the host registers in
 * `<VendoProvider components={…}>`, the source of every module in each component's
 * import closure, and the app-root stylesheets. Package code never does (the
 * capture stops at node_modules). It happens only when a Vendo Cloud key
 * resolves AND the project said yes once (`.vendo/cloud.json`) — keyless / BYO
 * makes no request at all.
 *
 * THE SHAPE, in two halves, and the split is what makes the push cheap:
 *
 *  - RECORDS `vendo_host_components` — id = component name, data =
 *    `CapturedHostComponent`: refs, no source, a few hundred bytes. Listing the
 *    collection IS the hash manifest; there is no manifest row to drift from
 *    the truth.
 *  - BLOBS `vendo_host_components` — key = the module's sha-256 hex, body =
 *    `{ source, imports? }` JSON. `blobs.list()` returns KEYS ONLY, so one call
 *    answers "which of my hashes do you already have?" without downloading a
 *    byte of source. Content addressing means a key that exists is by
 *    definition current.
 *
 * An unchanged second sync therefore costs two calls and uploads nothing.
 */

export const HOST_COMPONENTS_COLLECTION = "vendo_host_components";

/** Project-level setting, committed with the rest of `.vendo/`: may this
 *  project's registered-component source go to Vendo Cloud? Asked once, in an
 *  interactive sync, then never again. It is a PROJECT decision (the repo's
 *  source, the repo's call), not a per-user consent record. */
const CLOUD_SETTINGS = "cloud.json";

export async function readPushComponents(vendoDir: string): Promise<boolean | undefined> {
  const raw = await fs.readFile(join(vendoDir, CLOUD_SETTINGS), "utf8").catch(() => null);
  const value = raw === null ? undefined : (safeJson(raw) as { pushComponents?: unknown } | undefined)?.pushComponents;
  return typeof value === "boolean" ? value : undefined;
}

export async function writePushComponents(vendoDir: string, pushComponents: boolean): Promise<void> {
  const file = join(vendoDir, CLOUD_SETTINGS);
  const existing = (safeJson(await fs.readFile(file, "utf8").catch(() => "")) ?? {}) as Record<string, unknown>;
  await fs.mkdir(vendoDir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...existing, pushComponents }, null, 2)}\n`, "utf8");
}

/** One wall-clock budget for the WHOLE reconcile, same posture as the pin
 *  baseline push: blowing it aborts the in-flight request and degrades to the
 *  caller's warning rather than adding minutes to a `prebuild`. */
const RECONCILE_BUDGET_MS = 30_000;

/** The index rows are a few hundred bytes each; the store's default page is
 *  100, which would make a 400-component registry four round trips for no
 *  reason. */
const RECORD_PAGE_SIZE = 1_000;

export interface HostComponentPushResult {
  pushed: string[];
  /** Component records deleted from Cloud because no local FILE names them. */
  pruned: string[];
  /** Module blobs uploaded (the misses) and deleted (unreferenced). */
  modules: { uploaded: number; deleted: number };
  /** Bytes of module source uploaded this run. */
  uploadedBytes: number;
  /** Record files that exist but could not be read. Never a prune signal. */
  unreadable: string[];
  error?: string;
}

interface LocalCorpus {
  /** Every component with a FILE on disk, parseable or not — the prune signal. */
  present: Set<string>;
  records: Map<string, CapturedHostComponent>;
  /** Content address -> the blob bytes, for everything the records reference. */
  modules: Map<string, string>;
  unreadable: string[];
}

function referencedRefs(record: CapturedHostComponent): string[] {
  return [
    ...(record.entry === undefined ? [] : [record.entry]),
    ...Object.values(record.modules ?? {}),
    ...(record.styles ?? []).map((style) => style.ref),
  ];
}

async function readLocal(vendoDir: string): Promise<LocalCorpus> {
  const dir = join(vendoDir, "components");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const local: LocalCorpus = { present: new Set(), records: new Map(), modules: new Map(), unreadable: [] };
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    // The file stem IS the component name (capture writes `<Name>.json`), so
    // presence is knowable without parsing — which is the whole point.
    const name = entry.slice(0, -".json".length);
    local.present.add(name);
    const raw = await fs.readFile(join(dir, entry), "utf8").catch(() => null);
    const parsed = raw === null ? null : capturedHostComponentSchema.safeParse(safeJson(raw));
    if (parsed === null || !parsed.success || parsed.data.name !== name) {
      local.unreadable.push(name);
      continue;
    }
    local.records.set(name, parsed.data);
  }
  for (const record of local.records.values()) {
    for (const ref of referencedRefs(record)) {
      if (local.modules.has(ref)) continue;
      const raw = await fs.readFile(join(dir, "modules", `${ref}.json`), "utf8").catch(() => null);
      // A record whose module is missing is a half-written capture: leave the
      // whole record out rather than push a component the console cannot build.
      if (raw === null || !capturedModuleSchema.safeParse(safeJson(raw)).success) continue;
      local.modules.set(ref, raw);
    }
  }
  for (const [name, record] of [...local.records]) {
    if (referencedRefs(record).every((ref) => local.modules.has(ref))) continue;
    local.records.delete(name);
    local.unreadable.push(name);
  }
  return local;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reconcile Cloud with `.vendo/components/`: upload the blobs Cloud is missing,
 * put the records whose hash moved, delete records whose file is GONE, then
 * delete blobs nothing references. Never throws — a Cloud hiccup returns the
 * partial accounting plus `error`.
 */
export async function pushHostComponents(options: {
  vendoDir: string;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  budgetMs?: number;
}): Promise<HostComponentPushResult> {
  const local = await readLocal(options.vendoDir);
  const pushed: string[] = [];
  const pruned: string[] = [];
  const modules = { uploaded: 0, deleted: 0 };
  let uploadedBytes = 0;
  const budgetMs = options.budgetMs ?? RECONCILE_BUDGET_MS;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), budgetMs);
  timer.unref?.();
  const done = (error?: unknown): HostComponentPushResult => ({
    pushed,
    pruned,
    modules,
    uploadedBytes,
    unreadable: local.unreadable.sort(),
    ...(error === undefined ? {} : {
      error: budget.signal.aborted
        ? `the reconcile passed its ${budgetMs / 1000}s budget`
        : error instanceof Error ? error.message : "unknown error",
    }),
  });

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
    // The component index is one of Vendo's OWN drawers, so it rides the engine
    // family; the module bodies stay on the blob door, which is unchanged.
    const engine = store.ops.engine;
    const blobs = store.blobs(HOST_COMPONENTS_COLLECTION);

    // ONE keys-only call answers the whole "what do you already have?"
    // question for the heavy half — content addressing makes existence and
    // freshness the same fact.
    const remoteModules = new Set(await blobs.list());
    for (const [ref, body] of [...local.modules].sort(([left], [right]) => left.localeCompare(right))) {
      if (remoteModules.has(ref)) continue;
      // The encoded array is what actually crosses the wire, and sync reports
      // this total to the user as KB — `body.length` counts UTF-16 code units,
      // which undercounts every non-ASCII byte in the source.
      const encoded = new TextEncoder().encode(body);
      await blobs.put(ref, encoded, { contentType: "application/json" });
      modules.uploaded += 1;
      uploadedBytes += encoded.length;
    }

    const remote = new Map<string, unknown>();
    let cursor: string | undefined;
    do {
      const page = await engine.list(HOST_COMPONENTS_COLLECTION, { limit: RECORD_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
      for (const record of page.records) remote.set(record.id, record.data);
      if (page.cursor === undefined || page.cursor === cursor) break;
      cursor = page.cursor;
    } while (cursor !== undefined);

    for (const [name, record] of [...local.records].sort(([left], [right]) => left.localeCompare(right))) {
      const parsed = capturedHostComponentSchema.safeParse(remote.get(name));
      if (parsed.success && parsed.data.hash === record.hash) continue;
      await engine.put(HOST_COMPONENTS_COLLECTION, { id: name, data: record as unknown as Json });
      // `remote` tracks what Cloud HOLDS, so the blob keep-set below is
      // computed against the post-reconcile truth, not the pre-push snapshot.
      remote.set(name, record);
      pushed.push(name);
    }
    for (const name of [...remote.keys()].sort()) {
      // Presence on disk, not parseability: an unreadable file still means the
      // host registers this component, so its Cloud row stays.
      if (local.present.has(name)) continue;
      await engine.delete(HOST_COMPONENTS_COLLECTION, name);
      pruned.push(name);
      remote.delete(name);
    }

    // The blob keep-set is derived from the records that SURVIVE in Cloud, not
    // from what parsed locally. A corrupt or half-written local file keeps its
    // Cloud row (above) — so it must keep that row's blobs too, or the push
    // gets to say "left untouched" while gutting the bytes underneath, with no
    // self-heal: the hash still matches so nothing is ever re-put, and the
    // module is not in local.modules so nothing is ever re-uploaded. Cloud
    // would sit on records pointing at 404s. (This is the pin-baselines
    // presence-not-parseability lesson, applied to the blob half.)
    const keep = new Set<string>();
    let keepIsComplete = true;
    for (const [name, data] of remote) {
      // Prefer the LOCAL record: it is what Cloud holds after the put above,
      // and it is what the next retry will push if this one failed.
      const record = local.records.get(name) ?? capturedHostComponentSchema.safeParse(data).data;
      if (record === undefined) {
        // A kept row this CLI cannot read has unknowable refs — only reachable
        // when the local file is unreadable too, so there is nothing better to
        // consult. Guessing here deletes live bytes; skip the prune instead.
        keepIsComplete = false;
        break;
      }
      for (const ref of referencedRefs(record)) keep.add(ref);
    }
    if (keepIsComplete) {
      for (const ref of [...remoteModules].sort()) {
        if (keep.has(ref)) continue;
        await blobs.delete(ref);
        modules.deleted += 1;
      }
    }
    return done();
  } catch (error) {
    return done(error);
  } finally {
    clearTimeout(timer);
  }
}
