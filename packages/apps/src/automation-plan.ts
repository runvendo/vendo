import {
  describeShapeWithSemantics,
  triggerSchema,
  type ShapeType,
  type Trigger,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { Cron } from "croner";
import { distinctIssues, type HostToolInfo } from "./engine.js";

/**
 * execution-v2 Wave 9 — the escalation ladder's automation authoring: ONE
 * structured model call turns a server-shaped instruction into a Trigger the
 * EXISTING automations engine runs (07-automations), plus the results
 * collection the tree binds. No new automation machinery — the plan is just
 * the document fields (`trigger`, a `storage` declaration) the engine already
 * consumes; setup completes in seconds because no machine is involved.
 */

export interface AutomationPlanInput {
  appId: string;
  appName: string;
  instruction: string;
  /** The judge's rung: (a) steps or (b) agentic (see engine.serverWorkRung). */
  mode: "steps" | "agentic";
  /** The tools steps may name / the agentic prompt may reference — the SAME
   *  guard-bound surface the automations engine executes through. */
  tools: readonly HostToolInfo[];
  /** Sampled result shapes (the engine's shape cards, keyed by tool name):
   *  without them the model guesses output fields and the jsonata reads
   *  nothing (the live-gate "steps.unpaid.items" class). */
  toolShapes?: Readonly<Record<string, ShapeType>>;
}

export interface AutomationPlan {
  trigger: Trigger;
  name?: string;
  /** The app records collection the automation writes displayable results
   *  into (the store rows the tree queries via vendo_apps_data_list). */
  resultsCollection?: string;
}

export type AutomationPlanResult =
  | { kind: "plan"; plan: AutomationPlan }
  | { kind: "failure"; issues: string[] };

const RESULTS_TOOL = "vendo_apps_data_put";
const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,40}$/i;
const EVERY_DURATION = /^(\d+)[smhd]$/;

/** The planning surface: host + connected tools, plus ONLY the results-publish
 *  tool from the vendo_apps_* family — an automation's job is host effects and
 *  one published result, never app lifecycle operations (and live data comes
 *  from host tools, not from reading app data collections). */
const plannerTools = (tools: readonly HostToolInfo[]): HostToolInfo[] =>
  tools.filter((tool) => !tool.name.startsWith("vendo_apps_") || tool.name === RESULTS_TOOL);

const toolLine = (
  { name, description, risk, inputSchema }: HostToolInfo,
  shape: ShapeType | undefined,
): string => {
  const properties = inputSchema?.properties;
  const fields = typeof properties === "object" && properties !== null
    ? Object.keys(properties as Record<string, unknown>)
    : [];
  return `- ${name} [${risk}]${fields.length === 0 ? "" : ` (input fields: ${fields.join(", ")})`}: ${description}${shape === undefined ? "" : `\n  result shape: ${describeShapeWithSemantics(shape, {})}`}`;
};

const stepsContract = (input: AutomationPlanInput): string => `RUN MODEL (this instruction is DETERMINISTIC tool work):
"run" is {"kind":"steps","steps":[{"id":"<bare identifier>","tool":"<tool name>","args":{...}?,"if":"<jsonata>"?,"forEach":"<jsonata>"?}, ...]}.
- Every step's "tool" MUST be a name from the TOOLS list; anything else is invalid. Steps run in order.
- Choose tools that FULFILL the instruction: read live data with the host/connected READ tools (live data NEVER comes from "${RESULTS_TOOL}"-style app collections), and perform each requested effect (email, message, notify, create) with a matching tool from the list when one exists. When no tool can perform a requested effect, skip that effect — the published result still lands on the board.
- EVERY value inside "args" is a JSON STRING containing a JSONATA expression evaluated against {event, steps, item} — never a bare number, boolean, object, or array. A prior step's output is "steps.<stepId>...". A literal string is single-quoted INSIDE the string ("'like this'"); a literal number is written as its expression ("20"); an object is built in jsonata ("{\\"count\\": $count(steps.rows.items)}").
- "if" skips the step unless the jsonata expression is truthy. "forEach" is a jsonata expression producing an array; the step runs once per element with that element bound to item (max 1000).
- RESULTS: the app's board reads STORE ROWS, not run logs. The LAST step MUST persist the displayable result through tool "${RESULTS_TOOL}" with args {"appId":"'${input.appId}'","collection":"'<collection>'","id":"'latest'","data":"<jsonata for the displayable result>"} — and set the top-level "resultsCollection" to that collection name.
EXAMPLE (shape only — use the real tools and the real request):
{"name":"Morning digest","trigger":{"on":{"kind":"schedule","cron":"0 8 * * *"},"run":{"kind":"steps","steps":[{"id":"rows","tool":"host_list_things"},{"id":"notify","tool":"host_send_message","args":{"subject":"'Daily digest'","body":"$string($count(steps.rows.items)) & ' items today'"}},{"id":"publish","tool":"${RESULTS_TOOL}","args":{"appId":"'${input.appId}'","collection":"'digest'","id":"'latest'","data":"steps.rows"}}]}},"resultsCollection":"digest"}`;

const agenticContract = (input: AutomationPlanInput): string => `RUN MODEL (this instruction needs PER-RUN JUDGMENT):
"run" is {"kind":"agentic","prompt":"<the instructions an away agent follows on every firing>","budget":{"maxToolCalls":<n>}?}.
- The prompt must be self-contained (the agent sees only it plus the tools), name the tools to use from the TOOLS list, and state the judgment to exercise each run.
- RESULTS: when the app's board should show the outcome, the prompt must ALSO instruct the agent to persist the displayable result through tool "${RESULTS_TOOL}" with appId "${input.appId}", a stable collection, and id "latest" — and set the top-level "resultsCollection" to that collection name.`;

const planContract = (input: AutomationPlanInput): string => `You are the Vendo automation planner. Return ONLY one JSON object — no prose, no markdown fences.
Shape: {"name":"<short automation name>","trigger":{"on":<trigger source>,"run":<run model>},"resultsCollection":"<records collection>"?}

TRIGGER SOURCE "on" (exactly one form):
- {"kind":"schedule","cron":"<5-field cron, UTC>"} for clock times (e.g. daily 8am = "0 8 * * *"),
- {"kind":"schedule","every":"<n><s|m|h|d>"} for plain intervals,
- {"kind":"schedule","at":"<ISO date-time>"} for a one-shot,
- {"kind":"host-event","event":"<event name>"} ONLY when the instruction reacts to a named host product event.
External webhook connectors are NOT available to this planner.

${input.mode === "steps" ? stepsContract(input) : agenticContract(input)}

TOOLS (the ONLY tools available). Where a "result shape" is shown, a jsonata expression may reference ONLY those fields (steps.<id>.<field>); when a tool has no shape shown, pass its WHOLE output along (steps.<id>) instead of guessing field names:
${plannerTools(input.tools).map((tool) => toolLine(tool, input.toolShapes?.[tool.name])).join("\n") || "(none)"}`;

const repairPrompt = (issues: string[]): string =>
  issues.length === 0 ? "" : `\nREPAIR_THESE_ISSUES: ${JSON.stringify(issues)}`;

/** Models wrap JSON in prose/fences despite instructions — take the outermost
 *  object deterministically (same tolerance class as engine.extractWire). */
const extractJson = (text: string): string => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? text : text.slice(start, end + 1);
};

const generatePlanText = async (
  model: LanguageModel,
  system: string,
  prompt: string,
): Promise<{ text?: string; issues: string[] }> => {
  try {
    const { streamText } = await import("ai");
    const result = streamText({ model, system, prompt, temperature: 0, maxRetries: 0 });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    return { text, issues: [] };
  } catch (error) {
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
};

/** The same schedule constraints the automations engine enforces at
 *  validateTrigger — checked HERE so an unfireable trigger is repaired at
 *  authoring time instead of silently never firing on the tick. */
const scheduleIssues = (trigger: Trigger): string[] => {
  if (trigger.on.kind !== "schedule") return [];
  const issues: string[] = [];
  if (trigger.on.every !== undefined && !EVERY_DURATION.test(trigger.on.every)) {
    issues.push('schedule "every" must match <n><s|m|h|d> with n > 0');
  }
  if (trigger.on.cron !== undefined) {
    if (trigger.on.cron.trim().split(/\s+/).length !== 5) {
      issues.push('schedule "cron" must contain exactly 5 fields');
    } else {
      try {
        new Cron(trigger.on.cron, { timezone: "UTC", paused: true });
      } catch (error) {
        issues.push(`invalid schedule cron: ${error instanceof Error ? error.message : "unparseable"}`);
      }
    }
  }
  if (trigger.on.at !== undefined && !Number.isFinite(Date.parse(trigger.on.at))) {
    issues.push('schedule "at" must be an ISO date-time');
  }
  return issues;
};

const validatePlan = (
  raw: string,
  input: AutomationPlanInput,
): { plan?: AutomationPlan; issues: string[] } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (error) {
    return { issues: [`the response was not a single valid JSON object (${error instanceof Error ? error.message.split("\n")[0] : "parse error"}) — return ONLY the JSON object, no prose or fences`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { issues: ["the response must be one JSON object"] };
  }
  const candidate = parsed as { name?: unknown; trigger?: unknown; resultsCollection?: unknown };
  const issues: string[] = [];
  const triggerResult = triggerSchema.safeParse(candidate.trigger);
  if (!triggerResult.success) {
    const first = triggerResult.error.issues[0];
    const at = first === undefined || first.path.length === 0 ? "" : ` at trigger.${first.path.join(".")}`;
    return { issues: [`invalid trigger${at}: ${first?.message ?? "does not match the trigger schema"} — remember every steps args value is a JSON STRING containing a jsonata expression`] };
  }
  const trigger = triggerResult.data;
  if (trigger.on.kind === "external") {
    issues.push('trigger "on" cannot be an external connector here — use a schedule or a host-event');
  }
  issues.push(...scheduleIssues(trigger));
  if (trigger.run.kind !== input.mode) {
    issues.push(`run.kind must be "${input.mode}" for this instruction`);
  }
  if (trigger.run.kind === "steps") {
    const steps = trigger.run.steps;
    if (steps.length === 0) issues.push("steps must not be empty");
    const known = new Set(plannerTools(input.tools).map(({ name }) => name));
    const seen = new Set<string>();
    for (const step of steps) {
      if (step.id.trim() === "" || seen.has(step.id)) {
        issues.push(`step ids must be non-empty and unique ("${step.id}")`);
      }
      seen.add(step.id);
      if (!step.tool.startsWith("fn:") && !known.has(step.tool)) {
        issues.push(`step "${step.id}" names unknown tool "${step.tool}"; the available tools are: ${[...known].join(", ") || "(none)"}`);
      }
      // Law 1 for automations: a published result must be BUILT from a prior
      // step's output (or the trigger event) — a hand-typed data payload is
      // invented data on the board.
      if (step.tool === RESULTS_TOOL) {
        const dataExpression = step.args?.data ?? "";
        if (!/\b(steps|event)\b/.test(dataExpression)) {
          issues.push(`step "${step.id}" publishes hand-typed data — the "${RESULTS_TOOL}" data expression must derive from a prior step's output (steps.<id>...) or the trigger event; add the read step that fetches the live data first`);
        }
      }
    }
  }
  const resultsCollection = candidate.resultsCollection;
  if (resultsCollection !== undefined) {
    if (typeof resultsCollection !== "string" || !COLLECTION_NAME.test(resultsCollection) || resultsCollection === "state") {
      issues.push('resultsCollection must be a short bare identifier (and never the reserved "state")');
    }
  }
  const name = candidate.name;
  if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > 80)) {
    issues.push("name must be a non-empty string of at most 80 characters");
  }
  if (issues.length > 0) return { issues };
  return {
    plan: {
      trigger,
      ...(typeof name === "string" ? { name: name.trim() } : {}),
      ...(typeof resultsCollection === "string" ? { resultsCollection } : {}),
    },
    issues: [],
  };
};

/** Author the automation for one ladder rung: up to 3 model attempts, each
 *  repair fed the accumulated issues (the engine's create/edit loop shape). */
export const planAutomation = async (
  input: AutomationPlanInput,
  model: LanguageModel,
): Promise<AutomationPlanResult> => {
  let issues: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const output = await generatePlanText(
      model,
      planContract(input),
      `TASK: PLAN_AUTOMATION\nAPP_ID: ${input.appId}\nAPP_NAME: ${input.appName}\nINSTRUCTION: ${input.instruction}${repairPrompt(issues)}`,
    );
    issues = distinctIssues(issues, output.issues);
    if (output.text === undefined) continue;
    const validated = validatePlan(output.text, input);
    if (validated.plan !== undefined) return { kind: "plan", plan: validated.plan };
    issues = distinctIssues(issues, validated.issues);
  }
  return { kind: "failure", issues: issues.length === 0 ? ["automation planning failed"] : issues };
};
