/**
 * What a record DECLARES, read without touching the store: the JSONata a step's
 * args and conditions are written in, the consent identity of a tool call, and
 * how a tool outcome reads on a run row.
 *
 * Schedule validation is NOT here — it happens at DECLARATION, in core's
 * `toTriggerSource`, so all four authoring doors reject a cron nobody can run
 * before the process serves anything rather than at 2am.
 */
import {
  serviceToolSlug,
  USE_SERVICE_TOOL,
  type GrantScope,
  type Json,
  type Step,
  type ToolOutcome,
  type TriggerSource,
} from "@vendoai/core";
import jsonata from "jsonata";
import { FOREACH_MAX_ITEMS, type ConsentItem } from "./types.js";

export const triggerEvent = (source: TriggerSource): string | undefined =>
  source.kind === "host-event" || source.kind === "external" ? source.event : undefined;

export const evaluate = async (expression: string, input: Record<string, Json>): Promise<Json> =>
  await jsonata(expression).evaluate(input) as Json;

export const stepArgs = async (
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

/** The identity of a consent item — what "already asked for this" means, and
 *  therefore what two different service actions must NOT collapse into. */
export const consentKey = (item: ConsentItem): string =>
  item.slug === undefined ? item.tool : `${item.tool}\u0000${item.slug}`;

/** Whether a standing automation grant already covers this consent item. A
 *  host tool wants the tool-wide grant it has always minted; a service action
 *  wants its own slug and is not covered by any other. */
export const scopeCovers = (scope: GrantScope, slug?: string): boolean =>
  slug === undefined ? scope.kind === "tool" : scope.kind === "service-tool" && scope.slug === slug;

/** The service action a step declares, when it declares one.
 *
 *  Step args are JSONata, so the slug is only a declaration when it is a
 *  CONSTANT — an expression that needs the event resolves to nothing here. That
 *  is the right line rather than a limitation: an action nobody can name while
 *  the person is present is not one they can pre-approve, so that step parks at
 *  fire time and accretes its grant from a real approval instead. */
export const declaredSlug = async (step: Step): Promise<string | undefined> => {
  if (step.tool !== USE_SERVICE_TOOL) return undefined;
  const expression = step.args?.["slug"];
  if (expression === undefined) return undefined;
  try {
    const value = await evaluate(expression, { event: null, steps: {} });
    return serviceToolSlug({ tool: step.tool, args: { slug: value } });
  } catch {
    return undefined;
  }
};

export const outcomeDetail = (outcome: ToolOutcome): string | undefined => {
  if (outcome.status === "error") return outcome.error.message;
  if (outcome.status === "blocked") return outcome.reason;
  if (outcome.status === "pending-approval") return outcome.approvalId;
  if (outcome.status === "connect-required") return outcome.connect.message;
  return undefined;
};

export const errorForOutcome = (outcome: Exclude<ToolOutcome, { status: "ok" }>): { code: string; message: string } => {
  if (outcome.status === "error") return outcome.error;
  if (outcome.status === "blocked") return { code: "blocked", message: outcome.reason };
  // An away run has no user to show a connect card to; the run fails with an
  // actionable message and the user connects in-product before re-running.
  if (outcome.status === "connect-required") return { code: "connect-required", message: outcome.connect.message };
  return { code: "blocked", message: `approval required: ${outcome.approvalId}` };
};

export const validateForEachItems = (step: Step, value: Json): Json[] => {
  if (!Array.isArray(value)) throw new Error(`step ${step.id} forEach did not produce an array`);
  if (value.length > FOREACH_MAX_ITEMS) throw new Error(`step ${step.id} forEach exceeds ${FOREACH_MAX_ITEMS} items`);
  return value;
};
