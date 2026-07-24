import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The demo registry — a single atomic JSON file (temp write + rename, the
 * caps-guard pattern from apps/demo-template/src/server/caps.ts) on a Railway
 * volume. One always-on router instance owns it, so plain synchronous fs is
 * both sufficient and race-free.
 *
 * File shape: { [id]: { url, prospect, expiresAt, killed, createdAt, hits } }.
 *
 * FAIL CLOSED: an unreadable/unparseable/wrong-shape file makes the public
 * path treat every id as unknown, admin operations throw
 * {@link RegistryCorruptError}, and the poisoned file is NEVER overwritten —
 * it stays on disk for inspection. The corruption is logged once.
 */

/** Same slug rule as demo.config.json ids: lowercase alphanumeric segments joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class RegistryCorruptError extends Error {
  constructor(filePath) {
    super(`registry file at "${filePath}" is corrupt — failing closed (file left untouched)`);
    this.name = "RegistryCorruptError";
  }
}

function isValidEntry(entry) {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof entry.url === "string" &&
    typeof entry.prospect === "string" &&
    typeof entry.expiresAt === "string" &&
    typeof entry.killed === "boolean" &&
    typeof entry.createdAt === "string" &&
    Number.isFinite(entry.hits)
  );
}

function isValidRegistryFile(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([id, entry]) => SLUG_PATTERN.test(id) && isValidEntry(entry));
}

export function createRegistry({
  filePath = process.env.REGISTRY_PATH ?? "/data/registry.json",
  log = (message) => console.error(message),
  now = () => new Date(),
  /** Pending hits that force a flush (public GETs must never write per request). */
  hitFlushThreshold = 50,
  /** Periodic flush of pending hits; the timer is unref'd so it never holds shutdown. */
  hitFlushIntervalMs = 30_000,
} = {}) {
  let warnedCorrupt = false;

  // Hit coalescing: redirects on the hot path only bump this in-memory map;
  // the file is written at most every `hitFlushThreshold` hits or
  // `hitFlushIntervalMs`. Deliberately lossy — a crash loses the buffer, and
  // that is fine for a best-effort usage counter.
  const pendingHits = new Map();
  let pendingHitCount = 0;
  let flushTimer;

  // Missing file => empty registry (deleting the file resets it).
  // Unreadable/unparseable/wrong shape => corrupt: fail closed, never write.
  function load() {
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { entries: {} };
      return corrupt();
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isValidRegistryFile(parsed)) return corrupt();
      return { entries: parsed };
    } catch {
      return corrupt();
    }
  }

  function corrupt() {
    if (!warnedCorrupt) {
      warnedCorrupt = true;
      log(`[registry] file at "${filePath}" is corrupt — failing closed until it is repaired or removed`);
    }
    return { corrupt: true };
  }

  // Atomic write: temp file + rename, so a crash mid-write can't corrupt the registry.
  function save(entries) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries, null, 2), "utf8");
    renameSync(temporary, filePath);
  }

  function loadForAdmin() {
    const state = load();
    if (state.corrupt) throw new RegistryCorruptError(filePath);
    return state.entries;
  }

  const withId = (id, entry) => ({ id, ...entry });

  /** WHATWG-normalize before storing: .href strips CR/LF/tab and canonicalizes,
   * so a Location header can never carry raw registry bytes. Throws on junk. */
  function normalizeUrl(url) {
    try {
      return new URL(url).href;
    } catch {
      throw new Error(`registry url must be a valid URL (received ${JSON.stringify(url)})`);
    }
  }

  function flushHits() {
    if (pendingHitCount === 0) return;
    // Lossy by design: the buffer is cleared whether or not the flush lands,
    // so a corrupt file or missing rows can't grow it without bound.
    const buffered = new Map(pendingHits);
    pendingHits.clear();
    pendingHitCount = 0;
    try {
      const state = load();
      if (state.corrupt) return;
      let dirty = false;
      for (const [id, count] of buffered) {
        if (state.entries[id] === undefined) continue; // row removed before the flush
        state.entries[id] = { ...state.entries[id], hits: state.entries[id].hits + count };
        dirty = true;
      }
      if (dirty) save(state.entries);
    } catch (error) {
      log(`[registry] failed to flush hit counters: ${error?.message ?? error}`);
    }
  }

  return {
    get(id) {
      const entries = loadForAdmin();
      return entries[id] === undefined ? undefined : withId(id, entries[id]);
    },

    list() {
      const entries = loadForAdmin();
      return Object.entries(entries).map(([id, entry]) => withId(id, entry));
    },

    count() {
      return Object.keys(loadForAdmin()).length;
    },

    /** Insert or replace a row. Preserves createdAt/hits across upserts of the same id. */
    upsert({ id, url, prospect, expiresAt, killed = false }) {
      if (typeof id !== "string" || !SLUG_PATTERN.test(id)) {
        throw new Error(`registry id must be slug-shaped (received ${JSON.stringify(id)})`);
      }
      const entries = loadForAdmin();
      const existing = entries[id];
      entries[id] = {
        url: normalizeUrl(url),
        prospect,
        expiresAt,
        killed,
        createdAt: existing?.createdAt ?? now().toISOString(),
        hits: existing?.hits ?? 0,
      };
      save(entries);
      return withId(id, entries[id]);
    },

    /** Merge partial fields into an existing row; undefined when the id is unknown. */
    patch(id, partial) {
      const entries = loadForAdmin();
      if (entries[id] === undefined) return undefined;
      const normalized = partial.url === undefined ? partial : { ...partial, url: normalizeUrl(partial.url) };
      entries[id] = { ...entries[id], ...normalized };
      save(entries);
      return withId(id, entries[id]);
    },

    remove(id) {
      const entries = loadForAdmin();
      if (entries[id] === undefined) return false;
      delete entries[id];
      save(entries);
      return true;
    },

    /**
     * The routing decision for one public request. Corrupt file => every id is
     * unknown (the public surface fails safe, never 500s). Kill wins over
     * expiry; an unparseable expiresAt counts as expired (fail closed).
     */
    routeFor(id, nowDate = now()) {
      const state = load();
      if (state.corrupt) return { kind: "unknown" };
      const entry = state.entries[id];
      if (entry === undefined) return { kind: "unknown" };
      if (entry.killed) return { kind: "killed" };
      const expiresAtMs = Date.parse(entry.expiresAt);
      if (Number.isNaN(expiresAtMs) || nowDate.getTime() >= expiresAtMs) return { kind: "expired" };
      return { kind: "live", url: entry.url };
    },

    /**
     * Best-effort hit counter — never throws, never blocks a redirect, and
     * never touches the file on the request path: hits coalesce in memory
     * and flush at the threshold or on the (unref'd) interval timer.
     */
    recordHit(id) {
      pendingHits.set(id, (pendingHits.get(id) ?? 0) + 1);
      pendingHitCount += 1;
      if (flushTimer === undefined) {
        flushTimer = setInterval(flushHits, hitFlushIntervalMs);
        flushTimer.unref?.();
      }
      if (pendingHitCount >= hitFlushThreshold) flushHits();
    },

    /** Force-persist the pending hit buffer (used by tests; the timer calls this too). */
    flushHits,
  };
}
