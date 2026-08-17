import {
  automationTaskSchema,
  describeShapeWithSemantics,
  inputSchemaIsBlind,
  isVendoAppsTool,
  safeErrorMessage,
  toTriggerSource,
  withheldFromUnattended,
  UNATTENDED_DESTRUCTIVE_REASON,
  UNKNOWN_INPUT_SCHEMA_NOTE,
  UNKNOWN_OUTPUT_SHAPE_NOTE,
  type AutomationId,
  type AutomationRecord,
  type AutomationTask,
  type ShapeType,
  type Step,
  type When,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { askModel, distinctIssues, type HostToolInfo } from "../generation/engine.js";
import { whenSays } from "../doors/automate-tool.js";

/**
 * The automation door's authoring: ONE structured model call turns a
 * plain-language ask into the `when` and the `task` of an automation RECORD,
 * plus the results collection the app's tree binds. No new automation machinery
 * — the record is created through the one create operation the engine exposes,
 * and setup completes in seconds because no machine is involved.
 */

export interface AutomationPlanInput {
  appId: string;
  appName: string;
  instruction: string;
  /** How the automation runs: deterministic `steps`, or a `goal` when each
   *  firing needs a model's judgment. It IS the task kind the plan must answer
   *  with — one vocabulary, no translation. */
  mode: AutomationTask["kind"];
  /** The tools steps may name / the goal's prompt may reference — the SAME
   *  guard-bound surface the automations engine executes through. */
  tools: readonly HostToolInfo[];
  /** The tools' DECLARED result shapes, keyed by tool name: without them the
   *  model guesses output fields and the jsonata reads nothing (the live-gate
   *  "steps.unpaid.items" class). */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /**
   * The automations this app's own list ALREADY names, resolved.
   *
   * An app's list holds many, so "check every morning too" adds one while "move
   * the digest to 9am" changes one, and only something reading the request
   * against the list can tell those apart. This is what lets the plan answer
   * with {@link AutomationPlan.replaces}; without it every re-plan of an
   * existing automation would land beside itself as a duplicate.
   */
  existing?: readonly AutomationRecord[];
}

export interface AutomationPlan {
  /** WHEN it fires, in the SAME authoring vocabulary `.on()` and the chat tool
   *  speak — core's `toTriggerSource` is the one thing that normalizes it. */
  when: When;
  /** WHAT it does. */
  task: AutomationTask;
  /** The automation's own name, the way the person would say it out loud. */
  name?: string;
  /** The app records collection the automation writes displayable results
   *  into (the store rows the tree queries via vendo_apps_data_list). */
  resultsCollection?: string;
  /** The id of the EXISTING automation this plan is a new version of — set only
   *  when the instruction changed one of {@link AutomationPlanInput.existing}
   *  rather than asking for another. Absent means a new record beside them. */
  replaces?: AutomationId;
}

export type AutomationPlanResult =
  | { kind: "plan"; plan: AutomationPlan }
  | { kind: "failure"; issues: string[] };

const RESULTS_TOOL = "vendo_apps_data_put";
const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,40}$/i;

/**
 * §12's law at authoring time: is this a thing Vendo will not do while nobody is
 * watching?
 *
 * The predicate is core's own `withheldFromUnattended` — the SAME one the run's
 * projection uses — so authoring and firing cannot disagree about what may never
 * happen away: a declared `destructive`, and an `ungraded` tool, because nothing
 * has said what that one does either.
 *
 * It asks the DECLARED grade and nothing else (#791 — "the dev's label is
 * final"; nothing anywhere concludes anything from a tool's name). So a
 * mislabelled send tool reaches the planner exactly as it reaches the run, and
 * grading the catalog (`vendo sync`, `.vendo/overrides.json`) is the only thing
 * that stops it.
 */
const irreversible = (tool: HostToolInfo): boolean =>
  withheldFromUnattended({
    name: tool.name,
    description: tool.description,
    inputSchema: {},
    risk: (tool.risk === "read" || tool.risk === "write" || tool.risk === "destructive"
      ? tool.risk
      : "ungraded"),
  });

/** The planning surface: host + connected tools, plus ONLY the results-publish
 *  tool from the apps family — an automation's job is host effects and one
 *  published result, never app lifecycle operations (and live data comes from
 *  host tools, not from reading app data collections). Through the predicate,
 *  not the prefix: `vendo_make` sits outside `vendo_apps_`, and a plan able to
 *  call it could have every firing build itself another app.
 *
 *  Irreversible tools are withheld here for the reason `projectableForRun`
 *  withholds them from the run itself: a tool the model cannot see is a tool it
 *  cannot be talked into using, while one it can see but is refused becomes
 *  something it works around. {@link refusal} is the defence in depth behind
 *  this filter. */
const plannerTools = (tools: readonly HostToolInfo[]): HostToolInfo[] =>
  tools.filter((tool) =>
    (!isVendoAppsTool(tool.name) || tool.name === RESULTS_TOOL)
    && !irreversible(tool));

/** The refusal, in the person's words: why it will never happen away, and the
 *  version that CAN. It doubles as the repair instruction, because `issues` is
 *  exactly what the next attempt is asked to fix — so a request that is PARTLY
 *  away-safe comes back as the read-and-publish half rather than as nothing. */
const refusal = (where: string, tool: string): string =>
  `${where} uses "${tool}". ${UNATTENDED_DESTRUCTIVE_REASON} Author the part that can run away — read the live data and publish the result to the board — and leave "${tool}" out; the person does that themselves, on demand, from the app.`;

export const toolLine = (
  { name, description, risk, inputSchema }: HostToolInfo,
  shape: ShapeType | undefined,
): string => {
  const properties = inputSchema?.properties;
  const fields = typeof properties === "object" && properties !== null
    ? Object.keys(properties as Record<string, unknown>)
    : [];
  // Three states, never two: named arguments, a DECLARED empty argument list,
  // and a slot nothing could read. Collapsing the last two into `()` tells the
  // planner a tool takes nothing when in truth nobody knows what it takes.
  const input = inputSchemaIsBlind(inputSchema)
    ? ` (${UNKNOWN_INPUT_SCHEMA_NOTE})`
    : fields.length === 0
      ? " (takes no arguments)"
      : ` (input fields: ${fields.join(", ")})`;
  const result = shape === undefined
    ? UNKNOWN_OUTPUT_SHAPE_NOTE
    : `result shape: ${describeShapeWithSemantics(shape, {})}`;
  return `- ${name} [${risk}]${input}: ${description}\n  ${result}`;
};

const stepsContract = (input: AutomationPlanInput): string => `TASK MODEL (this instruction is DETERMINISTIC tool work):
"task" is {"kind":"steps","steps":[{"id":"<bare identifier>","tool":"<tool name>","args":{...}?,"if":"<jsonata>"?,"forEach":"<jsonata>"?}, ...]}.
- Every step's "tool" MUST be a name from the TOOLS list; anything else is invalid. Steps run in order.
- Choose tools that FULFILL the instruction: read live data with the host/connected READ tools (live data NEVER comes from "${RESULTS_TOOL}"-style app collections), and make the changes it asks for with the write tools in the list.
- NOTHING IRREVERSIBLE RUNS AWAY. Sending, messaging, paying and deleting are not in the TOOLS list and never will be: Vendo does not do a thing it cannot take back while nobody is watching. Author the part that CAN run unattended — read, decide, publish the result — and leave the irreversible part out. The person does that part themselves, on demand, from the app.
- EVERY value inside "args" is a JSON STRING containing a JSONATA expression evaluated against {event, steps, item} — never a bare number, boolean, object, or array. A prior step's output is "steps.<stepId>...". A literal string is single-quoted INSIDE the string ("'like this'"); a literal number is written as its expression ("20"); an object is built in jsonata ("{\\"count\\": $count(steps.rows.items)}").
- "if" skips the step unless the jsonata expression is truthy. "forEach" is a jsonata expression producing an array; the step runs once per element with that element bound to item (max 1000).
- RESULTS: the app's board reads STORE ROWS, not run logs. The LAST step MUST persist the displayable result through tool "${RESULTS_TOOL}" with args {"appId":"'${input.appId}'","collection":"'<collection>'","id":"'latest'","data":"<jsonata for the displayable result>"} — and set the top-level "resultsCollection" to that collection name.
EXAMPLE (shape only — use the real tools and the real request):
{"name":"Morning digest","when":"0 8 * * *","task":{"kind":"steps","steps":[{"id":"rows","tool":"host_list_things"},{"id":"summary","tool":"host_things_summarize","args":{"count":"$count(steps.rows.items)"}},{"id":"publish","tool":"${RESULTS_TOOL}","args":{"appId":"'${input.appId}'","collection":"'digest'","id":"'latest'","data":"steps.rows"}}]},"resultsCollection":"digest"}`;

const goalContract = (input: AutomationPlanInput): string => `TASK MODEL (this instruction needs PER-RUN JUDGMENT):
"task" is {"kind":"goal","prompt":"<the instructions an away agent follows on every firing>","budget":{"maxToolCalls":<n>}?}.
- The prompt must be self-contained (the agent sees only it plus the tools), name the tools to use from the TOOLS list, and state the judgment to exercise each run.
- NOTHING IRREVERSIBLE RUNS AWAY. The tools that send, message, pay or delete are not in the TOOLS list, so the prompt must not ask for them: Vendo does not do a thing it cannot take back while nobody is watching. Have the agent read, judge, and publish what it found; the person acts on it themselves, on demand.
- RESULTS: when the app's board should show the outcome, the prompt must ALSO instruct the agent to persist the displayable result through tool "${RESULTS_TOOL}" with appId "${input.appId}", a stable collection, and id "latest" — and set the top-level "resultsCollection" to that collection name.`;

/** One line per automation the app's list already names. */
const existingLine = ({ id, when, task }: AutomationRecord): string =>
  `- ${id}: ${whenSays(when)} — ${task.kind}`;

/** What this app already runs, and how to say "this is a new version of THAT
 *  one". An app names a LIST of automations, so a plan that cannot point at an
 *  existing one can only ever land beside it — which is how "move the digest to
 *  9am" would become a second digest. */
const existingSection = (input: AutomationPlanInput): string => {
  const existing = input.existing ?? [];
  if (existing.length === 0) return "";
  return `
THIS APP'S AUTOMATIONS ALREADY:
${existing.map(existingLine).join("\n")}
When the INSTRUCTION changes one of THOSE rather than asking for another one, set "replaces" to its id and author the whole automation again as it should now be. Leave "replaces" out for a new automation — it lands beside them and none of them is touched. WHEN IN DOUBT, LEAVE IT OUT: an extra automation is something the person can delete, and one you replaced is one they cannot get back. An instruction that says "also", "another" or "as well" is always a new one.
`;
};

const planContract = (input: AutomationPlanInput): string => `You are the Vendo automation planner. Return ONLY one JSON object — no prose, no markdown fences.
Shape: {"name":"<short automation name>","when":<when>,"task":<task model>,"resultsCollection":"<records collection>"?,"replaces":"<existing automation id>"?}
${existingSection(input)}
"when" (exactly one form):
- "<5-field cron, UTC>" — a bare STRING, for clock times (e.g. daily 8am = "0 8 * * *"). Plain English ("every monday") is refused.
- {"every":"<n><s|m|h|d>"} for plain intervals,
- {"at":"<ISO date-time>"} for a one-shot,
- {"event":"<event name>"} ONLY when the instruction reacts to a named host product event.
External webhook connectors are NOT available to this planner.

${input.mode === "steps" ? stepsContract(input) : goalContract(input)}

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

/**
 * `when`, through the ONE converter every authoring door runs (core's
 * `toTriggerSource`), so a schedule nobody can run is repaired HERE instead of
 * silently never firing on the tick. Its refusal already carries what was wrong,
 * why, the nearest valid cron and the docs URL — which is exactly what the
 * repair round is fed.
 */
const readWhen = (value: unknown): { when?: When; issues: string[] } => {
  if (typeof value !== "string"
    && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return { issues: ['"when" must be a cron string, or one of {"every"}, {"at"}, {"event"}'] };
  }
  const when = value as When;
  try {
    const source = toTriggerSource(when);
    if (source.kind === "external") {
      return { issues: ['"when" cannot be a webhook connector here — use a schedule or a host event'] };
    }
    return { when, issues: [] };
  } catch (error) {
    return { issues: [safeErrorMessage(error)] };
  }
};

/** Everything a `steps` task has to satisfy beyond the schema: referable step
 *  ids, a tool universe the planner could actually see, §12's defence in depth
 *  per step, and a published result that derives from live data and lands in the
 *  collection the plan declared. */
const stepsIssues = (
  steps: readonly Step[],
  input: AutomationPlanInput,
  refused: ReadonlySet<string>,
  resultsCollection: unknown,
): string[] => {
  const issues: string[] = [];
  if (steps.length === 0) issues.push("steps must not be empty");
  // The planning surface is the whole legal tool universe here: fn: refs
  // are NOT accepted — the door only authors automations for machine-less
  // apps, and a machine-less app has no fn: to call.
  const known = new Set(plannerTools(input.tools).map(({ name }) => name));
  const seen = new Set<string>();
  const priorIds = new Set<string>();
  let publishesDeclaredCollection = false;
  for (const step of steps) {
    // Bare-identifier ids only: a hyphenated id referenced as
    // steps.invoice-rows parses as SUBTRACTION in jsonata, so the reference
    // silently evaluates to nothing at run time.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.id) || seen.has(step.id)) {
      issues.push(`step ids must be unique bare identifiers ([A-Za-z_][A-Za-z0-9_]*) — "${step.id}" is not`);
    }
    seen.add(step.id);
    if (refused.has(step.tool)) {
      issues.push(refusal(`step "${step.id}"`, step.tool));
    } else if (!known.has(step.tool)) {
      issues.push(`step "${step.id}" names unknown tool "${step.tool}"; the available tools are: ${[...known].join(", ") || "(none)"}`);
    }
    // Law 1 for automations: a published result must be BUILT from a PRIOR
    // step's output (or the trigger event) — a hand-typed data payload is
    // invented data on the board. Quoted jsonata string literals (BOTH legal
    // quote forms) are stripped first so 'a steps guide' or "steps.rows"
    // cannot smuggle past the check, and the referenced step id must be one
    // that ran EARLIER (a bare "steps" token or a forward reference
    // publishes nothing at run time).
    if (step.tool === RESULTS_TOOL) {
      const dataExpression = (step.args?.data ?? "").replace(/'[^']*'|"[^"]*"/g, "");
      const referencedPrior = [...dataExpression.matchAll(/\bsteps\.([A-Za-z_][A-Za-z0-9_]*)/g)]
        .some((match) => priorIds.has(match[1] as string));
      if (!referencedPrior && !/\bevent\b/.test(dataExpression)) {
        issues.push(`step "${step.id}" publishes hand-typed data — the "${RESULTS_TOOL}" data expression must derive from an EARLIER step's output (steps.<priorStepId>...) or the trigger event; add the read step that fetches the live data first`);
      }
      if (typeof resultsCollection === "string"
        && step.args?.collection?.trim() === `'${resultsCollection}'`
        && step.args?.appId?.trim() === `'${input.appId}'`) {
        publishesDeclaredCollection = true;
      }
    }
    priorIds.add(step.id);
  }
  // A declared results collection the run never writes leaves the rebound
  // board permanently empty — require the publish step to target exactly
  // this app and that collection (literal jsonata strings).
  if (typeof resultsCollection === "string" && !publishesDeclaredCollection) {
    issues.push(`resultsCollection "${resultsCollection}" is declared but no step publishes it — add a "${RESULTS_TOOL}" step with args {"appId":"'${input.appId}'","collection":"'${resultsCollection}'","id":"'latest'","data":...}`);
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
  const candidate = parsed as { name?: unknown; when?: unknown; task?: unknown; resultsCollection?: unknown; replaces?: unknown };
  const issues: string[] = [];
  const parsedWhen = readWhen(candidate.when);
  if (parsedWhen.when === undefined) return { issues: parsedWhen.issues };
  const taskResult = automationTaskSchema.safeParse(candidate.task);
  if (!taskResult.success) {
    const first = taskResult.error.issues[0];
    const at = first === undefined || first.path.length === 0 ? "" : ` at task.${first.path.join(".")}`;
    return { issues: [`invalid "task"${at}: ${first?.message ?? "does not match the task schema"} — remember every steps args value is a JSON STRING containing a jsonata expression`] };
  }
  const when = parsedWhen.when;
  const task = taskResult.data;
  if (task.kind !== input.mode) {
    issues.push(`task.kind must be "${input.mode}" for this instruction`);
  }
  // The tools §12 will never run away are already absent from the planner's
  // TOOLS list, so this is the defence in depth: refuse the plan HERE instead of
  // letting it validate, land, and then die on the tick as "unknown tool in
  // automation", which tells the person nothing about their own request.
  const refused = new Set(input.tools.filter(irreversible).map(({ name }) => name));
  if (task.kind === "goal") {
    // A goal names no tools, so the refusal scan reads the prompt itself: an
    // exact tool name in free text is the only signal there is, and no verb
    // guessing happens anywhere.
    const { prompt } = task;
    for (const tool of refused) {
      if (prompt.includes(tool)) issues.push(refusal("the goal's prompt", tool));
    }
  }
  const resultsCollection = candidate.resultsCollection;
  if (resultsCollection !== undefined) {
    if (typeof resultsCollection !== "string" || !COLLECTION_NAME.test(resultsCollection) || resultsCollection === "state") {
      issues.push('resultsCollection must be a short bare identifier (and never the reserved "state")');
    }
  }
  if (task.kind === "steps") {
    issues.push(...stepsIssues(task.steps, input, refused, resultsCollection));
  }
  const name = candidate.name;
  if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > 80)) {
    issues.push("name must be a non-empty string of at most 80 characters");
  }
  // A reference to an automation this app does not name is repaired, never
  // guessed at: dropping it would silently turn a change to one automation into
  // a second automation beside it, which is the exact confusion `replaces`
  // exists to end.
  const replaces = candidate.replaces;
  const held = (input.existing ?? []).map(({ id }) => id);
  if (replaces !== undefined && (typeof replaces !== "string" || !held.includes(replaces))) {
    issues.push(`"replaces" must name one of this app's own automations${held.length === 0 ? ", and this app has none" : `: ${held.join(", ")}`} — leave it out entirely when this is a new automation beside them`);
  }
  if (issues.length > 0) return { issues };
  return {
    plan: {
      when,
      task,
      ...(typeof name === "string" ? { name: name.trim() } : {}),
      ...(typeof resultsCollection === "string" ? { resultsCollection } : {}),
      ...(typeof replaces === "string" ? { replaces } : {}),
    },
    issues: [],
  };
};

/** Author one automation: up to 3 model attempts, each repair fed the
 *  accumulated issues (the engine's create/edit loop shape). */
export const planAutomation = async (
  input: AutomationPlanInput,
  model: LanguageModel,
): Promise<AutomationPlanResult> => {
  let issues: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const output = await askModel(
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
