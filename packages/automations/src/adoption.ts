import {
  resolvedRisk,
  type AppDocument,
  type RiskLabel,
  type ToolDescriptor,
} from "@vendoai/core";
import type { Sponsorship } from "./sponsorship.js";

/** One read or write the stopped automation performs, as the card says it.
 *
 *  Design §12: consent surfaces are the one carve-out from the voice law —
 *  plain language, but ONE LINE PER STEP (never a single summary line for a
 *  compound), the real tool title, the material arguments where the automation
 *  declares them, and a risk the model cannot author (`resolvedRisk`: the
 *  declared label and the mechanical vote, resolved against the tool). */
export interface AdoptionNeed {
  tool: string;
  title: string;
  description?: string;
  risk: RiskLabel;
  /** The step's declared arguments, verbatim — what will actually be sent. */
  args?: Record<string, string>;
}

/** Build contract §9.9 — the adoption ask, as additive venue state on the app's
 *  open payload. Nothing is pushed to anybody: the card WAITS in the app, and
 *  the next editor+ to open it may adopt. */
export interface AdoptionCard {
  appId: string;
  /** The automation's user-visible name. */
  automation: string;
  /** The person it can no longer run as, named as they asserted themselves.
   *  ABSENT when their data was erased: the name went with the erase, and the
   *  card says "someone else" rather than resurrecting an identifier. */
  sponsor?: string;
  reason: NonNullable<Sponsorship["reason"]>;
  stoppedAt?: string;
  needs: AdoptionNeed[];
}

const needFor = (
  tool: string,
  descriptors: Map<string, ToolDescriptor>,
  args?: Record<string, string>,
): AdoptionNeed => {
  const descriptor = descriptors.get(tool);
  return {
    tool,
    title: descriptor?.title ?? tool,
    ...(descriptor?.description === undefined ? {} : { description: descriptor.description }),
    // A tool the registry no longer binds is a write: the same fail-closed
    // default the mechanical vote uses for a name it does not recognise —
    // an unknown declaration is not evidence of safety.
    risk: descriptor === undefined ? "write" : resolvedRisk(descriptor),
    ...(args === undefined || Object.keys(args).length === 0 ? {} : { args: { ...args } }),
  };
};

/** Every read and write the automation will make, in the order it makes them.
 *  Steps list one entry PER STEP — two calls to the same tool are two lines,
 *  because that is what §12 means by never summarizing a compound. An agentic
 *  run declares no steps, so it lists the tools adoption would actually grant:
 *  whatever the registry binds for it. */
const adoptionNeeds = (
  doc: AppDocument,
  descriptors: Map<string, ToolDescriptor>,
): AdoptionNeed[] => {
  const trigger = doc.trigger;
  if (trigger === undefined) return [];
  if (trigger.run.kind !== "steps") {
    return [...descriptors.values()].map((descriptor) => needFor(descriptor.name, descriptors));
  }
  return trigger.run.steps
    .filter((step) => !step.tool.startsWith("fn:"))
    .map((step) => needFor(step.tool, descriptors, step.args));
};

export const adoptionCard = (
  doc: AppDocument,
  stopped: {
    reason: NonNullable<Sponsorship["reason"]>;
    /** The sponsor's name; omitted once their data is erased. */
    sponsor?: string;
    stoppedAt?: string;
  },
  descriptors: Map<string, ToolDescriptor>,
): AdoptionCard => ({
  appId: doc.id,
  automation: doc.name,
  ...(stopped.sponsor === undefined ? {} : { sponsor: stopped.sponsor }),
  reason: stopped.reason,
  ...(stopped.stoppedAt === undefined ? {} : { stoppedAt: stopped.stoppedAt }),
  needs: adoptionNeeds(doc, descriptors),
});
