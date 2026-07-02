/**
 * The automations DSL: zod schema + inferred types.
 *
 * This is the inspectable artifact the compiler agent emits and the interpreter
 * executes (spec: docs/superpowers/specs/2026-07-01-flowlet-automations-proposal.md).
 * The schema is deliberately strict — it is also the INPUT SCHEMA of the
 * `create_automation` tool, so every message here is model-facing correction
 * feedback.
 *
 * Pre-authorization grants are intentionally NOT part of this document: the
 * compiler cannot grant anything. Grants live as version metadata written by
 * the approval flow.
 */
import { z } from "zod";

/** Hard ceilings the compiler cannot raise (spec section a). */
export const MAX_TOTAL_STEPS = 25;
export const MAX_FOR_EACH_ITEMS = 100;
export const MAX_FIRINGS_PER_HOUR = 60;
export const MAX_RETRY_ATTEMPTS = 5;
export const MAX_AGENT_TOOL_CALLS = 25;

/**
 * Names an expression scope already owns. A `for_each.as` binding may not
 * shadow them (spec section a, amendment 2). "item" is NOT reserved for `as`:
 * it is the default binding name itself, so re-stating it is identity, not
 * shadowing (nested loops rebind it lexically, like any language).
 */
export const RESERVED_AS_NAMES = new Set(["trigger", "steps", "run", "user", "index"]);

/**
 * Step ids must be snake_case identifiers: `steps.size-check` parses as
 * subtraction in JSONata, so dashes are forbidden (amendment 1).
 */
const stepId = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "step id must be snake_case ([a-z][a-z0-9_]*); dashes break JSONata references",
  );

/** A JSONata expression (bare, no {{ }} braces). Syntax is validated separately. */
const expression = z.string().min(1);

const onError = z.object({
  strategy: z.enum(["fail", "continue", "retry"]),
  attempts: z
    .number()
    .int()
    .min(1)
    .max(MAX_RETRY_ATTEMPTS)
    .optional()
    .describe("retry attempts (retry strategy only, max 5)"),
});

/**
 * Step input values: any JSON. Strings may interpolate `{{ jsonata }}`; a value
 * that is exactly one `{{ expr }}` resolves to the raw evaluated value.
 */
const inputValue: z.ZodType<unknown> = z.unknown();

const toolStepBase = z.object({
  id: stepId,
  type: z.literal("tool"),
  tool: z.string().min(1).describe("name of a registered tool"),
  input: z.record(inputValue).optional(),
  if: expression.optional(),
  onError: onError.optional(),
});

const agentStepBase = z.object({
  id: stepId,
  type: z.literal("agent"),
  goal: z.string().min(1),
  input: z.record(inputValue).optional(),
  tools: z
    .array(z.string().min(1))
    .describe("tool allowlist; [] = pure judgment, no tool calls"),
  output: z
    .record(z.unknown())
    .optional()
    .describe("JSON Schema the agent's result must match"),
  maxToolCalls: z.number().int().min(1).max(MAX_AGENT_TOOL_CALLS).default(10),
  if: expression.optional(),
  onError: onError.optional(),
});

export type ToolStep = z.infer<typeof toolStepBase>;
export type AgentStep = z.infer<typeof agentStepBase>;

export interface BranchStep {
  id: string;
  type: "branch";
  if: string;
  then: AutomationStep[];
  else?: AutomationStep[] | undefined;
}

export interface ForEachStep {
  id: string;
  type: "for_each";
  items: string;
  as: string;
  maxItems: number;
  steps: AutomationStep[];
  if?: string | undefined;
}

export type AutomationStep = ToolStep | AgentStep | BranchStep | ForEachStep;

// Recursive: branch/for_each contain child step lists. zod v3 cannot infer a
// recursive union, so `step` carries one contained cast; the object schemas
// below stay uncast and enforce the real shapes.
const step = z.lazy(() =>
  z.union([toolStepBase, agentStepBase, branchStepSchema, forEachStepSchema]),
) as unknown as z.ZodType<AutomationStep, z.ZodTypeDef, unknown>;

const branchStepSchema = z.object({
  id: stepId,
  type: z.literal("branch"),
  if: expression,
  then: z.array(step).min(1),
  else: z.array(step).min(1).optional(),
});

const forEachStepSchema = z.object({
  id: stepId,
  type: z.literal("for_each"),
  items: z
    .string()
    .min(1)
    .describe("expression producing the array to iterate, e.g. {{ steps.fetch.output.rows }}"),
  as: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .default("item"),
  maxItems: z.number().int().min(1).max(MAX_FOR_EACH_ITEMS).default(MAX_FOR_EACH_ITEMS),
  steps: z.array(step).min(1),
  if: expression.optional(),
});

const scheduleTrigger = z
  .object({
    type: z.literal("schedule"),
    cron: z.string().min(1).optional(),
    timezone: z.string().min(1).optional().describe("IANA timezone, required with cron"),
    at: z.string().datetime({ offset: true }).optional().describe("one-shot ISO timestamp"),
  })
  .superRefine((t, ctx) => {
    if (t.cron !== undefined && t.at !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "schedule trigger takes either cron or at, not both",
      });
    }
    if (t.cron === undefined && t.at === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "schedule trigger requires cron (with timezone) or at",
      });
    }
    if (t.cron !== undefined && t.timezone === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cron schedules require an IANA timezone",
      });
    }
  });

const hostEventTrigger = z.object({
  type: z.literal("host_event"),
  event: z.string().min(1).describe("host event type declared in the manifest"),
});

const composioTrigger = z.object({
  type: z.literal("composio"),
  trigger: z.string().min(1).describe("Composio trigger slug"),
  config: z.record(z.unknown()).optional(),
});

export const triggerSchema = z.union([scheduleTrigger, hostEventTrigger, composioTrigger]);
export type AutomationTrigger = z.infer<typeof triggerSchema>;

const stepsExecution = z.object({
  mode: z.literal("steps"),
  steps: z.array(step).min(1),
});

const agentExecution = z.object({
  mode: z.literal("agent"),
  goal: z.string().min(1),
  tools: z
    .array(z.string().min(1))
    .min(1, "fully agentic automations need a non-empty tool allowlist"),
  maxToolCalls: z.number().int().min(1).max(MAX_AGENT_TOOL_CALLS).default(15),
});

export type StepsExecution = z.infer<typeof stepsExecution>;
export type AgentExecution = z.infer<typeof agentExecution>;

/** Walk a step tree depth-first, visiting every node. */
export function walkSteps(
  steps: readonly AutomationStep[],
  visit: (step: AutomationStep) => void,
): void {
  for (const s of steps) {
    visit(s);
    if (s.type === "branch") {
      walkSteps(s.then, visit);
      if (s.else) walkSteps(s.else, visit);
    } else if (s.type === "for_each") {
      walkSteps(s.steps, visit);
    }
  }
}

export const automationSpecSchema = z
  .object({
    dslVersion: z.literal(1),
    name: z.string().min(1).max(120),
    description: z.string().min(1),
    prompt: z.string().min(1).describe("the user's original plain-English ask, verbatim"),
    trigger: triggerSchema,
    if: expression.optional().describe("guard; false at firing time records the run as skipped"),
    execution: z.discriminatedUnion("mode", [stepsExecution, agentExecution]),
    limits: z
      .object({
        maxFiringsPerHour: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIRINGS_PER_HOUR)
          .default(MAX_FIRINGS_PER_HOUR),
      })
      .default({ maxFiringsPerHour: MAX_FIRINGS_PER_HOUR }),
  })
  .superRefine((spec, ctx) => {
    if (spec.execution.mode !== "steps") return;

    const seen = new Set<string>();
    let total = 0;
    walkSteps(spec.execution.steps, (s) => {
      total += 1;
      if (seen.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step id "${s.id}" — ids must be unique across the whole tree`,
        });
      }
      seen.add(s.id);
      if (s.type === "for_each" && RESERVED_AS_NAMES.has(s.as)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `for_each "as" may not shadow reserved scope name "${s.as}"`,
        });
      }
      if (s.type !== "branch" && s.type !== "for_each" && s.onError?.strategy !== "retry" && s.onError?.attempts !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${s.id}": onError.attempts is only valid with strategy "retry"`,
        });
      }
    });
    if (total > MAX_TOTAL_STEPS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `spec has ${total} steps; the ceiling is ${MAX_TOTAL_STEPS}`,
      });
    }
  });

export type AutomationSpec = z.infer<typeof automationSpecSchema>;
