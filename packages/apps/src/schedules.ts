import {
  VendoError,
  type AppDocument,
  type AppId,
  type AuditEvent,
  type Json,
  type RunContext,
  type StoreAdapter,
  type ToolOutcome,
} from "@vendoai/core";
import { Cron } from "croner";
import { z } from "zod";
import type { MachineLifecycle } from "./machine-lifecycle.js";
import { parseVendoManifest } from "./manifest.js";
import { rowFromRecord } from "./persistence.js";

/**
 * execution-v2 Wave 2 Lane D — BYO schedule execution. Any external cron
 * (Vercel cron, GitHub Actions, crontab — or later the Cloud broker calling
 * the same surface) hits the host's authenticated tick; this engine reads each
 * machine-bearing app's `vendo.json` schedule declarations (Lane C's parser)
 * over the box door, computes due-ness against store-cached last-fired state,
 * wakes ONLY due machines, POSTs their declared `/fn/<name>` targets as the
 * app owner's away execution, and lets the normal idle policy put the box back
 * to sleep.
 *
 * The store cache is what keeps sleeping machines asleep: due-ness never
 * requires a wake. The accepted consequence is that a manifest edited while
 * the machine sleeps is not seen until the machine is next awake — the engine
 * re-reads `vendo.json` whenever the machine is awake at tick time (and on the
 * first tick after graduation, which wakes once to learn the schedules), and
 * {@link ScheduleEngine.syncManifest} is the explicit hook the Wave-3 in-box
 * agent calls at edit-complete.
 */

export const SCHEDULE_STATE_COLLECTION = "vendo_app_schedules";

/** Bounded catch-up: a schedule fires at most once per tick, at the LATEST
 *  missed occurrence — a host that slept through a window never replays it. */
const MAX_OCCURRENCE_SCAN = 10_000;
/** Bounded CAS retries before an app's claim reports a conflict. */
const CLAIM_ATTEMPTS = 3;

const decoder = new TextDecoder();

/** One declared schedule plus its execution state. `since` is the first time
 *  the host learned of this (cron, fn) declaration — the fire baseline until a
 *  first fire records `lastFiredAt` (schedules never back-fire history). */
export interface ScheduleState {
  cron: string;
  fn: string;
  since: string;
  lastFiredAt?: string;
  lastStatus?: "ok" | "error";
}

export interface AppScheduleState {
  syncedAt: string;
  schedules: ScheduleState[];
}

const scheduleStateSchema = z.object({
  syncedAt: z.string(),
  schedules: z.array(z.object({
    cron: z.string(),
    fn: z.string(),
    since: z.string(),
    lastFiredAt: z.string().optional(),
    lastStatus: z.enum(["ok", "error"]).optional(),
  })),
});

export interface ScheduleFire {
  appId: AppId;
  fn: string;
  cron: string;
  scheduledFor: string;
  status: "ok" | "error";
  message?: string;
}

export interface ScheduleTickReport {
  /** Machine-bearing apps considered this tick. */
  checked: number;
  fired: ScheduleFire[];
  errors: Array<{ appId: AppId; message: string }>;
}

/** The doctor's view of one machine-bearing app (reporting only). */
export interface AppScheduleStatus {
  appId: AppId;
  name: string;
  provisionedAt: string;
  awake: boolean;
  /** Undefined = the host has never read this box's vendo.json. */
  syncedAt?: string;
  schedules: ScheduleState[];
}

export interface ScheduleEngineConfig {
  store: StoreAdapter;
  lifecycle: MachineLifecycle;
  /** The v2 fn door (fn.ts): POST /fn/<name> with outcome containment. */
  callFn(app: AppDocument, name: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  /** Guard audit seam — every fire is reported as the owner's away execution. */
  audit?(event: AuditEvent): Promise<void>;
}

export interface ScheduleEngine {
  /**
   * Fire every due schedule once. Idempotent within a cron window: last-fired
   * state is claimed in the store BEFORE the fn POST, so a double-hit (two
   * cron services, a retrying runner) cannot double-fire. In-process
   * concurrent ticks coalesce onto the running one.
   */
  tick(at?: Date): Promise<ScheduleTickReport>;
  /** Wake the box, read vendo.json, and cache its schedules (Wave-3 edit hook). */
  syncManifest(app: AppDocument, at?: Date): Promise<AppScheduleState>;
  /** Remove an app's cached schedule state (delete / de-graduation hygiene). */
  clearForApp(appId: AppId): Promise<void>;
  /** Doctor reporting: machine-bearing apps with schedules and last-fired times. */
  report(): Promise<AppScheduleStatus[]>;
}

interface AppRow {
  id: AppId;
  subject: string;
  doc: AppDocument;
}

/** The latest occurrence of `cron` after `baseline` and at or before `at`. */
const latestDueOccurrence = (cron: string, baseline: string, at: Date): string | undefined => {
  const job = new Cron(cron, { timezone: "UTC", paused: true });
  let occurrence: Date | undefined;
  let from = new Date(baseline);
  for (let scanned = 0; scanned < MAX_OCCURRENCE_SCAN; scanned += 1) {
    const next = job.nextRun(from);
    if (next === null || next.getTime() > at.getTime()) break;
    occurrence = next;
    from = next;
  }
  return occurrence?.toISOString();
};

export const createScheduleEngine = (config: ScheduleEngineConfig): ScheduleEngine => {
  const states = config.store.records(SCHEDULE_STATE_COLLECTION);
  const apps = config.store.records("vendo_apps");
  let running: Promise<ScheduleTickReport> | undefined;

  const machineRows = async (): Promise<AppRow[]> => {
    const machineBearing: AppRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await apps.list(cursor === undefined ? {} : { cursor });
      for (const record of page.records) {
        let row;
        try {
          row = rowFromRecord(record);
        } catch {
          continue; // Corrupt rows cannot schedule, and must not break the tick.
        }
        if (row.doc.machine === undefined) continue;
        machineBearing.push({ id: record.id, subject: row.subject, doc: row.doc });
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return machineBearing;
  };

  /** State rows whose app lost its machine (or is gone) are ghost schedules —
   *  swept by listing the (small) state collection, never by probing every
   *  layer-1 app row. */
  const sweepStaleStates = async (machineBearing: ReadonlySet<AppId>): Promise<void> => {
    let cursor: string | undefined;
    const stale: AppId[] = [];
    do {
      const page = await states.list(cursor === undefined ? {} : { cursor });
      for (const record of page.records) {
        if (!machineBearing.has(record.id)) stale.push(record.id);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    for (const appId of stale) await states.delete(appId).catch(() => undefined);
  };

  const readState = async (appId: AppId): Promise<AppScheduleState | null> => {
    const record = await states.get(appId);
    if (record === null) return null;
    const parsed = scheduleStateSchema.safeParse(record.data);
    // Corrupt state re-syncs from the box rather than wedging the tick.
    return parsed.success ? parsed.data : null;
  };

  const writeState = async (appId: AppId, state: AppScheduleState): Promise<void> => {
    await states.put({ id: appId, data: state as unknown as Json });
  };

  const syncManifest = async (app: AppDocument, at = new Date()): Promise<AppScheduleState> => {
    const machine = await config.lifecycle.wake(app);
    const answer = await machine.request({ method: "GET", path: "/vendo.json" });
    let declared: Array<{ cron: string; fn: string }>;
    if (answer.status === 404) {
      // No manifest is a valid box: it just declares no schedules.
      declared = [];
    } else if (answer.status >= 200 && answer.status < 300) {
      declared = parseVendoManifest(decoder.decode(answer.body)).schedules ?? [];
    } else {
      throw new VendoError("validation", `vendo.json read failed (${answer.status})`, { appId: app.id });
    }
    const previous = await readState(app.id);
    const carried = new Map((previous?.schedules ?? []).map((schedule) => [`${schedule.cron}\n${schedule.fn}`, schedule]));
    const state: AppScheduleState = {
      syncedAt: at.toISOString(),
      schedules: declared.map(({ cron, fn }) => {
        const kept = carried.get(`${cron}\n${fn}`);
        return kept === undefined ? { cron, fn, since: at.toISOString() } : { ...kept };
      }),
    };
    await writeState(app.id, state);
    return state;
  };

  /** Claim the due occurrences in the store BEFORE firing (at-most-once): a
   *  racer re-reads and finds nothing due. CAS when the store supports it;
   *  read-then-put otherwise (the lifecycle's own degradation posture). */
  const claimDue = async (
    appId: AppId,
    at: Date,
  ): Promise<{ state: AppScheduleState; due: Array<{ cron: string; fn: string; scheduledFor: string }> } | { conflict: true } | null> => {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const record = await states.get(appId);
      if (record === null) return null;
      const parsed = scheduleStateSchema.safeParse(record.data);
      if (!parsed.success) return null;
      const state = parsed.data;
      const due: Array<{ cron: string; fn: string; scheduledFor: string }> = [];
      const next: AppScheduleState = {
        ...state,
        schedules: state.schedules.map((schedule) => {
          const scheduledFor = latestDueOccurrence(schedule.cron, schedule.lastFiredAt ?? schedule.since, at);
          if (scheduledFor === undefined) return schedule;
          due.push({ cron: schedule.cron, fn: schedule.fn, scheduledFor });
          return { ...schedule, lastFiredAt: scheduledFor };
        }),
      };
      if (due.length === 0) return { state, due };
      const input = { id: appId, data: next as unknown as Json };
      if (states.atomic === undefined || record.revision === undefined) {
        await states.put(input);
        return { state: next, due };
      }
      const swapped = await states.atomic.compareAndSwap(input, record.revision);
      if (swapped !== null) return { state: next, due };
    }
    return { conflict: true };
  };

  const recordOutcome = async (appId: AppId, fn: string, cron: string, status: "ok" | "error"): Promise<void> => {
    // Best-effort doctor detail; the claim already made the fire durable.
    const state = await readState(appId);
    if (state === null) return;
    await writeState(appId, {
      ...state,
      schedules: state.schedules.map((schedule) =>
        schedule.cron === cron && schedule.fn === fn ? { ...schedule, lastStatus: status } : schedule),
    }).catch(() => undefined);
  };

  const fireApp = async (row: AppRow, at: Date, report: ScheduleTickReport): Promise<void> => {
    let state = await readState(row.id);
    if (state === null) {
      // First tick after graduation: wake once to learn the schedules. Nothing
      // can be due yet — declarations only fire forward from their sync.
      state = await syncManifest(row.doc, at);
      return;
    }
    if (config.lifecycle.peek(row.id) !== undefined) {
      // The box is awake anyway — re-read vendo.json so schedule edits made
      // inside the box (agent sessions, layer-3 apps) are picked up.
      try {
        state = await syncManifest(row.doc, at);
      } catch (error) {
        report.errors.push({ appId: row.id, message: error instanceof Error ? error.message : "manifest refresh failed" });
      }
    }
    const claimed = await claimDue(row.id, at);
    if (claimed === null) return;
    if ("conflict" in claimed) {
      report.errors.push({ appId: row.id, message: "schedule state was concurrently modified" });
      return;
    }
    for (const { cron, fn, scheduledFor } of claimed.due) {
      // The app's owner, away, in the app venue — the same authority a tree
      // action carries when the owner isn't looking; box callbacks during the
      // run ride the app token through the existing guard seams.
      const ctx: RunContext = {
        principal: { kind: "user", subject: row.subject },
        venue: "app",
        presence: "away",
        sessionId: `schedule_${row.id}`,
        appId: row.id,
      };
      const outcome = await config.callFn(row.doc, fn, {}, ctx);
      const status = outcome.status === "ok" ? "ok" : "error";
      report.fired.push({
        appId: row.id,
        fn,
        cron,
        scheduledFor,
        status,
        ...(outcome.status === "error" ? { message: outcome.error.message } : {}),
      });
      await recordOutcome(row.id, fn, cron, status);
      await config.audit?.({
        id: `aud_${globalThis.crypto.randomUUID()}`,
        at: new Date().toISOString(),
        kind: "app-lifecycle",
        principal: { kind: "user", subject: row.subject },
        venue: "app",
        presence: "away",
        appId: row.id,
        outcome: outcome.status,
        detail: { operation: "schedule-fire", fn, cron, scheduledFor },
      });
    }
  };

  const runTick = async (at: Date): Promise<ScheduleTickReport> => {
    const report: ScheduleTickReport = { checked: 0, fired: [], errors: [] };
    const machineBearing = await machineRows();
    await sweepStaleStates(new Set(machineBearing.map((row) => row.id)));
    for (const row of machineBearing) {
      report.checked += 1;
      try {
        await fireApp(row, at, report);
      } catch (error) {
        report.errors.push({ appId: row.id, message: error instanceof Error ? error.message : "schedule tick failed" });
      }
    }
    return report;
  };

  return {
    tick(at = new Date()) {
      const inflight = running;
      if (inflight !== undefined) return inflight;
      const run = runTick(at).finally(() => {
        running = undefined;
      });
      running = run;
      return run;
    },
    syncManifest,
    async clearForApp(appId) {
      await states.delete(appId).catch(() => undefined);
    },
    async report() {
      const machineBearing = await machineRows();
      const statuses: AppScheduleStatus[] = [];
      for (const row of machineBearing) {
        const state = await readState(row.id);
        statuses.push({
          appId: row.id,
          name: row.doc.name,
          provisionedAt: row.doc.machine?.provisionedAt ?? "",
          awake: config.lifecycle.peek(row.id) !== undefined,
          ...(state === null ? {} : { syncedAt: state.syncedAt }),
          schedules: state?.schedules ?? [],
        });
      }
      return statuses;
    },
  };
};
