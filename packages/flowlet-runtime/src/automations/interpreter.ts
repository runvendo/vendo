/**
 * The step-graph interpreter (spec sections a/c, as amended).
 *
 * Pure execution: no I/O, no timers, no store access — the runner persists.
 * Every tool step consults the policy itself (the ai SDK's turn-based
 * `needsApproval` loop does not fit unattended runs):
 *
 *   allow                              -> execute
 *   approve + valid scope-hashed grant -> execute unattended
 *   approve + no/stale grant           -> pause: `waiting_approval` + checkpoint
 *   deny                               -> step fails
 *
 * Resume is replay-with-restore: the checkpoint carries completed step records
 * and their outputs; the walk restores them without re-executing, then runs the
 * paused step per the decision. Approval pauses inside `for_each` are not
 * resumable in v1 and fail the step instead (grant the tool, or keep it out of
 * loops) — an unattended loop that pauses per-iteration is broken UX anyway.
 */
import type { ToolCallOutcome } from "@flowlet/core";
import type { ApprovalPolicy } from "../policy";
import { dangerTier } from "../policy/tier";
import type { FlowletPrincipal } from "../principal";
import type { ToolDescriptor } from "../descriptor";
import {
  evaluateGuard,
  resolveInput,
  type ExpressionScope,
} from "./expressions";
import { canonicalJson, fnv1a64, hashDescriptor, hasValidGrant } from "./grants";
import type {
  AgentExecution,
  AutomationSpec,
  AutomationStep,
  ForEachStep,
  ToolStep,
  AgentStep,
} from "./schema";
import type {
  AutomationGrant,
  PendingApproval,
  StepRecord,
  TriggerEnvelope,
} from "./store";

/** Wall-clock ceilings (spec section a). */
export const MAX_RUN_MS_STEPS = 5 * 60 * 1000;
export const MAX_RUN_MS_WITH_AGENT = 15 * 60 * 1000;
/** Pending approvals expire after 7 days (amendment 7). */
export const PENDING_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The narrow tool shape the interpreter executes. Adapters map ai-SDK tools
 * (which carry zod `inputSchema` and `execute`) onto this. Execution resolves
 * to the FROZEN core `ToolCallOutcome` — discriminated on `ok`, so a
 * legitimate `undefined` result never reads as an error (contracts freeze).
 */
export interface RegisteredTool {
  descriptor: ToolDescriptor;
  /** Model-facing description, re-exposed to agent steps. */
  description?: string;
  /** Model-facing input schema (JSON Schema), re-exposed to agent steps. */
  modelInputSchema?: Record<string, unknown>;
  inputSchema?: {
    safeParse(input: unknown): { success: boolean; error?: unknown };
  };
  execute(
    input: Record<string, unknown>,
    ctx: { idempotencyKey: string },
  ): Promise<ToolCallOutcome>;
}

export interface AgentStepRequest {
  goal: string;
  input: Record<string, unknown>;
  /** Allowlisted subset of the run's tools. */
  tools: Record<string, RegisteredTool>;
  maxToolCalls: number;
  outputSchema?: Record<string, unknown>;
  /** Context for fully agentic mode: the automation's description. */
  description?: string;
}

export type AgentStepRunner = (request: AgentStepRequest) => Promise<unknown>;

/** Serializable pause state; opaque to everything but the interpreter. */
interface Checkpoint {
  stepId: string;
  tool: string;
  outputs: Record<string, unknown>;
  steps: StepRecord[];
}

export interface InterpretInput {
  spec: AutomationSpec;
  grants?: AutomationGrant[];
  runId: string;
  automationId?: string;
  envelope: TriggerEnvelope;
  user?: Record<string, unknown>;
  tools: Record<string, RegisteredTool>;
  policy: ApprovalPolicy;
  principal: FlowletPrincipal;
  agentRunner?: AgentStepRunner;
  /** Dry-run: mutating tools are simulated, read-only ones execute (ruling). */
  dryRun?: boolean;
  maxDurationMs?: number;
  nowMs?: () => number;
  /** ISO timestamp source for step records. */
  now?: () => string;
  resume?: { checkpoint: unknown; approved: boolean };
}

/** What the interpreter can observe and record about a park — no I/O, no
 *  store access (this module stays pure; the runner persists, per its own
 *  docstring's rule). One-to-one with store.ts's CreateParkedActionInput,
 *  minus automationId/runId (the runner already has those from InterpretInput). */
export interface ParkedActionDraft {
  stepId: string;
  tool: string;
  input: Record<string, unknown>;
  guardExpr?: string;
  guardBindings?: Record<string, unknown>;
  reason: "ungranted" | "critical";
  tier: "act" | "critical";
  descriptorHash: string;
  requestedAt: string;
}

export type InterpretOutcome =
  | { status: "succeeded"; steps: StepRecord[]; parkedActions: ParkedActionDraft[] }
  | { status: "failed"; steps: StepRecord[]; error: string; parkedActions: ParkedActionDraft[] }
  | {
      status: "waiting_approval";
      steps: StepRecord[];
      pendingApproval: PendingApproval;
      parkedActions: ParkedActionDraft[];
    };

/** Internal control-flow signals. */
class PauseSignal extends Error {
  constructor(
    readonly stepId: string,
    readonly tool: string,
    readonly resolvedInput: Record<string, unknown>,
  ) {
    super(`step "${stepId}" awaits approval for "${tool}"`);
  }
}

class StepFailure extends Error {
  constructor(
    readonly stepId: string,
    detail: string,
  ) {
    super(`step "${stepId}": ${detail}`);
  }
}

class RunTimeout extends Error {
  constructor(elapsedMs: number, limitMs: number) {
    super(`run exceeded its wall-clock limit (${elapsedMs}ms > ${limitMs}ms)`);
  }
}

interface ExecContext {
  input: Required<Pick<InterpretInput, "spec" | "runId" | "tools" | "policy" | "principal">> &
    InterpretInput;
  outputs: Record<string, unknown>;
  records: StepRecord[];
  /** Extra expression bindings (for_each item/index). */
  bindings: Record<string, unknown>;
  insideLoop: boolean;
  /** Steps already completed in a prior pass (resume). */
  restored: Map<string, StepRecord>;
  /** The paused step id being resumed, once per run. */
  resumeTarget?: { stepId: string; approved: boolean };
  startMs: number;
  limitMs: number;
  nowMs: () => number;
  now: () => string;
  grants: AutomationGrant[];
  /** ENG-193 §4.6 — accumulates across the WHOLE run, including every
   *  for_each iteration (shared by reference into iterationCtx, unlike
   *  `records`, which is deliberately per-iteration). */
  parkedActions: ParkedActionDraft[];
}

function specHasAgent(spec: AutomationSpec): boolean {
  if (spec.execution.mode === "agent") return true;
  let found = false;
  const walk = (steps: readonly AutomationStep[]): void => {
    for (const s of steps) {
      if (s.type === "agent") found = true;
      else if (s.type === "branch") {
        walk(s.then);
        if (s.else) walk(s.else);
      } else if (s.type === "for_each") walk(s.steps);
    }
  };
  walk(spec.execution.mode === "steps" ? spec.execution.steps : []);
  return found;
}

function buildScope(ctx: ExecContext): ExpressionScope {
  return {
    trigger: ctx.input.envelope.payload,
    steps: ctx.outputs,
    run: {
      id: ctx.input.runId,
      automationId: ctx.input.automationId ?? "",
      firedAt: ctx.input.envelope.occurredAt,
    },
    user: ctx.input.user ?? {},
    ...ctx.bindings,
  };
}

function checkClock(ctx: ExecContext): void {
  const elapsed = ctx.nowMs() - ctx.startMs;
  if (elapsed > ctx.limitMs) throw new RunTimeout(elapsed, ctx.limitMs);
}

function isReadOnly(descriptor: ToolDescriptor): boolean {
  return descriptor.annotations.readOnlyHint === true;
}

function isIdempotent(descriptor: ToolDescriptor): boolean {
  return descriptor.annotations.idempotentHint === true || isReadOnly(descriptor);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Minimal structural check of an agent step's declared output schema
 * ({ type, properties, required } one level deep). The real agent runner also
 * enforces the schema model-side; this is the interpreter's backstop.
 */
function validateAgentOutput(
  schema: Record<string, unknown> | undefined,
  output: unknown,
): string | undefined {
  if (!schema) return undefined;
  if (schema["type"] === "object") {
    if (output === null || typeof output !== "object" || Array.isArray(output)) {
      return `expected an object result, got ${Array.isArray(output) ? "array" : typeof output}`;
    }
    const record = output as Record<string, unknown>;
    for (const key of (schema["required"] as string[] | undefined) ?? []) {
      if (record[key] === undefined) return `result is missing required field "${key}"`;
    }
  }
  return undefined;
}

async function executeToolStep(ctx: ExecContext, step: ToolStep): Promise<void> {
  const startedAt = ctx.now();
  const tool = ctx.input.tools[step.tool];
  if (!tool) throw new StepFailure(step.id, `tool "${step.tool}" is not registered`);

  const resolved = (await resolveInput(step.input, buildScope(ctx))) as Record<string, unknown>;

  // Validate the EVALUATED input against the tool's own schema (amendment 5).
  if (tool.inputSchema) {
    const parsed = tool.inputSchema.safeParse(resolved);
    if (!parsed.success) {
      throw new StepFailure(step.id, `evaluated input rejected: ${errorMessage(parsed.error)}`);
    }
  }

  // Dry-run: mutating tools are simulated, never executed (ruling).
  if (ctx.input.dryRun === true && !isReadOnly(tool.descriptor)) {
    ctx.records.push({
      id: step.id,
      status: "simulated",
      startedAt,
      finishedAt: ctx.now(),
      output: { simulatedInput: resolved },
      idempotencyKey: `${ctx.input.runId}/${step.id}/0`,
    });
    return;
  }

  // Policy gate (dry-run reaches here only for read-only tools — harmless).
  if (ctx.input.dryRun !== true) {
    const decision = await ctx.input.policy.evaluate({
      toolName: step.tool,
      input: resolved,
      descriptor: tool.descriptor,
      principal: ctx.input.principal,
    });
    if (decision === "deny") {
      throw new StepFailure(step.id, `policy denied tool "${step.tool}"`);
    }
    if (decision === "approve") {
      const resumeApproved =
        ctx.resumeTarget?.stepId === step.id && ctx.resumeTarget.approved;
      // Critical is unsuppressible by type (ENG-193 §4.1): a grant for a
      // dangerous tool — however it got into the store — never runs unattended.
      const granted =
        dangerTier(tool.descriptor) !== "critical" &&
        hasValidGrant(ctx.grants, {
          tool: step.tool,
          descriptor: tool.descriptor,
          spec: ctx.input.spec,
          step,
        });
      if (!granted && !resumeApproved) {
        if (ctx.insideLoop) {
          // ENG-193 §4.6: park the action, not the run — record it and treat
          // this step as a soft-skip (deviation #6: sibling steps in the same
          // iteration still run; a later step reading this one's output sees
          // undefined, the spec author's responsibility to guard against).
          const critical = dangerTier(tool.descriptor) === "critical";
          ctx.parkedActions.push({
            stepId: step.id,
            tool: step.tool,
            input: resolved,
            ...(step.if !== undefined ? { guardExpr: step.if } : {}),
            ...(Object.keys(ctx.bindings).length > 0 ? { guardBindings: { ...ctx.bindings } } : {}),
            reason: critical ? "critical" : "ungranted",
            tier: critical ? "critical" : "act",
            descriptorHash: hashDescriptor(tool.descriptor),
            requestedAt: ctx.now(),
          });
          ctx.records.push({
            id: step.id,
            status: "parked",
            startedAt,
            finishedAt: ctx.now(),
            idempotencyKey: `${ctx.input.runId}/${step.id}/0`,
          });
          return;
        }
        throw new PauseSignal(step.id, step.tool, resolved);
      }
    }
  }

  // Execute with retry only for idempotent-safe tools (amendment 5).
  const maxAttempts =
    step.onError?.strategy === "retry" ? (step.onError.attempts ?? 3) : 1;
  if (maxAttempts > 1 && !isIdempotent(tool.descriptor)) {
    throw new StepFailure(
      step.id,
      `onError.retry requires an idempotent tool; "${step.tool}" is not marked idempotent`,
    );
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const idempotencyKey = `${ctx.input.runId}/${step.id}/${attempt}`;
    try {
      const outcome = await tool.execute(resolved, { idempotencyKey });
      if (!outcome.ok) throw new Error(outcome.error.message);
      ctx.outputs[step.id] = { output: outcome.result };
      ctx.records.push({
        id: step.id,
        status: "succeeded",
        startedAt,
        finishedAt: ctx.now(),
        output: outcome.result,
        attempts: attempt,
        idempotencyKey,
      });
      return;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new StepFailure(step.id, errorMessage(err));
      }
    }
  }
}

/** Shared hard budget across every tool handed to one agent run (review P2). */
interface ToolBudget {
  remaining: number;
}

/**
 * Tools handed to an agent run are policy-gated per call: an unattended agent
 * cannot pause for approval, so deny — and approve without a matching grant —
 * reject the call with an error the model sees and can route around. Inputs
 * are validated against the tool's own schema (direct steps already do this),
 * and the shared budget is a hard ceiling, not just a model stop condition.
 */
function gateAgentTool(
  ctx: ExecContext,
  name: string,
  tool: RegisteredTool,
  grantStep: AutomationStep | null,
  budget: ToolBudget,
): RegisteredTool {
  return {
    ...tool,
    execute: async (input, execCtx) => {
      if (budget.remaining <= 0) {
        return {
          ok: false,
          error: {
            code: "tool_budget_exhausted",
            message: "this run's maxToolCalls budget is spent — finish with what you have",
          },
        };
      }
      budget.remaining -= 1;
      if (tool.inputSchema) {
        const parsed = tool.inputSchema.safeParse(input);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: "invalid_input",
              message: `input rejected by "${name}" schema: ${errorMessage(parsed.error)}`,
            },
          };
        }
      }
      const decision = await ctx.input.policy.evaluate({
        toolName: name,
        input,
        descriptor: tool.descriptor,
        principal: ctx.input.principal,
      });
      if (decision === "deny") {
        return {
          ok: false,
          error: { code: "policy_denied", message: `policy denied tool "${name}"` },
        };
      }
      if (decision === "approve") {
        const critical = dangerTier(tool.descriptor) === "critical";
        // Critical is unsuppressible by type (ENG-193 §4.1): a grant for a
        // dangerous tool — however it got into the store — never runs unattended.
        const granted =
          !critical &&
          hasValidGrant(ctx.grants, {
            tool: name,
            descriptor: tool.descriptor,
            spec: ctx.input.spec,
            step: grantStep,
          });
        if (!granted) {
          // ENG-193 §4.6(b): park the action — the run's summary can say
          // what's waiting — and tell the model plainly to continue without
          // it (never a dead error it might retry into a loop).
          // Dedup within the run (review follow-up): a model that retries the
          // SAME refused call must not stack duplicate parked rows — one row
          // per distinct (tool, input) pair.
          const inputKey = canonicalJson(input);
          const alreadyParked = ctx.parkedActions.some(
            (p) => p.tool === name && canonicalJson(p.input) === inputKey,
          );
          if (!alreadyParked) {
            ctx.parkedActions.push({
              stepId: grantStep?.id ?? "agent",
              tool: name,
              input: input as Record<string, unknown>,
              ...(grantStep && grantStep.type !== "branch" && grantStep.type !== "for_each" && grantStep.if !== undefined
                ? { guardExpr: grantStep.if }
                : {}),
              ...(Object.keys(ctx.bindings).length > 0 ? { guardBindings: { ...ctx.bindings } } : {}),
              reason: critical ? "critical" : "ungranted",
              tier: critical ? "critical" : "act",
              descriptorHash: hashDescriptor(tool.descriptor),
              requestedAt: ctx.now(),
            });
          }
          return {
            ok: false,
            error: {
              code: "approval_required",
              message:
                `tool "${name}" needs the user's approval and has no grant for unattended runs — ` +
                "approval requested from the user; the action is parked as WAITING (never report " +
                "it as done or sent), continue without it.",
            },
          };
        }
      }
      return tool.execute(input, execCtx);
    },
  };
}

async function executeAgentStep(ctx: ExecContext, step: AgentStep): Promise<void> {
  const startedAt = ctx.now();
  const runner = ctx.input.agentRunner;
  if (!runner) throw new StepFailure(step.id, "no agent runner configured");

  const resolved = (await resolveInput(step.input, buildScope(ctx))) as Record<string, unknown>;

  if (ctx.input.dryRun === true) {
    ctx.records.push({
      id: step.id,
      status: "simulated",
      startedAt,
      finishedAt: ctx.now(),
      output: { simulatedInput: resolved },
      idempotencyKey: `${ctx.input.runId}/${step.id}/0`,
    });
    return;
  }

  const budget: ToolBudget = { remaining: step.maxToolCalls };
  const allowlisted: Record<string, RegisteredTool> = {};
  for (const name of step.tools) {
    const tool = ctx.input.tools[name];
    if (!tool) throw new StepFailure(step.id, `allowlisted tool "${name}" is not registered`);
    allowlisted[name] = gateAgentTool(ctx, name, tool, step, budget);
  }

  let output: unknown;
  try {
    output = await runner({
      goal: step.goal,
      input: resolved,
      tools: allowlisted,
      maxToolCalls: step.maxToolCalls,
      outputSchema: step.output,
    });
  } catch (err) {
    throw new StepFailure(step.id, errorMessage(err));
  }
  const schemaError = validateAgentOutput(step.output, output);
  if (schemaError !== undefined) throw new StepFailure(step.id, schemaError);

  ctx.outputs[step.id] = { output };
  ctx.records.push({
    id: step.id,
    status: "succeeded",
    startedAt,
    finishedAt: ctx.now(),
    output,
    idempotencyKey: `${ctx.input.runId}/${step.id}/1`,
  });
}

async function executeForEach(ctx: ExecContext, step: ForEachStep): Promise<void> {
  const startedAt = ctx.now();
  const scope = buildScope(ctx);
  const items = (await resolveInput({ items: step.items }, scope))["items"];
  if (!Array.isArray(items)) {
    throw new StepFailure(step.id, `items expression did not produce an array`);
  }
  const truncated = items.length > step.maxItems;
  const bounded = items.slice(0, step.maxItems);

  const iterations: Array<{ item: unknown; index: number; steps: Record<string, unknown> }> = [];
  for (let index = 0; index < bounded.length; index++) {
    checkClock(ctx);
    // Child steps see the loop bindings; their outputs stay iteration-local.
    const iterationCtx: ExecContext = {
      ...ctx,
      outputs: { ...ctx.outputs },
      records: [],
      bindings: { ...ctx.bindings, [step.as]: bounded[index], index },
      insideLoop: true,
    };
    await executeSteps(iterationCtx, step.steps);
    const iterationOutputs: Record<string, unknown> = {};
    for (const record of iterationCtx.records) {
      iterationOutputs[record.id] = record.output;
    }
    iterations.push({ item: bounded[index], index, steps: iterationOutputs });
  }

  const output = { iterations, truncated };
  ctx.outputs[step.id] = { output };
  ctx.records.push({
    id: step.id,
    status: "succeeded",
    startedAt,
    finishedAt: ctx.now(),
    output,
    idempotencyKey: `${ctx.input.runId}/${step.id}/1`,
  });
}

async function executeSteps(ctx: ExecContext, steps: readonly AutomationStep[]): Promise<void> {
  for (const step of steps) {
    checkClock(ctx);

    // Resume: restore completed records without re-executing.
    const restored = ctx.restored.get(step.id);
    if (restored) {
      ctx.records.push(restored);
      if (restored.output !== undefined) ctx.outputs[step.id] = { output: restored.output };
      continue;
    }
    if (ctx.resumeTarget?.stepId === step.id && !ctx.resumeTarget.approved) {
      throw new StepFailure(step.id, "approval declined by the user");
    }

    // Per-step guard.
    if (step.type !== "branch" && step.if !== undefined) {
      if (!(await evaluateGuard(step.if, buildScope(ctx)))) {
        ctx.records.push({
          id: step.id,
          status: "skipped",
          startedAt: ctx.now(),
          finishedAt: ctx.now(),
          idempotencyKey: `${ctx.input.runId}/${step.id}/0`,
        });
        continue;
      }
    }

    try {
      if (step.type === "tool") await executeToolStep(ctx, step);
      else if (step.type === "agent") await executeAgentStep(ctx, step);
      else if (step.type === "for_each") await executeForEach(ctx, step);
      else {
        // branch
        const taken = await evaluateGuard(step.if, buildScope(ctx));
        await executeSteps(ctx, taken ? step.then : (step.else ?? []));
      }
    } catch (err) {
      if (err instanceof PauseSignal || err instanceof RunTimeout) throw err;
      const detail = errorMessage(err);
      const strategy =
        step.type === "tool" || step.type === "agent" ? step.onError?.strategy : undefined;
      ctx.records.push({
        id: step.id,
        status: "failed",
        startedAt: ctx.now(),
        finishedAt: ctx.now(),
        error: detail,
        idempotencyKey: `${ctx.input.runId}/${step.id}/0`,
      });
      if (strategy === "continue") continue;
      throw err instanceof StepFailure ? err : new StepFailure(step.id, detail);
    }
  }
}

/** Execute (or resume) one firing of a validated spec. Never throws. */
export async function interpret(input: InterpretInput): Promise<InterpretOutcome> {
  const nowMs = input.nowMs ?? (() => Date.now());
  const now = input.now ?? (() => new Date().toISOString());
  const limitMs =
    input.maxDurationMs ??
    (specHasAgent(input.spec) ? MAX_RUN_MS_WITH_AGENT : MAX_RUN_MS_STEPS);

  const restored = new Map<string, StepRecord>();
  let resumeTarget: ExecContext["resumeTarget"];
  let outputs: Record<string, unknown> = {};
  if (input.resume) {
    const checkpoint = input.resume.checkpoint as Checkpoint;
    for (const record of checkpoint.steps) restored.set(record.id, record);
    outputs = { ...checkpoint.outputs };
    resumeTarget = { stepId: checkpoint.stepId, approved: input.resume.approved };
  }

  const ctx: ExecContext = {
    input: input as ExecContext["input"],
    outputs,
    records: [],
    bindings: {},
    insideLoop: false,
    restored,
    resumeTarget,
    startMs: nowMs(),
    limitMs,
    nowMs,
    now,
    grants: input.grants ?? [],
    parkedActions: [],
  };

  try {
    if (input.spec.execution.mode === "agent") {
      await executeAgenticMode(ctx, input.spec.execution);
    } else {
      await executeSteps(ctx, input.spec.execution.steps);
    }
    return { status: "succeeded", steps: ctx.records, parkedActions: ctx.parkedActions };
  } catch (err) {
    if (err instanceof PauseSignal) {
      const requestedAtMs = nowMs();
      return {
        status: "waiting_approval",
        steps: ctx.records,
        pendingApproval: {
          stepId: err.stepId,
          tool: err.tool,
          inputHash: fnv1a64(canonicalJson(err.resolvedInput)),
          requestedAt: now(),
          expiresAt: new Date(requestedAtMs + PENDING_APPROVAL_TTL_MS).toISOString(),
          checkpoint: {
            stepId: err.stepId,
            tool: err.tool,
            outputs: ctx.outputs,
            steps: ctx.records,
          } satisfies Checkpoint,
        },
        parkedActions: ctx.parkedActions,
      };
    }
    return { status: "failed", steps: ctx.records, error: errorMessage(err), parkedActions: ctx.parkedActions };
  }
}

async function executeAgenticMode(ctx: ExecContext, execution: AgentExecution): Promise<void> {
  const startedAt = ctx.now();
  const runner = ctx.input.agentRunner;
  if (!runner) throw new StepFailure("agent", "no agent runner configured");

  const budget: ToolBudget = { remaining: execution.maxToolCalls };
  const allowlisted: Record<string, RegisteredTool> = {};
  for (const name of execution.tools) {
    const tool = ctx.input.tools[name];
    if (!tool) throw new StepFailure("agent", `allowlisted tool "${name}" is not registered`);
    // Agentic-mode grants are scoped to the spec, not a step (step = null).
    allowlisted[name] = gateAgentTool(ctx, name, tool, null, budget);
  }

  let output: unknown;
  try {
    // Agentic runs see the trigger payload, user claims, and description only.
    output = await runner({
      goal: execution.goal,
      input: {
        trigger: ctx.input.envelope.payload,
        user: ctx.input.user ?? {},
      },
      tools: allowlisted,
      maxToolCalls: execution.maxToolCalls,
      description: ctx.input.spec.description,
    });
  } catch (err) {
    throw new StepFailure("agent", errorMessage(err));
  }
  ctx.outputs["agent"] = { output };
  ctx.records.push({
    id: "agent",
    status: "succeeded",
    startedAt,
    finishedAt: ctx.now(),
    output,
    idempotencyKey: `${ctx.input.runId}/agent/1`,
  });
}
