import jsonata from "jsonata";
import {
  canonicalJson,
  sha256Hex,
  type Json,
  type RiskLabel,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { CompoundTool } from "../formats.js";
import { error, isArgsObject } from "./outcome.js";
import { walkSteps, type StepResumePoint } from "./steps.js";

/**
 * Compound tools (04-actions §6): load-time validation with quarantine and the
 * execution path that routes EVERY step back through the guard-bound registry
 * via the umbrella-wired `invokeTool` seam. There is no second execution path:
 * without the seam a compound performs no work at all.
 */

const RISK_ORDER: Record<RiskLabel, number> = { read: 0, write: 1, destructive: 2 };

/** What a compound step may target: a registered primitive host/connector tool. */
export interface PrimitiveStepTarget {
  risk: RiskLabel;
  disabled?: boolean;
}

export interface CapabilityIssue {
  tool: string;
  message: string;
}

/**
 * Semantic validation shared by the load path (registry quarantine) and the
 * write path (`vendo refine`, ENG-250): steps must reference enabled primitive
 * host/connector tools only, and the declared risk must equal the max of the
 * step risks — both computed POST-override-merge by the caller.
 *
 * `primitives` maps tool name → post-merge risk/disabled for host + connector
 * tools ONLY (never compounds, never `add()`-registry capability tools).
 */
export function validateCapabilities(
  file: { tools: CompoundTool[] },
  primitives: ReadonlyMap<string, PrimitiveStepTarget>,
): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  const compoundNames = new Set(file.tools.map((tool) => tool.name));
  for (const tool of file.tools) {
    let stepsValid = true;
    let maxRisk: RiskLabel = "read";
    for (const step of tool.binding.steps) {
      if (step.tool.startsWith("fn:")) {
        issues.push({ tool: tool.name, message: `step ${step.id} references ${step.tool}; fn: capability tools cannot be compound steps` });
        stepsValid = false;
        continue;
      }
      if (compoundNames.has(step.tool)) {
        issues.push({ tool: tool.name, message: `step ${step.id} references compound ${step.tool}; compound steps must be primitive host/connector tools` });
        stepsValid = false;
        continue;
      }
      const target = primitives.get(step.tool);
      if (target === undefined) {
        issues.push({ tool: tool.name, message: `step ${step.id} references unknown or non-primitive tool ${step.tool}` });
        stepsValid = false;
        continue;
      }
      if (target.disabled === true) {
        issues.push({ tool: tool.name, message: `step ${step.id} references disabled tool ${step.tool}` });
        stepsValid = false;
        continue;
      }
      if (RISK_ORDER[target.risk] > RISK_ORDER[maxRisk]) maxRisk = target.risk;
    }
    if (stepsValid && tool.risk !== maxRisk) {
      issues.push({
        tool: tool.name,
        message: `declared risk "${tool.risk}" must equal the max of step risks ("${maxRisk}") — 04-actions §6`,
      });
    }
  }
  return issues;
}

/** Everything except `grant` passes through: guard re-decides each step in the
 * true context, and a compound-level grant must never ride into a step's actAs. */
const stripGrant = (ctx: RunContext): RunContext => {
  const { grant: _grant, ...rest } = ctx as RunContext & { grant?: unknown };
  return rest as RunContext;
};

interface ResumeEntry {
  argsHash: string;
  resume: StepResumePoint;
  at: number;
}

const RESUME_MAX_ENTRIES = 1000;
const RESUME_TTL_MS = 60 * 60 * 1000;

export interface CompoundExecutor {
  execute(tool: CompoundTool, call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}

/**
 * One executor per createActions closure (never module-global: resume state is
 * scoped to a registry instance). Resume state is in-memory and single-process
 * — the stated v0 durability model (same assumption as guard's AsyncLock): a
 * restart re-walks the compound from step 0 on re-execution.
 */
export function createCompoundExecutor(options: {
  /** The live RegistryConfig slice — `invokeTool` is read at EXECUTION time so the umbrella can wire it after `guard.bind`. */
  config: { invokeTool?: ToolRegistry["execute"] };
  /** Defense in depth: re-checks against the CURRENT load that a step target is still a primitive host/connector tool. */
  isPrimitive(name: string): Promise<boolean>;
}): CompoundExecutor {
  const entries = new Map<string, ResumeEntry>();
  // Compiled-expression cache: expressions come from the static, schema-capped
  // capabilities file, so the population is bounded; parsing is the expensive
  // part of jsonata and forEach walks would otherwise re-parse per iteration.
  const compiled = new Map<string, ReturnType<typeof jsonata>>();

  const compile = (expression: string): ReturnType<typeof jsonata> => {
    let parsed = compiled.get(expression);
    if (parsed === undefined) {
      parsed = jsonata(expression);
      compiled.set(expression, parsed);
    }
    return parsed;
  };

  const sweep = (now: number): void => {
    // Entries are refreshed by delete-then-set, so Map order is oldest-touched
    // first: stop at the first fresh entry instead of scanning the whole map.
    for (const [key, entry] of entries) {
      if (now - entry.at <= RESUME_TTL_MS) break;
      entries.delete(key);
    }
  };

  return {
    async execute(tool: CompoundTool, call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const invokeTool = options.config.invokeTool;
      if (invokeTool === undefined) {
        // 04 §6: absent seam → not-implemented, NO work performed.
        return error(
          "not-implemented",
          `compound tools require the guard-bound invokeTool seam (createVendo wires it); ${call.tool} performed no work`,
        );
      }
      if (!isArgsObject(call.args)) return error("validation", `Arguments for ${call.tool} must be an object`);

      const now = Date.now();
      sweep(now);
      // The same logical call = same subject, same session, same COMPOUND, same
      // call id, same args. The tool name is part of the key so a different
      // compound reusing a call id can never hijack another compound's parked
      // resume point (and replay its approved step against the wrong steps array).
      const key = `${ctx.principal.subject}|${ctx.sessionId}|${call.tool}|${call.id}`;
      const existing = entries.get(key);
      const argsHash = existing === undefined ? undefined : sha256Hex(canonicalJson(call.args));
      const resumeFrom = existing !== undefined && existing.argsHash === argsHash ? existing.resume : undefined;
      if (existing !== undefined && resumeFrom === undefined) entries.delete(key);

      const stepCtx = stripGrant(ctx);
      const result = await walkSteps({
        steps: tool.binding.steps,
        root: { args: call.args },
        evaluate: async (expression, context) => await compile(expression).evaluate(context) as Json,
        newCallId: () => `call_${globalThis.crypto.randomUUID()}`,
        invoke: async (stepCall) => {
          // Re-check the target kind before EVERY invoke: a post-load `add()`
          // must never let a compound reach a non-primitive tool.
          if (!await options.isPrimitive(stepCall.tool)) {
            return error("validation", `compound step tool ${stepCall.tool} is not an enabled primitive host/connector tool`);
          }
          return invokeTool(stepCall, stepCtx);
        },
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
      });

      if (result.status === "parked") {
        // delete-then-set is load-bearing: Map.set on an existing key keeps its
        // ORIGINAL position, so the delete is what refreshes insertion order
        // (oldest-first) for both the TTL sweep and the LRU eviction below.
        entries.delete(key);
        entries.set(key, { argsHash: argsHash ?? sha256Hex(canonicalJson(call.args)), resume: result.resume, at: now });
        while (entries.size > RESUME_MAX_ENTRIES) {
          const oldest = entries.keys().next().value as string;
          entries.delete(oldest);
        }
        return { status: "pending-approval", approvalId: result.approvalId };
      }

      entries.delete(key);
      if (result.status === "halted") return result.outcome;
      return { status: "ok", output: { steps: result.stepOutputs } };
    },
  };
}
