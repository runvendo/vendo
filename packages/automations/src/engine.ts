import {
  VendoError,
  approvalRequestSchema,
  appDocumentSchema,
  descriptorHash,
  permissionGrantSchema,
  triggerSchema,
  type AppDocument,
  type ApprovalRequest,
  type AuditEvent,
  type Json,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type RunId,
  type Step,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type Trigger,
  type TriggerSource,
  type VendoRecord,
} from "@vendoai/core";
import { Cron } from "croner";
import jsonata from "jsonata";
import { z } from "zod";
import type {
  AutomationsConfig,
  AutomationsEngine,
  RunPlan,
  RunRecord,
  RunStatus,
} from "./index.js";

const APPS = "vendo_apps";
const RUNS = "vendo_runs";
/** runs.list page size — the store's own default (100) is its escape hatch, not a UX. */
const RUNS_PAGE_LIMIT = 50;
const GRANTS = "vendo_grants";
const APPROVALS = "vendo_approvals";
const CAPTURES = "automations:captures";
const PARKED = "automations:parked";
const RESUME_CLAIMS = "automations:resume-claims";
const SCHEDULE = "automations:schedule";
const WEBHOOK = "automations:webhook";
const DELIVERIES = "automations:deliveries";
const WEBHOOK_MAX_BYTES = 1024 * 1024;
const RESUME_MAX_BYTES = 512 * 1024;
const FOREACH_MAX_ITEMS = 1000;

const appRowSchema = z.object({
  subject: z.string(),
  enabled: z.boolean(),
  doc: appDocumentSchema,
});

const approvalRowSchema = z.object({
  request: approvalRequestSchema,
  status: z.enum(["pending", "approved", "denied"]),
  sessionId: z.string().optional(),
  decidedAt: z.string().optional(),
  consumedAt: z.string().optional(),
});

const captureSchema = z.object({
  appId: z.string(),
  subject: z.string(),
  tool: z.string(),
  descriptorHash: z.string(),
});

const parkedSchema = z.object({ runId: z.string() });
const scheduleSchema = z.object({ lastFiredAt: z.string(), firedAt: z.string().optional() });
const webhookSchema = z.object({ secret: z.string() });

interface AppRow {
  subject: string;
  enabled: boolean;
  doc: AppDocument;
}

interface ResumeState {
  stepIndex: number;
  forEachIndex?: number;
  event: Json;
  stepOutputs: Record<string, Json>;
  call: ToolCall;
  approvalId: string;
  iterationItems?: Json[];
  iterationOutputs?: Json[];
  claimedBy?: string;
}

interface InternalRunRecord extends RunRecord {
  __resume?: ResumeState;
}

const resumeSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  forEachIndex: z.number().int().nonnegative().optional(),
  event: z.unknown(),
  stepOutputs: z.record(z.unknown()),
  call: z.object({ id: z.string(), tool: z.string(), args: z.unknown() }),
  approvalId: z.string(),
  iterationItems: z.array(z.unknown()).optional(),
  iterationOutputs: z.array(z.unknown()).optional(),
  claimedBy: z.string().optional(),
});

const baseRunRecordSchema = z.object({
  id: z.string(),
  appId: z.string(),
  trigger: z.object({
    kind: z.enum(["schedule", "host-event", "external"]),
    event: z.string().optional(),
  }),
  status: z.enum(["running", "ok", "error", "stopped", "pending-approval"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  steps: z.array(z.object({
    id: z.string(),
    tool: z.string(),
    outcome: z.enum(["ok", "error", "pending-approval", "blocked"]),
    at: z.string(),
    detail: z.string().optional(),
  })),
  summary: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const internalRunRecordSchema = baseRunRecordSchema.extend({ __resume: resumeSchema.optional() });

interface RunRowData {
  appId: string;
  trigger: RunRecord["trigger"];
  status: RunStatus;
  record: InternalRunRecord;
  startedAt: string;
  finishedAt?: string;
}

const runRowDataSchema = z.object({
  appId: z.string(),
  trigger: z.object({
    kind: z.enum(["schedule", "host-event", "external"]),
    event: z.string().optional(),
  }),
  status: z.enum(["running", "ok", "error", "stopped", "pending-approval"]),
  record: internalRunRecordSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

const clone = <T>(value: T): T => globalThis.structuredClone(value);
const id = (prefix: string): string => `${prefix}${globalThis.crypto.randomUUID()}`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const allRecords = async (
  records: ReturnType<AutomationsConfig["store"]["records"]>,
  query: { refs?: Record<string, string>; ids?: string[] } = {},
): Promise<VendoRecord[]> => {
  const found: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await records.list({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

const parseAppRow = (record: VendoRecord): AppRow => {
  const result = appRowSchema.safeParse(record.data);
  if (!result.success) throw new VendoError("validation", `invalid app row ${record.id}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
};

const parseRunRow = (record: VendoRecord): RunRowData => {
  const result = runRowDataSchema.safeParse(record.data);
  if (!result.success) throw new VendoError("validation", `invalid run row ${record.id}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data as unknown as RunRowData;
};

const publicRun = (record: InternalRunRecord): RunRecord => {
  const result = baseRunRecordSchema.safeParse(record);
  if (!result.success) throw new VendoError("validation", `invalid run record: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
};

const triggerEvent = (source: TriggerSource): string | undefined =>
  source.kind === "host-event" || source.kind === "external" ? source.event : undefined;

const triggerRef = (trigger: Trigger): RunRecord["trigger"] => ({
  kind: trigger.on.kind,
  ...(triggerEvent(trigger.on) === undefined ? {} : { event: triggerEvent(trigger.on) }),
});

const durationMs = (value: string): number | null => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null) return null;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return count * units[match[2] as keyof typeof units];
};

const validateTrigger = (value: unknown): Trigger => {
  const parsed = triggerSchema.safeParse(value);
  if (!parsed.success) throw new VendoError("validation", parsed.error.issues[0]?.message ?? "invalid trigger");
  const trigger = parsed.data;
  if (trigger.on.kind === "schedule") {
    if (trigger.on.every !== undefined && durationMs(trigger.on.every) === null) {
      throw new VendoError("validation", "schedule every must match <n><s|m|h|d> with n > 0");
    }
    if (trigger.on.cron !== undefined) {
      if (trigger.on.cron.trim().split(/\s+/).length !== 5) {
        throw new VendoError("validation", "schedule cron must contain exactly 5 fields");
      }
      try {
        new Cron(trigger.on.cron, { timezone: "UTC", paused: true });
      } catch (error) {
        throw new VendoError("validation", `invalid schedule cron: ${message(error)}`);
      }
    }
    if (trigger.on.at !== undefined && !Number.isFinite(Date.parse(trigger.on.at))) {
      throw new VendoError("validation", "schedule at must be an ISO date-time");
    }
  }
  return trigger;
};

const evaluate = async (expression: string, input: Record<string, Json>): Promise<Json> =>
  await jsonata(expression).evaluate(input) as Json;

const stepArgs = async (
  step: Step,
  event: Json,
  outputs: Record<string, Json>,
  item?: Json,
): Promise<Record<string, Json>> => {
  const context = { event, steps: outputs, item };
  const args: Record<string, Json> = {};
  for (const [key, expression] of Object.entries(step.args ?? {})) {
    args[key] = await evaluate(expression, context);
  }
  return args;
};

const outcomeDetail = (outcome: ToolOutcome): string | undefined => {
  if (outcome.status === "error") return outcome.error.message;
  if (outcome.status === "blocked") return outcome.reason;
  if (outcome.status === "pending-approval") return outcome.approvalId;
  if (outcome.status === "connect-required") return outcome.connect.message;
  return undefined;
};

const errorForOutcome = (outcome: Exclude<ToolOutcome, { status: "ok" }>): { code: string; message: string } => {
  if (outcome.status === "error") return outcome.error;
  if (outcome.status === "blocked") return { code: "blocked", message: outcome.reason };
  // An away run has no user to show a connect card to; the run fails with an
  // actionable message and the user connects in-product before re-running.
  if (outcome.status === "connect-required") return { code: "connect-required", message: outcome.connect.message };
  return { code: "blocked", message: `approval required: ${outcome.approvalId}` };
};

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
};

const decodeBase64 = (value: string, url = false): Uint8Array | null => {
  try {
    let normalized = url ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
    normalized += "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const verifySignature = async (
  secret: string,
  signature: string,
  signed: Uint8Array,
): Promise<boolean> => {
  const keyBytes = decodeBase64(secret, true);
  const signatureBytes = decodeBase64(signature);
  if (keyBytes === null || signatureBytes === null) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      signed,
    );
  } catch {
    return false;
  }
};

const signedWebhookBytes = (deliveryId: string, timestamp: string, raw: Uint8Array): Uint8Array => {
  const prefix = new TextEncoder().encode(`${deliveryId}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  return signed;
};

const readLimitedBody = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const terminalStatus = (status: RunStatus): status is Extract<RunStatus, "ok" | "error" | "stopped"> =>
  status === "ok" || status === "error" || status === "stopped";

const syncRun = (target: InternalRunRecord, source: InternalRunRecord): void => {
  delete target.__resume;
  delete target.finishedAt;
  delete target.summary;
  delete target.error;
  Object.assign(target, clone(source));
};

const validateForEachItems = (step: Step, value: Json): Json[] => {
  if (!Array.isArray(value)) throw new Error(`step ${step.id} forEach did not produce an array`);
  if (value.length > FOREACH_MAX_ITEMS) throw new Error(`step ${step.id} forEach exceeds ${FOREACH_MAX_ITEMS} items`);
  return value;
};

export const createAutomationsEngine = (config: AutomationsConfig): AutomationsEngine => {
  const now = (): Date => config.now?.() ?? new Date();
  const iso = (): string => now().toISOString();
  const stopped = new Set<string>();
  const active = new Set<string>();
  const resuming = new Set<string>();
  const inFlightDeliveries = new Set<string>();
  const abortControllers = new Map<string, AbortController>();
  const engineInstanceId = globalThis.crypto.randomUUID();
  let tickTail: Promise<void> = Promise.resolve();

  const appRecord = async (appId: string): Promise<{ record: VendoRecord; row: AppRow } | null> => {
    const record = await config.store.records(APPS).get(appId);
    return record === null ? null : { record, row: parseAppRow(record) };
  };

  const ownedApp = async (appId: string, subject: string): Promise<{ record: VendoRecord; row: AppRow }> => {
    const found = await appRecord(appId);
    if (found === null || found.row.subject !== subject) throw new VendoError("not-found", `app not found: ${appId}`);
    return found;
  };

  const writeApp = async (record: VendoRecord, row: AppRow): Promise<void> => {
    // trigger_kind lets the tick/emit fetch apps by trigger kind (the reserved store derives it
    // from a column and ignores caller refs; a generic StoreAdapter honors what we pass here).
    await config.store.records(APPS).put({
      id: record.id,
      data: row,
      refs: {
        subject: row.subject,
        ...(row.doc.trigger === undefined ? {} : { trigger_kind: row.doc.trigger.on.kind }),
      },
    });
  };

  const descriptors = async (): Promise<Map<string, ToolDescriptor>> =>
    new Map((await config.tools.descriptors()).map((descriptor) => [descriptor.name, descriptor]));

  const liveGrant = async (
    subject: string,
    appId: string,
    descriptor: ToolDescriptor,
  ): Promise<boolean> => {
    const records = await allRecords(config.store.records(GRANTS), {
      refs: { subject, tool: descriptor.name, app_id: appId },
    });
    const at = now().getTime();
    return records.some((record) => {
      const parsed = permissionGrantSchema.safeParse(record.data);
      if (!parsed.success) return false;
      const grant = parsed.data;
      return grant.subject === subject
        && grant.tool === descriptor.name
        && grant.descriptorHash === descriptorHash(descriptor)
        && grant.appId === appId
        && grant.source === "automation"
        && grant.duration === "standing"
        && grant.scope.kind === "tool"
        && grant.revokedAt === undefined
        && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > at);
    });
  };

  const audit = async (ctx: RunContext, status: string, extra: Record<string, Json> = {}): Promise<void> => {
    const event: AuditEvent = {
      id: id("aud_"),
      at: iso(),
      kind: "run",
      principal: ctx.principal,
      venue: "automation",
      presence: "away",
      ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
      ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
      detail: { status, ...extra },
    };
    await config.guard.report(event);
  };

  const writeRun = async (record: InternalRunRecord): Promise<boolean> => {
    const stored = await config.store.records(RUNS).get(record.id);
    if (stored !== null) {
      const current = parseRunRow(stored).record;
      if (terminalStatus(current.status)) {
        syncRun(record, current);
        return false;
      }
    }
    await config.store.records(RUNS).put({
      id: record.id,
      data: {
        appId: record.appId,
        trigger: record.trigger,
        status: record.status,
        record,
        startedAt: record.startedAt,
        ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      },
      refs: { app_id: record.appId, status: record.status },
    });
    return true;
  };

  const runContext = (run: InternalRunRecord, subject: string): RunContext => ({
    principal: { kind: "user", subject },
    venue: "automation",
    presence: "away",
    sessionId: `sess_${run.id}`,
    appId: run.appId,
    trigger: { runId: run.id, kind: run.trigger.kind },
  });

  const terminal = async (
    run: InternalRunRecord,
    ctx: RunContext,
    status: Extract<RunStatus, "ok" | "error" | "stopped">,
    summary: string,
    error?: { code: string; message: string },
  ): Promise<void> => {
    delete run.__resume;
    run.status = status;
    run.finishedAt = iso();
    run.summary = summary;
    if (error === undefined) delete run.error;
    else run.error = error;
    if (await writeRun(run)) await audit(ctx, status);
  };

  const park = async (
    run: InternalRunRecord,
    ctx: RunContext,
    state: ResumeState,
  ): Promise<void> => {
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > RESUME_MAX_BYTES) {
      await terminal(
        run,
        ctx,
        "error",
        `stopped at ${run.steps.at(-1)?.id ?? "step"}: persisted resume state exceeds 512 KiB`,
        { code: "validation", message: "persisted resume state exceeds 512 KiB" },
      );
      return;
    }
    run.status = "pending-approval";
    run.summary = `stopped at ${run.steps.at(-1)?.id ?? "step"}: approval required`;
    run.__resume = clone(state);
    if (!await writeRun(run)) return;
    await config.store.records(PARKED).put({ id: state.approvalId, data: { runId: run.id } });
    await audit(ctx, "pending-approval");
  };

  const appendOutcome = (run: InternalRunRecord, step: Step, outcome: ToolOutcome): void => {
    run.steps.push({
      id: step.id,
      tool: step.tool,
      outcome: outcome.status,
      at: iso(),
      ...(outcomeDetail(outcome) === undefined ? {} : { detail: outcomeDetail(outcome) }),
    });
  };

  const executeCall = async (
    appId: string,
    step: Step,
    call: ToolCall,
    ctx: RunContext,
  ): Promise<ToolOutcome> => step.tool.startsWith("fn:")
    ? await config.apps.call(appId, step.tool, call.args, ctx)
    : await config.tools.execute(call, ctx);

  const finishStoppedIfNeeded = async (run: InternalRunRecord, _ctx: RunContext): Promise<boolean> => {
    if (stopped.has(run.id)) {
      // runs.stop persisted and audited the authoritative stopped row; this is a stale in-flight copy.
      run.status = "stopped";
      return true;
    }
    const stored = await config.store.records(RUNS).get(run.id);
    if (stored !== null) {
      const current = parseRunRow(stored).record;
      if (terminalStatus(current.status)) {
        syncRun(run, current);
        return true;
      }
    }
    if (terminalStatus(run.status)) return true;
    return false;
  };

  const continueSteps = async (
    app: AppRow,
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    state: {
      stepIndex: number;
      event: Json;
      stepOutputs: Record<string, Json>;
      iterationItems?: Json[];
      iterationOutputs?: Json[];
      forEachIndex?: number;
    },
  ): Promise<void> => {
    if (trigger.run.kind !== "steps") throw new VendoError("validation", "steps run expected");
    const steps = trigger.run.steps;
    for (let stepIndex = state.stepIndex; stepIndex < steps.length; stepIndex += 1) {
      if (await finishStoppedIfNeeded(run, ctx)) return;
      const step = steps[stepIndex] as Step;
      let items: Json[] | undefined = stepIndex === state.stepIndex ? state.iterationItems : undefined;
      let outputs: Json[] = stepIndex === state.stepIndex ? state.iterationOutputs ?? [] : [];
      let iterationStart = stepIndex === state.stepIndex ? state.forEachIndex ?? 0 : 0;
      try {
        if (items === undefined) {
          if (step.if !== undefined && !await evaluate(step.if, { event: state.event, steps: state.stepOutputs, item: undefined })) {
            continue;
          }
          if (step.forEach !== undefined) {
            const evaluated = await evaluate(step.forEach, { event: state.event, steps: state.stepOutputs, item: undefined });
            items = validateForEachItems(step, evaluated);
          }
        }
      } catch (error) {
        const failed: ToolOutcome = { status: "error", error: { code: "validation", message: message(error) } };
        appendOutcome(run, step, failed);
        await terminal(run, ctx, "error", `stopped at ${step.id}: ${message(error)}`, failed.error);
        return;
      }

      const iterations: Array<{ item?: Json; index?: number }> = items === undefined
        ? [{}]
        : items.map((item, index) => ({ item, index }));
      for (let index = iterationStart; index < iterations.length; index += 1) {
        if (await finishStoppedIfNeeded(run, ctx)) return;
        const iteration = iterations[index] as { item?: Json; index?: number };
        let args: Record<string, Json>;
        try {
          args = await stepArgs(step, state.event, state.stepOutputs, iteration.item);
        } catch (error) {
          const failed: ToolOutcome = { status: "error", error: { code: "validation", message: message(error) } };
          appendOutcome(run, step, failed);
          await terminal(run, ctx, "error", `stopped at ${step.id}: ${message(error)}`, failed.error);
          return;
        }
        const call: ToolCall = { id: id("call_"), tool: step.tool, args };
        const outcome = await executeCall(app.doc.id, step, call, ctx);
        if (await finishStoppedIfNeeded(run, ctx)) return;
        appendOutcome(run, step, outcome);
        if (outcome.status === "pending-approval") {
          await park(run, ctx, {
            stepIndex,
            ...(items === undefined ? {} : { forEachIndex: index, iterationItems: items, iterationOutputs: outputs }),
            event: state.event,
            stepOutputs: state.stepOutputs,
            call,
            approvalId: outcome.approvalId,
          });
          return;
        }
        if (outcome.status !== "ok") {
          const error = errorForOutcome(outcome);
          await terminal(run, ctx, "error", `stopped at ${step.id}: ${error.message}`, error);
          return;
        }
        if (items === undefined) state.stepOutputs[step.id] = outcome.output;
        else outputs.push(outcome.output);
      }
      if (items !== undefined) state.stepOutputs[step.id] = outputs;
      state.iterationItems = undefined;
      state.iterationOutputs = undefined;
      state.forEachIndex = undefined;
    }
    const okCount = run.steps.filter((entry) => entry.outcome === "ok").length;
    await terminal(run, ctx, "ok", `${okCount} ${okCount === 1 ? "step" : "steps"} ok`);
  };

  const runAgentic = async (
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    abortSignal: AbortSignal,
  ): Promise<void> => {
    if (trigger.run.kind !== "agentic") throw new VendoError("validation", "agentic run expected");
    if (config.runner === undefined) {
      await terminal(
        run,
        ctx,
        "error",
        "agentic runs unavailable",
        { code: "not-implemented", message: "agentic runs unavailable" },
      );
      return;
    }
    try {
      const report = await config.runner({
        prompt: trigger.run.prompt,
        tools: config.tools,
        budget: { maxToolCalls: trigger.run.budget?.maxToolCalls ?? 50 },
        abortSignal,
      }, ctx);
      // Cross-instance stops cannot reach this process's controller, so the persisted
      // terminal-row check remains the best-effort fallback for a late result.
      if (await finishStoppedIfNeeded(run, ctx)) return;
      run.steps = report.toolCalls.map(({ call, outcome }) => ({
        id: call.id,
        tool: call.tool,
        outcome,
        at: iso(),
      }));
      await terminal(run, ctx, report.status, report.summary);
    } catch (error) {
      if (await finishStoppedIfNeeded(run, ctx)) return;
      await terminal(run, ctx, "error", message(error), { code: "not-implemented", message: message(error) });
    }
  };

  // Mint the run and its record synchronously (so the id is known immediately), then
  // execute the whole automation on the returned `done` promise. Splitting the id from the
  // completion lets the tick collect runIds without blocking on each run to finish, and lets
  // it bound how long it waits on any single run (see runFiredSchedules).
  const launchRun = (app: AppRow, kind: TriggerSource["kind"], event: Json): { runId: RunId; done: Promise<void> } => {
    const trigger = validateTrigger(app.doc.trigger);
    const runId = id("run_");
    const startedAt = iso();
    const record: InternalRunRecord = {
      id: runId,
      appId: app.doc.id,
      trigger: {
        kind,
        ...(triggerEvent(trigger.on) === undefined ? {} : { event: triggerEvent(trigger.on) }),
      },
      status: "running",
      startedAt,
      steps: [],
    };
    const ctx = runContext(record, app.subject);
    const agentController = trigger.run.kind === "agentic" ? new AbortController() : undefined;
    if (agentController !== undefined) abortControllers.set(runId, agentController);
    const done = (async (): Promise<void> => {
      try {
        await writeRun(record);
        await audit(ctx, "running");
        active.add(runId);
        try {
          if (trigger.run.kind === "steps") {
            await continueSteps(app, trigger, record, ctx, { stepIndex: 0, event, stepOutputs: {} });
          } else {
            await runAgentic(trigger, record, ctx, agentController!.signal);
          }
        } finally {
          active.delete(runId);
          stopped.delete(runId);
        }
      } finally {
        if (agentController !== undefined) abortControllers.delete(runId);
      }
    })();
    return { runId, done };
  };

  const startRun = async (app: AppRow, kind: TriggerSource["kind"], event: Json): Promise<RunId> => {
    const { runId, done } = launchRun(app, kind, event);
    await done;
    return runId;
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the event loop alive just for the tick's timeout.
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  // Execute fired automations with bounded parallelism and an optional per-run timeout, so
  // one hung/slow run cannot block other tenants or overrun the tick interval. All runIds are
  // returned regardless of whether their run finished within the timeout (a timed-out run keeps
  // running detached and persists its own terminal state).
  const runFiredSchedules = async (
    fired: Array<{ row: AppRow; scheduledFor: string; firedAt: string }>,
  ): Promise<RunId[]> => {
    const concurrency = Math.max(1, Math.floor(config.tickConcurrency ?? 4));
    const timeoutMs = config.runTimeoutMs;
    const ids: Array<RunId | undefined> = new Array(fired.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= fired.length) return;
        const entry = fired[index] as { row: AppRow; scheduledFor: string; firedAt: string };
        let launched: { runId: RunId; done: Promise<void> };
        try {
          launched = launchRun(entry.row, "schedule", { scheduledFor: entry.scheduledFor, firedAt: entry.firedAt });
        } catch {
          // A run that cannot even start (e.g. an invalid trigger) is skipped so other
          // tenants' fired runs still proceed.
          continue;
        }
        ids[index] = launched.runId;
        // A detached (timed-out) run must never surface as an unhandled rejection.
        const settled = launched.done.catch(() => undefined);
        if (timeoutMs === undefined) await settled;
        else await Promise.race([settled, delay(timeoutMs)]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, fired.length) }, () => worker()),
    );
    return ids.filter((value): value is RunId => value !== undefined);
  };

  const mintGrant = async (request: ApprovalRequest): Promise<void> => {
    const grant: PermissionGrant = {
      id: id("grt_"),
      subject: request.ctx.principal.subject,
      tool: request.call.tool,
      descriptorHash: descriptorHash(request.descriptor),
      scope: { kind: "tool" },
      duration: "standing",
      ...(request.ctx.appId === undefined ? {} : { appId: request.ctx.appId }),
      source: "automation",
      grantedAt: iso(),
    };
    await config.store.records(GRANTS).put({
      id: grant.id,
      data: grant,
      refs: {
        subject: grant.subject,
        tool: grant.tool,
        ...(grant.appId === undefined ? {} : { app_id: grant.appId }),
      },
    });
  };

  const markConsumed = async (record: VendoRecord): Promise<void> => {
    const data = approvalRowSchema.parse(record.data);
    await config.store.records(APPROVALS).put({
      id: record.id,
      data: { ...data, consumedAt: iso() },
    });
  };

  const resumeRun = async (approvalId: string, approved: boolean): Promise<void> => {
    const parkedRecord = await config.store.records(PARKED).get(approvalId);
    if (parkedRecord === null) return;
    const { runId } = parkedSchema.parse(parkedRecord.data);
    if (resuming.has(runId)) return;
    resuming.add(runId);
    try {
      const stored = await config.store.records(RUNS).get(runId);
      if (stored === null) {
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      const run = parseRunRow(stored).record;
      if (run.status !== "pending-approval" || run.__resume?.approvalId !== approvalId) {
        if (run.status === "running" && run.__resume?.approvalId === approvalId && run.__resume.claimedBy !== undefined) {
          return;
        }
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      const approval = await config.store.records(APPROVALS).get(approvalId);
      if (approval === null) return;
      const approvalData = approvalRowSchema.parse(approval.data);

      const claimedBy = `${engineInstanceId}:${globalThis.crypto.randomUUID()}`;
      const claims = config.store.records(RESUME_CLAIMS);
      const atomicClaim = claims.atomic === undefined
        ? undefined
        : await claims.atomic.insertIfAbsent({
          id: approvalId,
          data: { runId, claimedBy, claimedAt: iso() },
        });
      if (claims.atomic !== undefined && atomicClaim === null) return;

      run.status = "running";
      delete run.summary;
      run.__resume.claimedBy = claimedBy;
      if (!await writeRun(run)) return;
      if (claims.atomic === undefined) {
        // Optional-capability fallback: preserve the prior single-instance behavior.
        // The unique write/read narrows, but cannot close, a cross-process race.
        const claimedRecord = await config.store.records(RUNS).get(runId);
        if (claimedRecord === null) return;
        const claimedRun = parseRunRow(claimedRecord).record;
        if (claimedRun.status !== "running" || claimedRun.__resume?.claimedBy !== claimedBy) return;
        syncRun(run, claimedRun);
      }

      const appFound = await appRecord(run.appId);
      if (appFound === null) {
        const ctx = runContext(run, approvalData.request.ctx.principal.subject);
        await terminal(run, ctx, "stopped", "app deleted before resume");
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      const ctx = runContext(run, appFound.row.subject);
      if (!appFound.row.enabled || appFound.row.doc.trigger === undefined) {
        await terminal(run, ctx, "stopped", "automation disabled before resume");
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      if (await finishStoppedIfNeeded(run, ctx)) {
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      await audit(ctx, "running");
      if (!approved) {
        const state = run.__resume;
        const pending = [...run.steps].reverse().find(
          (entry) => entry.outcome === "pending-approval" && entry.detail === approvalId,
        );
        if (pending !== undefined) {
          pending.outcome = "blocked";
          pending.detail = "user declined approval";
          pending.at = iso();
        }
        await terminal(run, ctx, "error", `stopped at ${state === undefined ? "step" : appFound.row.doc.trigger.run.kind === "steps" ? appFound.row.doc.trigger.run.steps[state.stepIndex]?.id ?? "step" : "step"}: user declined`, {
          code: "blocked",
          message: "the user declined the approval",
        });
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      await mintGrant(approvalData.request);
      const state = run.__resume as ResumeState;
      const trigger = validateTrigger(appFound.row.doc.trigger);
      if (trigger.run.kind !== "steps") throw new VendoError("validation", "parked agentic run is invalid");
      const step = trigger.run.steps[state.stepIndex];
      if (step === undefined) throw new VendoError("validation", "parked step is missing");
      const outcome = await executeCall(run.appId, step, state.call, ctx);
      if (await finishStoppedIfNeeded(run, ctx)) {
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      const pending = [...run.steps].reverse().find(
        (entry) => entry.outcome === "pending-approval" && entry.detail === approvalId,
      );
      if (pending !== undefined) {
        pending.outcome = outcome.status;
        // An explicit undefined property is not JSON — drop the key instead.
        const detail = outcomeDetail(outcome);
        if (detail === undefined) delete pending.detail;
        else pending.detail = detail;
        pending.at = iso();
      } else appendOutcome(run, step, outcome);
      if (outcome.status === "pending-approval") {
        state.approvalId = outcome.approvalId;
        delete state.claimedBy;
        await config.store.records(PARKED).delete(approvalId);
        await park(run, ctx, state);
        return;
      }
      if (outcome.status !== "ok") {
        const error = errorForOutcome(outcome);
        await terminal(run, ctx, "error", `stopped at ${step.id}: ${error.message}`, error);
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      if (state.iterationItems === undefined) state.stepOutputs[step.id] = outcome.output;
      else (state.iterationOutputs ??= []).push(outcome.output);
      delete run.__resume;
      if (!await writeRun(run)) {
        await config.store.records(PARKED).delete(approvalId);
        return;
      }
      await config.store.records(PARKED).delete(approvalId);
      await continueSteps(appFound.row, trigger, run, ctx, {
        stepIndex: state.iterationItems === undefined ? state.stepIndex + 1 : state.stepIndex,
        event: state.event,
        stepOutputs: state.stepOutputs,
        ...(state.iterationItems === undefined ? {} : {
          iterationItems: state.iterationItems,
          iterationOutputs: state.iterationOutputs,
          forEachIndex: (state.forEachIndex ?? 0) + 1,
        }),
      });
    } finally {
      resuming.delete(runId);
    }
  };

  const handleDecision = async (approvalId: string, approved: boolean): Promise<void> => {
    const capture = await config.store.records(CAPTURES).get(approvalId);
    if (capture !== null) {
      captureSchema.parse(capture.data);
      const approval = await config.store.records(APPROVALS).get(approvalId);
      if (approved && approval !== null) {
        const data = approvalRowSchema.parse(approval.data);
        await mintGrant(data.request);
        await markConsumed(approval);
      }
      await config.store.records(CAPTURES).delete(approvalId);
      return;
    }
    if (await config.store.records(PARKED).get(approvalId) !== null) {
      await resumeRun(approvalId, approved);
      return;
    }
    const approval = await config.store.records(APPROVALS).get(approvalId);
    if (approval === null || !approved) return;
    const data = approvalRowSchema.parse(approval.data);
    if (
      data.status === "approved"
      && data.consumedAt === undefined
      && data.request.ctx.venue === "automation"
      && data.request.ctx.appId !== undefined
    ) {
      // AgentRunReport has no continuation token in v0. Approval arms the
      // app-bound authority for the next agentic firing instead of replaying
      // and duplicating the completed prefix of an agent run.
      await mintGrant(data.request);
      await markConsumed(approval);
    }
  };

  // Returned as a thenable so a guard that awaits subscribers (ours does)
  // makes decide() deterministic through resumption; guards that don't still
  // get fire-and-forget behavior.
  config.guard.onApprovalDecision((approvalId, approved) =>
    handleDecision(approvalId, approved) as unknown as void);

  const enable: AutomationsEngine["enable"] = async (appId, ctx) => {
    const found = await ownedApp(appId, ctx.principal.subject);
    if (found.row.doc.trigger === undefined) throw new VendoError("validation", "app has no trigger");
    const trigger = validateTrigger(found.row.doc.trigger);
    const byName = await descriptors();
    const surface = trigger.run.kind === "steps"
      ? [...new Set(trigger.run.steps.map((step) => step.tool).filter((tool) => !tool.startsWith("fn:")))]
      // PR flag: without a model seat, agentic capture conservatively exposes every bound descriptor.
      : [...byName.keys()];
    const missing: ApprovalRequest[] = [];
    for (const tool of surface) {
      const descriptor = byName.get(tool);
      if (descriptor === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      if (await liveGrant(found.row.subject, appId, descriptor)) continue;
      const request: ApprovalRequest = {
        id: id("apr_"),
        call: { id: id("call_"), tool, args: {} },
        descriptor: clone(descriptor),
        inputPreview: `Allow "${found.row.doc.name}" to use ${tool} while you're away (standing, this app only)`,
        ctx: {
          principal: clone(ctx.principal),
          venue: "automation",
          presence: "present",
          appId,
        },
        createdAt: iso(),
      };
      await config.store.records(APPROVALS).put({
        id: request.id,
        data: { request, status: "pending", sessionId: ctx.sessionId },
      });
      await config.store.records(CAPTURES).put({
        id: request.id,
        data: { appId, subject: found.row.subject, tool, descriptorHash: descriptorHash(descriptor) },
      });
      missing.push(request);
    }
    found.row.enabled = true;
    await writeApp(found.record, found.row);
    if (trigger.on.kind === "schedule") {
      const cursor = await config.store.records(SCHEDULE).get(appId);
      if (cursor === null) {
        await config.store.records(SCHEDULE).put({ id: appId, data: { lastFiredAt: iso() } });
      }
    }
    if (trigger.on.kind === "external") {
      const secret = await config.store.records(WEBHOOK).get(appId);
      if (secret === null) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
        await config.store.records(WEBHOOK).put({ id: appId, data: { secret: base64url(bytes) } });
      }
    }
    return { enabled: true, missing };
  };

  const disable: AutomationsEngine["disable"] = async (appId, ctx) => {
    const found = await ownedApp(appId, ctx.principal.subject);
    found.row.enabled = false;
    await writeApp(found.record, found.row);
  };

  const list: AutomationsEngine["list"] = async (ctx) => {
    const records = await allRecords(config.store.records(APPS), { refs: { subject: ctx.principal.subject } });
    return records.map(parseAppRow)
      .filter((row) => row.subject === ctx.principal.subject && row.doc.trigger !== undefined)
      .map((row) => ({ app: row.doc, enabled: row.enabled }));
  };

  const sweepParked = async (): Promise<void> => {
    const runs = await allRecords(config.store.records(RUNS), { refs: { status: "pending-approval" } });
    for (const record of runs) {
      const run = parseRunRow(record).record;
      const approvalId = run.__resume?.approvalId;
      if (approvalId === undefined) continue;
      const approval = await config.store.records(APPROVALS).get(approvalId);
      if (approval === null) continue;
      const decision = approvalRowSchema.safeParse(approval.data);
      if (!decision.success || decision.data.status === "pending") continue;
      await resumeRun(approvalId, decision.data.status === "approved");
    }
  };

  const runTick: AutomationsEngine["tick"] = async (providedNow) => {
    await sweepParked();
    const at = providedNow ?? now();
    const atIso = at.toISOString();
    // Fetch only schedule-triggered apps (indexed trigger_kind ref) instead of scanning every
    // app for every subject, then batch every schedule cursor in one query (was an N+1 get).
    const appRecords = await allRecords(config.store.records(APPS), { refs: { trigger_kind: "schedule" } });
    const rows = appRecords
      .map(parseAppRow)
      .filter((row) => row.enabled && row.doc.trigger?.on.kind === "schedule");
    const scheduleRecords = config.store.records(SCHEDULE);
    const cursorRecords = rows.length === 0
      ? []
      : await allRecords(scheduleRecords, { ids: rows.map((row) => row.doc.id) });
    const cursorById = new Map(cursorRecords.map((record) => [record.id, record]));
    const fired: Array<{ row: AppRow; scheduledFor: string; firedAt: string }> = [];
    for (const row of rows) {
      const trigger = validateTrigger(row.doc.trigger);
      if (trigger.on.kind !== "schedule") continue;
      const cursorRecord = cursorById.get(row.doc.id) ?? null;
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
          if (scheduleRecords.atomic === undefined) await scheduleRecords.put({ id: row.doc.id, data: cursor });
          else await scheduleRecords.atomic.insertIfAbsent({ id: row.doc.id, data: cursor });
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
        if (scheduleRecords.atomic === undefined) await scheduleRecords.put({ id: row.doc.id, data: nextCursor });
        else claimed = await scheduleRecords.atomic.insertIfAbsent({ id: row.doc.id, data: nextCursor }) !== null;
      } else if (scheduleRecords.atomic !== undefined && cursorRecord.revision !== undefined) {
        claimed = await scheduleRecords.atomic.compareAndSwap(
          { id: row.doc.id, data: nextCursor },
          cursorRecord.revision,
        ) !== null;
      } else {
        await scheduleRecords.put({ id: row.doc.id, data: nextCursor });
      }
      if (!claimed) continue;
      fired.push({ row, scheduledFor, firedAt: atIso });
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
      void tick().finally(() => { ticking = false; });
    }, intervalMs);
    return () => clearInterval(timer);
  };

  const emit: AutomationsEngine["emit"] = async (event, payload, principal) => {
    // Only host-event apps for this subject (indexed refs) — was a full scan of the subject's apps.
    const records = await allRecords(config.store.records(APPS), {
      refs: { subject: principal.subject, trigger_kind: "host-event" },
    });
    const ids: string[] = [];
    for (const record of records) {
      const row = parseAppRow(record);
      const source = row.doc.trigger?.on;
      if (row.enabled && row.subject === principal.subject && source?.kind === "host-event" && source.event === event) {
        ids.push(await startRun(row, "host-event", payload));
      }
    }
    return ids;
  };

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
      principal: { kind: "user", subject: `webhook:${source}` },
      venue: "automation",
      presence: "away",
      detail: { status: "webhook-rejected", reason: text },
    });
    return envelope(response.status, response.code, text);
  };

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
    const appRecords = await allRecords(config.store.records(APPS));
    const verified: AppRow[] = [];
    for (const record of appRecords) {
      const row = parseAppRow(record);
      const trigger = row.doc.trigger?.on;
      if (!row.enabled || trigger?.kind !== "external" || trigger.connector !== source) continue;
      const secretRecord = await config.store.records(WEBHOOK).get(row.doc.id);
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
      if (matched) verified.push(row);
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
    for (const row of verified) {
      const deliveryKey = `${row.doc.id}:${headerResult.data.id}`;
      if (inFlightDeliveries.has(deliveryKey)) {
        deduped += 1;
        continue;
      }
      inFlightDeliveries.add(deliveryKey);
      try {
        const deliveries = config.store.records(DELIVERIES);
        const delivery = {
          id: deliveryKey,
          data: { appId: row.doc.id, deliveryId: headerResult.data.id, receivedAt: iso() },
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
        ids.push(await startRun(row, "external", body));
      } finally {
        inFlightDeliveries.delete(deliveryKey);
      }
    }
    if (ids.length === 0 && deduped > 0) return Response.json({ deduped: true }, { status: 200 });
    return Response.json({ runIds: ids }, { status: 200 });
  };

  const dryRun: AutomationsEngine["dryRun"] = async (appId, ctx, event) => {
    const found = await ownedApp(appId, ctx.principal.subject);
    if (found.row.doc.trigger === undefined) throw new VendoError("validation", "app has no trigger");
    const trigger = validateTrigger(found.row.doc.trigger);
    const byName = await descriptors();
    const plan: RunPlan = { steps: [], grantsMissing: [] };
    const add = async (stepId: string, tool: string): Promise<void> => {
      if (tool.startsWith("fn:")) {
        plan.steps.push({ id: stepId, tool, wouldAsk: false });
        return;
      }
      const descriptor = byName.get(tool);
      if (descriptor === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      const granted = await liveGrant(found.row.subject, appId, descriptor);
      plan.steps.push({ id: stepId, tool, wouldAsk: descriptor.critical === true || !granted });
      if (!descriptor.critical && !granted && !plan.grantsMissing.includes(tool)) plan.grantsMissing.push(tool);
    };
    if (trigger.run.kind === "agentic") {
      for (const descriptor of byName.values()) await add(descriptor.name, descriptor.name);
      return plan;
    }
    const outputs: Record<string, Json> = {};
    for (const step of trigger.run.steps) {
      if (event === undefined) {
        await add(step.id, step.tool);
        continue;
      }
      try {
        if (step.if !== undefined && !await evaluate(step.if, { event, steps: outputs, item: undefined })) continue;
        if (step.forEach === undefined) {
          await stepArgs(step, event, outputs);
          await add(step.id, step.tool);
          continue;
        }
        const items = validateForEachItems(
          step,
          await evaluate(step.forEach, { event, steps: outputs, item: undefined }),
        );
        for (const item of items) {
          await stepArgs(step, event, outputs, item);
          await add(step.id, step.tool);
        }
      } catch {
        // Nothing executes in a dry run, so `steps.<id>` outputs stay empty —
        // expressions over them cannot expand. Degrade to the static entry
        // rather than failing the preview.
        await add(step.id, step.tool);
      }
    }
    return plan;
  };

  const runsGet: AutomationsEngine["runs"]["get"] = async (runId, ctx) => {
    const stored = await config.store.records(RUNS).get(runId);
    if (stored === null) return null;
    const run = parseRunRow(stored).record;
    const app = await appRecord(run.appId);
    return app === null || app.row.subject !== ctx.principal.subject ? null : publicRun(run);
  };

  const runsList: AutomationsEngine["runs"]["list"] = async (filter, ctx) => {
    // Scope BEFORE paginating: filtering after the page both under-fills pages
    // and leaks a cursor (an existence oracle) to non-owners.
    if (filter.appId !== undefined) {
      const app = await appRecord(filter.appId);
      if (app === null || app.row.subject !== ctx.principal.subject) return { runs: [] };
    }
    const refs = {
      ...(filter.appId === undefined ? {} : { app_id: filter.appId }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
    };
    const runs: RunRecord[] = [];
    const owned = new Map<string, boolean>();
    let cursor = filter.cursor;
    // Without an appId scope, walk store pages until a page is filled with the
    // caller's runs — bounded so a foreign-heavy table cannot be scanned
    // unboundedly. Each fetch asks for exactly the remaining page budget, so
    // the store cursor always sits at the consumption boundary: pages never
    // overfill and the returned cursor never skips rows.
    for (let pages = 0; pages < 20 && runs.length < RUNS_PAGE_LIMIT; pages += 1) {
      const page = await config.store.records(RUNS).list({
        refs,
        limit: RUNS_PAGE_LIMIT - runs.length,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const stored of page.records) {
        const run = parseRunRow(stored).record;
        let mine = owned.get(run.appId);
        if (mine === undefined) {
          const app = await appRecord(run.appId);
          mine = app !== null && app.row.subject === ctx.principal.subject;
          owned.set(run.appId, mine);
        }
        if (mine) runs.push(publicRun(run));
      }
      cursor = page.cursor;
      if (cursor === undefined) break;
    }
    return { runs, ...(cursor === undefined ? {} : { cursor }) };
  };

  const runsStop: AutomationsEngine["runs"]["stop"] = async (runId, ctx) => {
    const stored = await config.store.records(RUNS).get(runId);
    if (stored === null) throw new VendoError("not-found", `run not found: ${runId}`);
    const run = parseRunRow(stored).record;
    const app = await appRecord(run.appId);
    if (app === null || app.row.subject !== ctx.principal.subject) throw new VendoError("not-found", `run not found: ${runId}`);
    if (run.status !== "running" && run.status !== "pending-approval") {
      throw new VendoError("conflict", `run cannot be stopped from status ${run.status}`);
    }
    stopped.add(runId);
    abortControllers.get(runId)?.abort();
    const parkedApprovalId = run.__resume?.approvalId;
    const runCtx = runContext(run, app.row.subject);
    await terminal(run, runCtx, "stopped", "stopped by user");
    if (parkedApprovalId !== undefined) await config.store.records(PARKED).delete(parkedApprovalId);
    if (!active.has(runId)) stopped.delete(runId);
  };

  return {
    enable,
    disable,
    list,
    tick,
    start,
    emit,
    webhook,
    runs: { get: runsGet, list: runsList, stop: runsStop },
    dryRun,
  };
};
