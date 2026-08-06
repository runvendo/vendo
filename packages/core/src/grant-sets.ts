import { canonicalJson } from "./jcs.js";
import { sha256Hex } from "./sha256.js";
import type { Json } from "./ids.js";
import { USE_SERVICE_TOOL, type ToolDescriptor } from "./tools.js";
import type { RunContext } from "./run-context.js";

/** Build contract §7 — a grant set is per person, bound to an app's INTENT
 *  rather than to a bare list of tool names. */
export interface GrantSet {
  id: string;
  appId: string;
  subject: string;
  intentHash: string;
  tools: string[];
  createdAt: string;
}

/** The things a person actually consented to, for ONE trigger of an app.
 *  Anything outside these is cosmetic: re-asking on a cosmetic change is how
 *  people are trained to tap through cards without reading them.
 *
 *  An automation is an app with a LIST of triggers, so the intent is per
 *  trigger: `triggerId` names which one, and `tools`/`trigger`/`runBody`
 *  describe only THAT trigger. Editing one trigger therefore leaves the other
 *  triggers' consent intact, and two triggers that declare identical work still
 *  hash apart — one trigger's sponsorship can never validate another's. */
export interface AppIntent {
  name: string;
  triggerId: string;
  tools: readonly string[];
  trigger: Json;
  runBody: string;
}

/** Build contract §7 — sha256 over the RFC 8785 canonical form of
 *  `{ tools (sorted), trigger, runBody, name, triggerId }`. Tools are sorted so
 *  that reordering a declaration is not mistaken for changing it. */
export function intentHash(intent: AppIntent): string {
  const preimage = {
    name: intent.name,
    runBody: intent.runBody,
    tools: [...intent.tools].sort(),
    trigger: intent.trigger,
    triggerId: intent.triggerId,
  };
  return `sha256:${sha256Hex(canonicalJson(preimage))}`;
}

/** What a re-declaration actually changed. `added` is the ONLY thing a card may
 *  ask about (§12: "an addition cards only the delta"); `removed` is reported so
 *  callers can retire grants, never to ask about — dropping a capability needs
 *  no consent. */
export function grantSetDelta(
  granted: readonly string[],
  declared: readonly string[],
): { added: string[]; removed: string[] } {
  const has = new Set(granted);
  const wants = new Set(declared);
  return {
    added: [...wants].filter((tool) => !has.has(tool)).sort(),
    removed: [...has].filter((tool) => !wants.has(tool)).sort(),
  };
}

/** The one blocked-reason string that means "§12's law refused this".
 *
 *  Named once here because two sides read it: the guard writes it, and the
 *  harness runtime maps it to `DeniedNeeds{ kind: "unattended-destructive" }`
 *  (build contract §1.1) so a harness can offer prepare-then-human-sends
 *  instead of retrying. String-matching it in two places would let them drift. */
export const UNATTENDED_DESTRUCTIVE_REASON =
  "This action is destructive or external, so it is never available without a person present. "
  + "Prepare it instead and let someone send it.";

/** Is a person there to see this? Unattended means NOBODY ACTED — so the
 *  predicate is `presence`, and only `presence`.
 *
 *  The venue is deliberately NOT part of this. `venue` says which door a
 *  request came through; `presence` says whether a human is behind it, and only
 *  the second question is the law's. The two come apart in both directions:
 *   - `{ venue: "automation", presence: "away" }` is a real unattended firing —
 *     the shape every schedule fires with, including a machine app's own
 *     `vendo.json` schedules once they are folded into its document triggers
 *     (`apps/src/manifest-triggers.ts` → `automations/src/engine.ts`), so a
 *     venue-based predicate would let every schedule out from under the law.
 *   - `{ venue: "automation", presence: "present" }` is a CEREMONY, not a run:
 *     the enable/capture flow and the "allow this while you're away" approval
 *     card both run with a human right there clicking, and they must SEE the
 *     destructive tools they exist to ask permission about. ORing the venue in
 *     filtered those tools out of the ceremony's own descriptor lookup, so
 *     enabling an automation reported a registered host tool as "unknown tool
 *     in automation" — the law breaking its own prescribed
 *     prepare-then-human-sends path.
 *
 *  `presence` is a required field (`"present" | "away"`), so this fails closed:
 *  there is no absent-value case that reads as attended. Every real firing
 *  passes `presence: "away"` (automations engine, schedules, agent runner,
 *  server), which is what makes presence alone both safe and sufficient. */
export function isUnattended(ctx: Pick<RunContext, "presence">): boolean {
  return ctx.presence === "away";
}

/**
 * THE LAW (§12), as a projection: destructive and external actions are **not
 * projected into an automation run at all** — not with a limit, not with a
 * condition, not with an admin override.
 *
 * This is a filter over the toolset rather than a check at call time because the
 * law is about what the model is even offered. A tool the model cannot see is a
 * tool it cannot be talked into using; a tool it can see but is refused becomes
 * something it retries and works around. Call-time enforcement still exists as
 * defence in depth, but this is the primary mechanism.
 */
export function projectableForRun(
  descriptors: readonly ToolDescriptor[],
  ctx: Pick<RunContext, "venue" | "presence" | "grantedServiceSlugs">,
): ToolDescriptor[] {
  if (!isUnattended(ctx)) return [...descriptors];
  return descriptors.filter(
    (descriptor) => !withheldFromUnattended(descriptor) || isGrantedDispatcher(descriptor, ctx),
  );
}

/**
 * The ONE exemption from the ungraded half of the law: the connector dispatcher,
 * for a firing that already holds at least one live per-slug service grant.
 *
 * `use_service_tool` is `ungraded` because one tool name stands in for a whole
 * third-party catalog — the descriptor genuinely cannot say what a call does, and
 * the per-slug grade arrives at call time. Withholding it outright therefore did
 * not cage an agentic automation's connector access, it removed it: no unattended
 * run could reach a connector at all, however explicitly a person had allowed one
 * particular action. That is not what anybody consented to when they allowed it.
 *
 * So visibility follows the grant, and nothing else does. The exemption:
 *  - is one tool name, not a risk level — every OTHER ungraded tool stays
 *    withheld, because nothing has said what those do either;
 *  - never reaches `destructive`, which is checked first and has no exemption at
 *    all, so a dispatcher someone graded destructive stays invisible;
 *  - decides only what the model is OFFERED. Which slug may actually run is
 *    still the guard's call at call time — an ungranted slug is refused and a
 *    destructive-graded slug is refused away, both unchanged. Being shown the
 *    door is not being through it.
 */
function isGrantedDispatcher(
  descriptor: ToolDescriptor,
  ctx: Pick<RunContext, "grantedServiceSlugs">,
): boolean {
  return descriptor.name === USE_SERVICE_TOOL
    && descriptor.risk === "ungraded"
    && (ctx.grantedServiceSlugs?.length ?? 0) > 0;
}

/**
 * §12's law, extended to the state that says "nobody knows": an `ungraded` tool
 * is withheld from an unattended run exactly as a destructive one is.
 *
 * The two laws meet here. §12 withholds what is known to be dangerous; the
 * risk-grading redesign (D3) says an ungraded tool needs a PERSON, because
 * nothing — human, judge, or protocol fact — has said what it does. An
 * unattended run is precisely the venue with no person to ask, so "needs a
 * person" can only mean "not offered". Anything else would rely on the guard
 * parking a call nobody will ever answer.
 *
 * The cost is real and deliberate: on a catalog that has never been judged,
 * EVERY host tool is ungraded, so automations are offered nothing until the
 * catalog is graded (`vendo sync` with a model key, `.vendo/overrides.json`, or
 * a policy rule that accepts `ungraded`). That is the same fail-closed direction
 * the redesign takes everywhere else, in the one venue where asking is not an
 * option.
 *
 * The DECLARED label decides — the dev's label is final. There is no second
 * mechanical vote guessing from names or methods any more; unlabeled means
 * `ungraded`, and `ungraded` asks.
 */
export function withheldFromUnattended(descriptor: ToolDescriptor): boolean {
  return descriptor.risk === "destructive" || descriptor.risk === "ungraded";
}

/** §12 — "Whole-registry declarations are rejected, not bundled; a declared set
 *  is bundle-eligible only if every member is a read or a non-destructive
 *  write." A card that asks for everything is not consent, it is a formality. */
export function isBundleEligible(
  declared: readonly string[],
  registry: readonly string[],
  descriptors: readonly ToolDescriptor[],
): boolean {
  if (declared.length === 0) return false;
  const wanted = new Set(declared);
  if (registry.length > 0 && registry.every((tool) => wanted.has(tool))) return false;
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return declared.every((name) => {
    const descriptor = byName.get(name);
    return descriptor !== undefined && descriptor.risk !== "destructive";
  });
}
