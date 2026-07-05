/**
 * Authoring tools (spec section d): the chat agent IS the compiler. The
 * `create_automation` input schema IS the DSL zod schema, so malformed specs
 * bounce back to the model as validation errors; semantic problems (closed
 * world, expression safety, retry-on-idempotent, grant references) come back
 * as `{ ok: false, errors }` results the model can correct against.
 *
 * create/update/delete carry `destructiveHint` annotations so the existing
 * annotation policy layer gates them with an approval card — creating standing
 * authority is always approval-gated, with no new policy machinery. Grants are
 * computed here (scope-hashed per step) and stored as version metadata, never
 * inside the compiler-emitted DSL.
 *
 * Schedule-triggered automations are registered on the FROZEN core Scheduler
 * seam explicitly (schedule/cancel), with the caller's Principal, which the
 * scheduler persists and replays on firings.
 */
import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Principal, Scheduler, TimeTrigger } from "@vendoai/core";
import { ExpressionError, validateExpression } from "./expressions";
import { computeGrant } from "./grants";
import { dangerTier } from "../policy/tier";
import type { RegisteredTool } from "./interpreter";
import type { AutomationRunner } from "./runner";
import {
  automationSpecInputSchema,
  automationSpecSchema,
  specTier,
  walkSteps,
  type AutomationSpec,
  type AutomationStep,
  type AutomationTrigger,
} from "./schema";
import type {
  AutomationEngineStore,
  AutomationGrant,
  AutomationRecord,
} from "./store";

export interface AutomationToolsConfig {
  store: AutomationEngineStore;
  runner: AutomationRunner;
  /** The frozen Scheduler seam; omit when no schedule triggers are possible. */
  scheduler?: Scheduler;
  principal: Principal;
  /** The closed world: every tool a spec may reference. */
  registeredTools: () => Promise<Record<string, RegisteredTool>>;
  /** Host event types available as triggers (manifest-declared later). */
  hostEvents?: string[];
  createdFromThreadId?: string;
  /** Timestamp source for grant metadata (the store owns row timestamps). */
  now?: () => string;
}

const INTERPOLATION_RE = /\{\{([\s\S]+?)\}\}/g;

function toTimeTrigger(trigger: Extract<AutomationTrigger, { type: "schedule" }>): TimeTrigger {
  if (trigger.at !== undefined) return { kind: "at", at: trigger.at };
  return { kind: "cron", expression: trigger.cron!, timezone: trigger.timezone };
}

/** Collect every expression in a spec: guards, items, and input templates. */
function collectExpressions(spec: AutomationSpec): string[] {
  const expressions: string[] = [];
  if (spec.if !== undefined) expressions.push(spec.if);

  const fromValue = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(INTERPOLATION_RE)) {
        expressions.push(match[1]!.trim());
      }
    } else if (Array.isArray(value)) {
      value.forEach(fromValue);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(fromValue);
    }
  };

  if (spec.execution.mode === "steps") {
    walkSteps(spec.execution.steps, (step) => {
      if (step.type === "branch") {
        expressions.push(step.if);
        return;
      }
      if (step.if !== undefined) expressions.push(step.if);
      if (step.type === "for_each") {
        for (const match of step.items.matchAll(INTERPOLATION_RE)) {
          expressions.push(match[1]!.trim());
        }
        return;
      }
      fromValue(step.input);
    });
  }
  return expressions;
}

/**
 * Every tool name a spec may invoke: tool steps at any nesting (branch
 * then/else, for_each children), agent-step `tools` allowlists, and
 * agentic-mode's own `execution.tools` allowlist.
 */
function collectReferencedTools(spec: AutomationSpec): Set<string> {
  const names = new Set<string>();
  if (spec.execution.mode === "agent") {
    for (const name of spec.execution.tools) names.add(name);
  } else {
    walkSteps(spec.execution.steps, (step) => {
      if (step.type === "tool") names.add(step.tool);
      else if (step.type === "agent") for (const name of step.tools) names.add(name);
    });
  }
  return names;
}

/**
 * Tools a spec may not reference at all: missing from the closed world, or
 * present but client-executed (`.vendo/tools.json` host tools ride the
 * user's browser session and cannot run unattended — spec section "Unattended-
 * tool honesty"). Checked once, up front, so create/update fail before any
 * store write instead of the interpreter discovering it mid-run.
 */
function findUnattendedTools(
  spec: AutomationSpec,
  registered: Record<string, RegisteredTool>,
): string[] {
  const offenders: string[] = [];
  for (const name of collectReferencedTools(spec)) {
    const descriptor = registered[name]?.descriptor;
    if (!descriptor || descriptor.executor === "client") offenders.push(name);
  }
  return offenders;
}

/** Semantic validation beyond the zod shape. Returns human/model-readable errors. */
function validateSpecSemantics(
  spec: AutomationSpec,
  registered: Record<string, RegisteredTool>,
  hostEvents: readonly string[] | undefined,
  grantedTools: readonly string[],
): string[] {
  const errors: string[] = [];
  const referencedTools = collectReferencedTools(spec);

  if (spec.trigger.type === "host_event" && hostEvents !== undefined) {
    if (!hostEvents.includes(spec.trigger.event)) {
      errors.push(
        `trigger: host event "${spec.trigger.event}" is not declared ` +
          `(available: ${hostEvents.join(", ") || "none"})`,
      );
    }
  }

  if (spec.execution.mode !== "agent") {
    walkSteps(spec.execution.steps, (step) => {
      if (step.type !== "tool") return;
      const descriptor = registered[step.tool]?.descriptor;
      if (
        step.onError?.strategy === "retry" &&
        descriptor !== undefined &&
        descriptor.annotations.idempotentHint !== true &&
        descriptor.annotations.readOnlyHint !== true
      ) {
        errors.push(
          `step "${step.id}": onError.retry requires an idempotent tool; ` +
            `"${step.tool}" is not marked idempotent`,
        );
      }
    });
  }

  for (const expression of collectExpressions(spec)) {
    try {
      validateExpression(expression);
    } catch (err) {
      errors.push(err instanceof ExpressionError ? err.message : String(err));
    }
  }

  for (const name of grantedTools) {
    if (!referencedTools.has(name)) {
      errors.push(`grantedTools: "${name}" is not used anywhere in the spec`);
    }
  }
  return errors;
}

/** One grant per (granted tool, using step); agentic mode grants step = null. */
function buildGrants(
  spec: AutomationSpec,
  registered: Record<string, RegisteredTool>,
  grantedTools: readonly string[],
  now: string,
): AutomationGrant[] {
  const grants: AutomationGrant[] = [];
  const granted = new Set(grantedTools);

  const maybeGrant = (name: string, step: AutomationStep | null): void => {
    const descriptor = registered[name]?.descriptor;
    if (!granted.has(name) || descriptor === undefined) return;
    // ENG-193 §8.3: dangerous tools are never pre-authorizable. They are
    // excluded here (not an error) — the step will pause/park per-firing
    // instead.
    if (dangerTier(descriptor) === "critical") return;
    grants.push(computeGrant({ tool: name, descriptor, spec, step, now }));
  };

  if (spec.execution.mode === "agent") {
    for (const name of spec.execution.tools) maybeGrant(name, null);
  } else {
    walkSteps(spec.execution.steps, (step) => {
      if (step.type === "tool") maybeGrant(step.tool, step);
      else if (step.type === "agent") for (const name of step.tools) maybeGrant(name, step);
    });
  }
  return grants;
}

/** Card/model-facing summary of an automation record. */
function summarize(automation: AutomationRecord, spec: AutomationSpec) {
  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    disabledReason: automation.disabledReason,
    version: automation.currentVersion,
    tier: specTier(spec),
    trigger: spec.trigger,
    prompt: spec.prompt,
    description: spec.description,
    counters: automation.counters,
    spec,
  };
}

function markDestructive<T extends Tool>(t: T): T {
  // buildDescriptor reads top-level `annotations` — this is how the existing
  // annotation policy layer learns these tools always need approval.
  return Object.assign(t, { annotations: { destructiveHint: true } });
}

export function createAutomationTools(config: AutomationToolsConfig): ToolSet {
  const now = (): string => config.now?.() ?? new Date().toISOString();
  const scope = config.principal;
  let testCounter = 0;

  const notFound = (id: string) => ({
    ok: false as const,
    errors: [`automation "${id}" not found`],
  });

  const syncSchedule = async (id: string, spec: AutomationSpec): Promise<void> => {
    if (!config.scheduler) return;
    if (spec.trigger.type === "schedule") {
      await config.scheduler.schedule(id, toTimeTrigger(spec.trigger), scope);
    } else {
      await config.scheduler.cancel(id);
    }
  };

  const compile = async (
    spec: AutomationSpec,
    grantedTools: readonly string[],
  ): Promise<
    | { ok: true; registered: Record<string, RegisteredTool>; grants: AutomationGrant[] }
    | { ok: false; errors: string[] }
  > => {
    const registered = await config.registeredTools();
    const unattended = findUnattendedTools(spec, registered);
    if (unattended.length > 0) {
      return {
        ok: false,
        errors: [
          `tool(s) ${unattended.join(", ")} are not server-registered — client-executed host ` +
            `tools cannot run unattended; register a server tool via automations.tools`,
        ],
      };
    }
    const errors = validateSpecSemantics(spec, registered, config.hostEvents, grantedTools);
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, registered, grants: buildGrants(spec, registered, grantedTools, now()) };
  };

  const createAutomation = markDestructive(
    tool({
      description:
        "Create a standing automation from a compiled spec. The spec is the inspectable " +
        "artifact the user approves: prefer deterministic tool steps; use an agent step only " +
        "where judgment over unstructured data is needed. grantedTools lists tools the user " +
        "explicitly pre-authorized for unattended runs (never invent these).",
      inputSchema: z.object({
        spec: automationSpecInputSchema,
        grantedTools: z.array(z.string()).optional(),
      }),
      execute: async ({ spec: rawSpec, grantedTools }) => {
        // The model never chooses a DSL version (dslVersion is not in the input
        // schema — a numeric literal there breaks Google function declarations).
        // Inject it server-side, then validate against the persisted contract —
        // which also re-applies defaults for direct callers (tests, wrappers).
        const spec = automationSpecSchema.parse({ ...rawSpec, dslVersion: 1 });
        const compiled = await compile(spec, grantedTools ?? []);
        if (!compiled.ok) return compiled;
        const { automation } = await config.store.create(scope, {
          spec,
          grants: compiled.grants,
          createdFromThreadId: config.createdFromThreadId ?? null,
        });
        await syncSchedule(automation.id, spec);
        return { ok: true, automation: summarize(automation, spec) };
      },
    }),
  );

  const updateAutomation = markDestructive(
    tool({
      description:
        "Replace an automation's spec with a new immutable version. Grants never carry over: " +
        "pass grantedTools fresh (the user re-approves the whole package).",
      inputSchema: z.object({
        id: z.string(),
        spec: automationSpecInputSchema,
        grantedTools: z.array(z.string()).optional(),
      }),
      execute: async ({ id, spec: rawSpec, grantedTools }) => {
        const automation = await config.store.get(scope, id);
        if (!automation) return notFound(id);
        // dslVersion is server-injected (see create_automation): the model
        // never sends it, keeping the tool's JSON schema numeric-literal-free.
        const spec = automationSpecSchema.parse({ ...rawSpec, dslVersion: 1 });
        const compiled = await compile(spec, grantedTools ?? []);
        if (!compiled.ok) return compiled;
        await config.store.cancelPendingRuns(scope, id);
        const updated = await config.store.update(scope, id, {
          spec,
          grants: compiled.grants,
          createdBy: "user_edit",
        });
        await syncSchedule(id, spec);
        return { ok: true, automation: summarize(updated.automation, spec) };
      },
    }),
  );

  const deleteAutomation = markDestructive(
    tool({
      description: "Delete an automation permanently and cancel its pending runs.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const automation = await config.store.get(scope, id);
        if (!automation) return notFound(id);
        await config.store.cancelPendingRuns(scope, id);
        await config.store.delete(scope, id);
        await config.scheduler?.cancel(id);
        return { ok: true };
      },
    }),
  );

  const listAutomations = tool({
    description: "List the user's automations with status and run counters.",
    inputSchema: z.object({}),
    execute: async () => {
      const automations = await config.store.list(scope);
      return { ok: true, automations: automations.map((a) => summarize(a, a.spec)) };
    },
  });

  const getRuns = tool({
    description: "Get an automation's run history (most recent first).",
    inputSchema: z.object({
      id: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    execute: async ({ id, limit }) => {
      const automation = await config.store.get(scope, id);
      if (!automation) return notFound(id);
      const runs = (await config.store.listRuns(scope, id))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, limit)
        .map((run) => ({
          id: run.id,
          status: run.outcome ?? run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          isTest: run.isTest,
          error: run.error,
          steps: run.steps.map((s) => ({ id: s.id, status: s.status, error: s.error })),
        }));
      return { ok: true, runs };
    },
  });

  const pauseAutomation = tool({
    description: "Pause an automation (it stops firing; pending approvals are cancelled).",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const automation = await config.store.get(scope, id);
      if (!automation) return notFound(id);
      await config.store.cancelPendingRuns(scope, id);
      await config.store.setStatus(scope, id, "paused");
      await config.scheduler?.cancel(id);
      return { ok: true };
    },
  });

  const resumeAutomation = tool({
    description: "Re-enable a paused (or error-parked) automation.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const automation = await config.store.get(scope, id);
      if (!automation) return notFound(id);
      await config.store.setStatus(scope, id, "enabled");
      await syncSchedule(id, automation.spec);
      return { ok: true };
    },
  });

  const runNow = tool({
    description:
      "Test-fire an automation with a sample trigger payload. DRY-RUN by default: read-only " +
      "tools execute, mutating tools are simulated with their evaluated inputs recorded. " +
      "Pass live: true only when the user explicitly asks for a real run.",
    inputSchema: z.object({
      id: z.string(),
      samplePayload: z.record(z.unknown()).optional(),
      live: z.boolean().default(false),
    }),
    execute: async ({ id, samplePayload, live }) => {
      const automation = await config.store.get(scope, id);
      if (!automation) return notFound(id);
      const firedAt = now();
      const run = await config.runner.fire(
        scope,
        id,
        {
          source: "test",
          eventId: `test-${firedAt}-${++testCounter}`,
          subject: scope.subject,
          occurredAt: firedAt,
          payload: samplePayload ?? { firedAt },
        },
        { isTest: true, dryRun: !live },
      );
      if (!run) return { ok: false, errors: ["automation did not fire (disabled?)"] };
      return {
        ok: true,
        run: {
          id: run.id,
          status: run.outcome ?? run.status,
          isTest: run.isTest,
          dryRun: !live,
          error: run.error,
          steps: run.steps.map((s) => ({ id: s.id, status: s.status, output: s.output, error: s.error })),
        },
      };
    },
  });

  return {
    create_automation: createAutomation,
    update_automation: updateAutomation,
    delete_automation: deleteAutomation,
    list_automations: listAutomations,
    get_automation_runs: getRuns,
    pause_automation: pauseAutomation,
    resume_automation: resumeAutomation,
    run_automation_now: runNow,
  };
}
