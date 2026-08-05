import type {
  AppDocument,
  RiskLabel,
  ToolDescriptor,
  Trigger,
} from "@vendoai/core";
import type { Sponsorship } from "./sponsorship.js";

/** One thing a person is asked to allow for a trigger. A host tool is named by
 *  its tool; the connector dispatcher is named by the SERVICE ACTION it will
 *  call, because its tool name is not its action (01-core §5 `service-tool`).
 *
 *  Lives here because this IS the consent surface: the engine captures grants
 *  from it and the adoption card lists it, and those two may not disagree. */
export interface ConsentItem {
  tool: string;
  slug?: string;
}

/** One read or write the stopped automation performs, as the card says it.
 *
 *  Design §12: consent surfaces are the one carve-out from the voice law —
 *  plain language, but ONE LINE PER STEP (never a single summary line for a
 *  compound), the real tool title, the material arguments where the automation
 *  declares them, and the tool's declared risk label. */
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
  /** WHICH trigger of the app stopped. Sponsorship is per (app, trigger), so a
   *  card is about one trigger and `adopt` needs to be told which one to take
   *  on — an app's other triggers may still be running perfectly well. */
  triggerId: string;
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
    // A tool the registry no longer binds is a write, fail-closed: an unknown
    // declaration is not evidence of safety.
    risk: descriptor === undefined ? "write" : descriptor.risk,
    ...(args === undefined || Object.keys(args).length === 0 ? {} : { args: { ...args } }),
  };
};

/** Every read and write the automation will make, in the order it makes them.
 *  Steps list one entry PER STEP — two calls to the same tool are two lines,
 *  because that is what §12 means by never summarizing a compound.
 *
 *  An agentic run declares no steps, so the card lists its CONSENT SURFACE: the
 *  same items `adopt()` captures grants from, so the card cannot promise a
 *  narrower or wider authority than adoption actually mints. That surface is the
 *  authored `run.tools` declaration when there is one and every bound descriptor
 *  when there is not — the card follows it either way rather than deciding for
 *  itself. A service action rides as the dispatcher plus its slug, the shape a
 *  steps run's own declared dispatch already takes. */
const adoptionNeeds = (
  trigger: Trigger,
  descriptors: Map<string, ToolDescriptor>,
  surface: readonly ConsentItem[],
): AdoptionNeed[] => {
  if (trigger.run.kind !== "steps") {
    return surface.map((item) =>
      needFor(item.tool, descriptors, item.slug === undefined ? undefined : { slug: item.slug }));
  }
  return trigger.run.steps
    .filter((step) => !step.tool.startsWith("fn:"))
    .map((step) => needFor(step.tool, descriptors, step.args));
};

export const adoptionCard = (
  doc: AppDocument,
  trigger: Trigger,
  stopped: {
    triggerId: string;
    reason: NonNullable<Sponsorship["reason"]>;
    /** The sponsor's name; omitted once their data is erased. */
    sponsor?: string;
    stoppedAt?: string;
  },
  descriptors: Map<string, ToolDescriptor>,
  /** What adopting this trigger will actually grant — the engine's own consent
   *  surface for it, so the card and the minted grants are one derivation. */
  surface: readonly ConsentItem[],
): AdoptionCard => ({
  appId: doc.id,
  triggerId: stopped.triggerId,
  automation: doc.name,
  ...(stopped.sponsor === undefined ? {} : { sponsor: stopped.sponsor }),
  reason: stopped.reason,
  ...(stopped.stoppedAt === undefined ? {} : { stoppedAt: stopped.stoppedAt }),
  needs: adoptionNeeds(trigger, descriptors, surface),
});
