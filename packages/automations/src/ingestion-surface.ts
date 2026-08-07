/**
 * 07 §1's trigger ingestion, all three kinds: the schedule tick (and the timer
 * around it), the host's own product events, and the verified external
 * deliveries a connector webhook carries.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import { webhookSubject, type Json, type Trigger } from "@vendoai/core";
import { Cron } from "croner";
import { z } from "zod";
import type { AutomationsEngineContext } from "./engine-context.js";
import type { AutomationsEngine } from "./index.js";
import { allRecords, appRef, id, message, parseAppRow } from "./rows.js";
import { triggerKey } from "./sponsorship.js";
import { durationMs, validateTrigger } from "./steps.js";
import {
  APPS,
  DELIVERIES,
  SCHEDULE,
  WEBHOOK,
  WEBHOOK_MAX_BYTES,
  scheduleSchema,
  webhookSchema,
  type AppRow,
  type FiredSchedule,
} from "./types.js";
import { readLimitedBody, signedWebhookBytes, verifySignature } from "./webhook-signature.js";

export type IngestionSurfaceDeps = Pick<
  AutomationsEngineContext,
  | "config"
  | "now"
  | "iso"
  | "firesLocally"
  | "appsFiringOn"
  | "migratePreRekeyCursors"
  | "armedTriggers"
  | "armedFor"
  | "startRun"
  | "runFiredSchedules"
>;

/** Schedules: the cursor claim, and the convenience timer around it. */
const createTickDoor = (
  deps: Pick<
    IngestionSurfaceDeps,
    "config" | "now" | "firesLocally" | "appsFiringOn" | "migratePreRekeyCursors"
    | "armedTriggers" | "armedFor" | "runFiredSchedules"
  >,
): Pick<AutomationsEngine, "tick" | "start"> => {
  const { config, now, firesLocally, appsFiringOn, migratePreRekeyCursors } = deps;
  const { armedTriggers, armedFor, runFiredSchedules } = deps;
  let tickTail: Promise<void> = Promise.resolve();
  const runTick: AutomationsEngine["tick"] = async (providedNow) => {
    // Cloud (or whatever other authority) already fires schedule automations for this
    // deployment — firing them here too would double-run them. Nothing waits on a
    // decision any more, so a tick is only ever a firing path.
    if (!firesLocally("schedule")) return [];
    const at = providedNow ?? now();
    const atIso = at.toISOString();
    // Fetch only schedule-triggered apps (indexed per-kind ref) instead of scanning every
    // app for every subject, then batch every schedule cursor in one query (was an N+1 get).
    // Still ONE ref query with a trigger LIST: the ref says "this app has a schedule trigger
    // somewhere in its list", and the loop below picks out which ones.
    const appRecords = await appsFiringOn("schedule");
    const rows = appRecords.map(parseAppRow);
    const armed = await armedFor(rows);
    // Every armed schedule trigger, as (app, trigger) pairs — the unit that fires,
    // holds a cursor, and is claimed.
    const dueTriggers = rows.flatMap((row) => armedTriggers(row, armed)
      .filter((trigger) => trigger.on.kind === "schedule")
      .map((trigger) => ({ row, trigger })));
    const scheduleRecords = config.store.records(SCHEDULE);
    const cursorKeys = dueTriggers.map(({ row, trigger }) => triggerKey(row.doc.id, trigger.id));
    const cursorRecords = cursorKeys.length === 0
      ? []
      : await allRecords(scheduleRecords, { ids: cursorKeys });
    const cursorById = new Map(cursorRecords.map((record) => [record.id, record]));
    // A key that MISSED is either a schedule nobody has ever ticked or one whose
    // cursor predates the (app, trigger) rekey. The second is indistinguishable
    // from the first here, and reading it as the first restarts a running
    // automation's clock — so look for the old row before concluding anything.
    for (const record of await migratePreRekeyCursors(
      scheduleRecords,
      cursorKeys.filter((key) => !cursorById.has(key)),
    )) {
      cursorById.set(record.id, record);
    }
    const fired: FiredSchedule[] = [];
    for (const { row, trigger: declared } of dueTriggers) {
      const trigger = validateTrigger(declared);
      if (trigger.on.kind !== "schedule") continue;
      const cursorKey = triggerKey(row.doc.id, trigger.id);
      // Every write of this row restates the ref, including the compare-and-swap
      // replacement: a put that omitted it would strip the app ref the enable
      // wrote and re-orphan the cursor on the very next tick.
      const cursorRow = (data: Json) => ({ id: cursorKey, data, refs: appRef(row.doc.id) });
      const cursorRecord = cursorById.get(cursorKey) ?? null;
      const cursor = cursorRecord === null
        ? { lastFiredAt: at.toISOString() }
        : scheduleSchema.parse(cursorRecord.data);
      let scheduledFor: string | undefined;
      if (trigger.on.cron !== undefined) {
        const next = new Cron(trigger.on.cron, { timezone: "UTC", paused: true }).nextRun(new Date(cursor.lastFiredAt));
        if (next !== null && next.getTime() <= at.getTime()) scheduledFor = next.toISOString();
      } else if (trigger.on.every !== undefined) {
        const interval = durationMs(trigger.on.every) as number;
        const due = Date.parse(cursor.lastFiredAt) + interval;
        if (due <= at.getTime()) scheduledFor = new Date(due).toISOString();
      } else if (trigger.on.at !== undefined && cursor.firedAt === undefined && Date.parse(trigger.on.at) <= at.getTime()) {
        scheduledFor = trigger.on.at;
      }
      if (scheduledFor === undefined) {
        if (cursorRecord === null) {
          if (scheduleRecords.atomic === undefined) await scheduleRecords.put(cursorRow(cursor));
          else await scheduleRecords.atomic.insertIfAbsent(cursorRow(cursor));
        }
        continue;
      }
      const nextCursor = {
        ...cursor,
        lastFiredAt: at.toISOString(),
        ...(trigger.on.at === undefined ? {} : { firedAt: at.toISOString() }),
      };
      let claimed = true;
      if (cursorRecord === null) {
        if (scheduleRecords.atomic === undefined) await scheduleRecords.put(cursorRow(nextCursor));
        else claimed = await scheduleRecords.atomic.insertIfAbsent(cursorRow(nextCursor)) !== null;
      } else if (scheduleRecords.atomic !== undefined && cursorRecord.revision !== undefined) {
        claimed = await scheduleRecords.atomic.compareAndSwap(cursorRow(nextCursor), cursorRecord.revision) !== null;
      } else {
        await scheduleRecords.put(cursorRow(nextCursor));
      }
      if (!claimed) continue;
      fired.push({ row, trigger, scheduledFor, firedAt: atIso });
    }
    return await runFiredSchedules(fired);
  };

  const tick: AutomationsEngine["tick"] = (providedNow) => {
    const result = tickTail.then(() => runTick(providedNow));
    tickTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const start: AutomationsEngine["start"] = (intervalMs = 60_000) => {
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      // A failed tick must never surface as an unhandled rejection and crash the
      // host; the next interval retries.
      void tick().catch(() => undefined).finally(() => { ticking = false; });
    }, intervalMs);
    return () => clearInterval(timer);
  };

  return { tick, start };
};

/** Host product events — THE host seam (vendo.emit). */
const createEmitDoor = (
  deps: Pick<IngestionSurfaceDeps, "config" | "appsFiringOn" | "armedTriggers" | "armedFor" | "startRun">,
): Pick<AutomationsEngine, "emit"> => {
  const { config, appsFiringOn, armedTriggers, armedFor, startRun } = deps;
  const emit: AutomationsEngine["emit"] = async (event, payload, principal) => {
    // Ruling 2026-08-01 — an event emitted by a MEMBER of the org fires that
    // org's automations. Matching only the emitter's own subject meant an
    // ORG-owned host-event automation could never be fired by anybody: its row
    // subject is the org id (§9.5) and no principal is ever an org (§9.1 keeps
    // `kind:"org"` refused at the wire). The orgs are ASSERTED through the same
    // §9.1 seam an unattended fire uses, never stored.
    //
    // A broken directory must not take the person's OWN automations down with
    // it: the seam's failure is reported and their personal ones still fire.
    let orgs: string[] = [];
    try {
      orgs = [...new Set((await config.memberships?.(principal) ?? []).map(({ org }) => org))];
    } catch (error) {
      console.warn(
        `[vendo] could not resolve ${principal.subject}'s orgs for event "${event}" (${message(error)}); `
        + "any org-owned automation on this event did not fire — this subject's own automations did",
      );
    }
    const ids: string[] = [];
    // Indexed refs per owner (never a scan): the emitter, then each asserted org.
    for (const subject of [principal.subject, ...orgs]) {
      const records = await appsFiringOn("host-event", { subject });
      const rows = records.map(parseAppRow).filter((row) => row.subject === subject);
      const armed = await armedFor(rows);
      for (const row of rows) {
        // Every matching trigger fires, not just the first: an app may listen to
        // one event from two triggers, and they are two automations.
        for (const trigger of armedTriggers(row, armed)) {
          const source = trigger.on;
          // Membership is what makes the org's row reachable; whether this run may
          // proceed at all is the ordinary fire-time gate's call inside startRun
          // (active sponsorship + matching intent + the SPONSOR still can(editor)),
          // so an org automation nobody holds any more stops loudly instead of
          // running for whoever touched the event.
          if (source.kind === "host-event" && source.event === event) {
            ids.push(await startRun(row, trigger, "host-event", payload));
          }
        }
      }
    }
    return ids;
  };

  return { emit };
};

type WebhookRefusals = {
  envelope(status: number, code: string, text: string): Response;
  rejectWebhook(
    source: string,
    text: string,
    response?: { status: number; code: string },
  ): Promise<Response>;
};

/** How a delivery is turned away — with the audit row that says it was. */
const createWebhookRefusals = (
  { config, iso }: Pick<IngestionSurfaceDeps, "config" | "iso">,
): WebhookRefusals => {
  const envelope = (status: number, code: string, text: string): Response => Response.json(
    { error: { code, message: text } },
    { status },
  );

  const rejectWebhook = async (
    source: string,
    text: string,
    response: { status: number; code: string } = { status: 401, code: "blocked" },
  ): Promise<Response> => {
    await config.guard.report({
      id: id("aud_"),
      at: iso(),
      kind: "run",
      // Reserved namespace (block-actions design §C): runtime-minted webhook
      // principals live under `vendo:` so they can never collide with a
      // host-resolved subject.
      principal: { kind: "user", subject: webhookSubject(source) },
      venue: "automation",
      presence: "away",
      detail: { status: "webhook-rejected", reason: text },
    });
    return envelope(response.status, response.code, text);
  };

  return { envelope, rejectWebhook };
};

/** External events (Composio/webhooks), mounted by the umbrella. */
const createWebhookDoor = (
  deps: Pick<
    IngestionSurfaceDeps,
    "config" | "now" | "iso" | "firesLocally" | "armedTriggers" | "armedFor" | "startRun"
  > & WebhookRefusals,
): Pick<AutomationsEngine, "webhook"> => {
  const { config, now, iso, firesLocally, armedTriggers, armedFor, startRun } = deps;
  const { envelope, rejectWebhook } = deps;
  const inFlightDeliveries = new Set<string>();
  const webhook: AutomationsEngine["webhook"] = async (request) => {
    // Cloud (or whatever other authority) already delivers external events for this
    // deployment (Composio → Cloud) — launching a run here too would double-run it. No
    // verification, no audit: this is not a rejection, just a no-op the other authority
    // is already handling.
    if (!firesLocally("external")) return Response.json({ deferred: true }, { status: 200 });
    const source = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    const headerResult = z.object({
      id: z.string().min(1),
      timestamp: z.string().regex(/^\d+$/),
      signature: z.string().regex(/^v1,.+$/),
    }).safeParse({
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
    });
    if (!headerResult.success) return await rejectWebhook(source, "invalid webhook headers");
    const oversized = { status: 413, code: "validation" };
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > WEBHOOK_MAX_BYTES) {
      return await rejectWebhook(source, "webhook body exceeds 1 MiB", oversized);
    }
    const rawBytes = await readLimitedBody(request, WEBHOOK_MAX_BYTES);
    if (rawBytes === null) return await rejectWebhook(source, "webhook body exceeds 1 MiB", oversized);
    const timestampMs = Number(headerResult.data.timestamp) * 1_000;
    if (!Number.isSafeInteger(timestampMs) || Math.abs(now().getTime() - timestampMs) > 300_000) {
      return await rejectWebhook(source, "webhook timestamp is outside the allowed window");
    }
    // Standard-Webhooks senders may send several space-separated signatures
    // (key rotation): accept the delivery if ANY v1 candidate verifies.
    const signatures = headerResult.data.signature
      .split(/\s+/)
      .filter((entry) => entry.startsWith("v1,"))
      .map((entry) => entry.slice(3));
    const signed = signedWebhookBytes(headerResult.data.id, headerResult.data.timestamp, rawBytes);
    const appRecords = await allRecords(config.store.records(APPS));
    const rows = appRecords.map(parseAppRow);
    const armed = await armedFor(rows);
    // Verified per (app, TRIGGER): each external trigger holds its own secret, so
    // a signature that verifies for one says nothing about a sibling's.
    const verified: Array<{ row: AppRow; trigger: Trigger }> = [];
    for (const row of rows) {
      for (const trigger of armedTriggers(row, armed)) {
        if (trigger.on.kind !== "external" || trigger.on.connector !== source) continue;
        const secretRecord = await config.store.records(WEBHOOK).get(triggerKey(row.doc.id, trigger.id));
        if (secretRecord === null) continue;
        const secret = webhookSchema.safeParse(secretRecord.data);
        if (!secret.success) continue;
        let matched = false;
        for (const candidate of signatures) {
          if (await verifySignature(secret.data.secret, candidate, signed)) {
            matched = true;
            break;
          }
        }
        if (matched) verified.push({ row, trigger });
      }
    }
    if (verified.length === 0) return await rejectWebhook(source, "webhook signature verification failed");
    let body: Json;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBytes)) as Json;
    } catch {
      return envelope(400, "validation", "webhook body must be valid JSON");
    }
    const ids: string[] = [];
    let deduped = 0;
    for (const { row, trigger } of verified) {
      // Dedupe per (app, trigger, delivery): one delivery may legitimately fire
      // two of an app's triggers, and neither is a duplicate of the other.
      const deliveryKey = `${triggerKey(row.doc.id, trigger.id)}:${headerResult.data.id}`;
      if (inFlightDeliveries.has(deliveryKey)) {
        deduped += 1;
        continue;
      }
      inFlightDeliveries.add(deliveryKey);
      try {
        const deliveries = config.store.records(DELIVERIES);
        const delivery = {
          id: deliveryKey,
          data: {
            appId: row.doc.id,
            triggerId: trigger.id,
            deliveryId: headerResult.data.id,
            receivedAt: iso(),
          },
          refs: appRef(row.doc.id),
        };
        if (deliveries.atomic === undefined) {
          if (await deliveries.get(deliveryKey) !== null) {
            deduped += 1;
            continue;
          }
          await deliveries.put(delivery);
        } else if (await deliveries.atomic.insertIfAbsent(delivery) === null) {
          deduped += 1;
          continue;
        }
        ids.push(await startRun(row, trigger, "external", body));
      } finally {
        inFlightDeliveries.delete(deliveryKey);
      }
    }
    if (ids.length === 0 && deduped > 0) return Response.json({ deduped: true }, { status: 200 });
    return Response.json({ runIds: ids }, { status: 200 });
  };

  return { webhook };
};

export const createIngestionSurface = (
  deps: IngestionSurfaceDeps,
): Pick<AutomationsEngine, "tick" | "start" | "emit" | "webhook"> => ({
  ...createTickDoor(deps),
  ...createEmitDoor(deps),
  ...createWebhookDoor({ ...deps, ...createWebhookRefusals(deps) }),
});
