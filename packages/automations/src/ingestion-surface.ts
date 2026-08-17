/**
 * 07 §1's trigger ingestion, all three kinds: the schedule tick (and the timer
 * around it), the host's own product events, and the verified external
 * deliveries a webhook carries.
 *
 * Every one of them fires records this deployment owns. There is no
 * "some other authority fires this kind for us" mode any more: Vendo Cloud is a
 * dumb alarm clock that CALLS this tick, so the engine is always the thing that
 * decides what is due and always the thing that runs it.
 */
import { durationMs, webhookSubject, type AutomationRecord, type Json } from "@vendoai/core";
import { Cron } from "croner";
import { z } from "zod";
import type { AutomationRowsAccess } from "./automation-rows.js";
import type { EngineBase } from "./engine-context.js";
import type { AutomationsEngine } from "./index.js";
import { allRecords, automationRef, id, message } from "./rows.js";
import type { RunExecutionAccess } from "./run-execution.js";
import {
  DELIVERIES,
  SCHEDULE,
  WEBHOOK_MAX_BYTES,
  scheduleSchema,
  type FiredSchedule,
} from "./types.js";
import { readLimitedBody, signedWebhookBytes, verifySignature } from "./webhook-signature.js";

export type IngestionSurfaceDeps = {
  base: EngineBase;
  automations: AutomationRowsAccess;
  execution: RunExecutionAccess;
};

/** Schedules: the cursor claim, and the convenience timer around it. */
const createTickDoor = (deps: IngestionSurfaceDeps): Pick<AutomationsEngine, "tick" | "start"> => {
  const { base: { engine, now }, automations, execution } = deps;
  let tickTail: Promise<void> = Promise.resolve();
  const runTick: AutomationsEngine["tick"] = async (providedNow) => {
    const at = providedNow ?? now();
    const atIso = at.toISOString();
    // Indexed per-kind ref, never a scan of every record for every tick.
    const due = await automations.firingOn("schedule");
    const cursorRecords = due.length === 0
      ? []
      : await allRecords(engine, SCHEDULE, { ids: due.map((record) => record.id) });
    const cursorById = new Map(cursorRecords.map((record) => [record.id, record]));
    const fired: FiredSchedule[] = [];
    for (const record of due) {
      if (record.when.kind !== "schedule") continue;
      // Every write of this row restates the ref, including the compare-and-swap
      // replacement: a put that omitted it would strip the ref create wrote and
      // re-orphan the cursor on the very next tick.
      const cursorRow = (data: Json) => ({ id: record.id, data, refs: automationRef(record.id) });
      const cursorRecord = cursorById.get(record.id) ?? null;
      const cursor = cursorRecord === null
        ? { lastFiredAt: atIso }
        : scheduleSchema.parse(cursorRecord.data);
      const timezone = record.timezone ?? "UTC";
      let scheduledFor: string | undefined;
      if (record.when.cron !== undefined) {
        const next = new Cron(record.when.cron, { timezone, paused: true }).nextRun(new Date(cursor.lastFiredAt));
        if (next !== null && next.getTime() <= at.getTime()) scheduledFor = next.toISOString();
      } else if (record.when.every !== undefined) {
        const due = Date.parse(cursor.lastFiredAt) + (durationMs(record.when.every) as number);
        if (due <= at.getTime()) scheduledFor = new Date(due).toISOString();
      } else if (
        record.when.at !== undefined
        && cursor.firedAt === undefined
        && Date.parse(record.when.at) <= at.getTime()
      ) {
        scheduledFor = record.when.at;
      }
      if (scheduledFor === undefined) {
        if (cursorRecord === null) await engine.insertIfAbsent(SCHEDULE, cursorRow(cursor));
        continue;
      }
      const nextCursor = {
        ...cursor,
        lastFiredAt: atIso,
        ...(record.when.at === undefined ? {} : { firedAt: atIso }),
      };
      // THE claim, and the whole reason a duplicate tick fires nothing: two ticks
      // race for one cursor and exactly one of them wins the compare-and-swap.
      let claimed = true;
      if (cursorRecord === null) {
        claimed = await engine.insertIfAbsent(SCHEDULE, cursorRow(nextCursor)) !== null;
      } else if (cursorRecord.revision !== undefined) {
        claimed = await engine.compareAndSwap(SCHEDULE, cursorRow(nextCursor), cursorRecord.revision) !== null;
      } else {
        // The cursor exists but carries NO revision, so there is nothing to
        // compare against: an adapter without the optional atomic capability
        // issues none. Last write wins, which is what a store that cannot
        // linearize this can offer — one tick at a time is the norm.
        await engine.put(SCHEDULE, cursorRow(nextCursor));
      }
      if (claimed) fired.push({ record, scheduledFor, firedAt: atIso });
    }
    return await execution.runFiredSchedules(fired);
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
    // Never keep the host's event loop alive just for the scheduler — the same
    // rule the run-execution delay follows. Optional call: not every runtime's
    // timer handle carries unref.
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  };

  return { tick, start };
};

/** Host product events — THE host seam (vendo.emit). */
const createEmitDoor = (deps: IngestionSurfaceDeps): Pick<AutomationsEngine, "emit"> => {
  const { base: { config }, automations, execution } = deps;
  const emit: AutomationsEngine["emit"] = async (event, payload, principal) => {
    // Ruling 2026-08-01 — an event emitted by a MEMBER of the org fires that
    // org's automations. Matching only the emitter's own subject meant an
    // ORG-owned host-event automation could never be fired by anybody: its owner
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
    for (const subject of new Set([principal.subject, ...orgs])) {
      for (const record of await automations.firingOn("host-event", { subject })) {
        if (record.owner.subject !== subject) continue;
        if (record.when.kind !== "host-event" || record.when.event !== event) continue;
        ids.push(await execution.startRun(record, payload));
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
  { base: { config, iso } }: Pick<IngestionSurfaceDeps, "base">,
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

/** External events, mounted by the umbrella and forwarded here by Cloud's front
 *  door. */
const createWebhookDoor = (
  deps: IngestionSurfaceDeps & WebhookRefusals,
): Pick<AutomationsEngine, "webhook"> => {
  const { base: { engine, now, iso }, automations, execution, envelope, rejectWebhook } = deps;
  const inFlightDeliveries = new Set<string>();
  const webhook: AutomationsEngine["webhook"] = async (request) => {
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
    // Verified per RECORD: each external automation holds its own secret, so a
    // signature that verifies for one says nothing about another's.
    const verified: AutomationRecord[] = [];
    for (const record of await automations.firingOn("external")) {
      if (record.when.kind !== "external" || record.when.connector !== source) continue;
      if (record.webhookSecret === undefined) continue;
      for (const candidate of signatures) {
        if (await verifySignature(record.webhookSecret, candidate, signed)) {
          verified.push(record);
          break;
        }
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
    for (const record of verified) {
      // Dedupe per (automation, delivery): one delivery may legitimately fire two
      // records, and neither is a duplicate of the other.
      const deliveryKey = `${record.id}:${headerResult.data.id}`;
      if (inFlightDeliveries.has(deliveryKey)) {
        deduped += 1;
        continue;
      }
      inFlightDeliveries.add(deliveryKey);
      try {
        const delivery = {
          id: deliveryKey,
          data: { automationId: record.id, deliveryId: headerResult.data.id, receivedAt: iso() },
          refs: automationRef(record.id),
        };
        // Insert-ONCE: the delivery ledger is the only thing standing between a
        // redelivered webhook and a second run of the automation.
        if (await engine.insertIfAbsent(DELIVERIES, delivery) === null) {
          deduped += 1;
          continue;
        }
        ids.push(await execution.startRun(record, body));
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
