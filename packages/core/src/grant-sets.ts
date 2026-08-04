import { canonicalJson } from "./jcs.js";
import { sha256Hex } from "./sha256.js";
import type { Json } from "./ids.js";
import { isVendoAuthored, type RiskLabel, type ToolDescriptor } from "./tools.js";
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

/** The four things a person actually consented to. Anything outside these is
 *  cosmetic: re-asking on a cosmetic change is how people are trained to tap
 *  through cards without reading them. */
export interface AppIntent {
  name: string;
  tools: readonly string[];
  trigger: Json;
  runBody: string;
}

/** Build contract §7 — sha256 over the RFC 8785 canonical form of
 *  `{ tools (sorted), trigger, runBody, name }`. Tools are sorted so that
 *  reordering a declaration is not mistaken for changing it. */
export function intentHash(intent: AppIntent): string {
  const preimage = {
    name: intent.name,
    runBody: intent.runBody,
    tools: [...intent.tools].sort(),
    trigger: intent.trigger,
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

/** ACTION verbs that move money, message a human, or destroy something.
 *
 *  THE vocabulary — one definition, deployment-wide. `mechanicalRisk` below
 *  matches it anywhere in the name, but only AFTER the trailing-token read
 *  short-circuit has had its say: matching everywhere with nothing in front of it
 *  made `gmail_message_get` look destructive, and over-withholding is not a safe
 *  default, because it silently breaks automations that only ever read, which
 *  trains people to widen permissions.
 *
 *  Build-time extraction (`packages/actions/src/sync/common.ts`) reads this same
 *  set through a DIFFERENT vote: it has no HTTP verb to lean on for tRPC and
 *  server actions, so it matches membership anywhere in the name. Two votes, one
 *  word list — the algorithms are meant to differ, the vocabulary is not. It was
 *  written down twice until 2026-07-30, and a security word list with two
 *  definitions drifts silently: a verb added here still extracted as a plain
 *  `write`. */
export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  // destroy
  "delete", "remove", "destroy", "purge", "wipe", "erase", "truncate", "drop", "clear",
  // retire / revoke
  "cancel", "close", "reset", "revoke", "terminate", "deactivate", "disable", "suspend",
  "ban", "block", "expire", "unsubscribe", "archive", "void", "reject", "decline",
  // move money
  "pay", "payout", "charge", "refund", "withdraw", "transfer", "wire", "remit",
  "disburse", "settle", "capture", "chargeback",
  // reach a human / move something out
  "send", "email", "notify", "text", "sms", "message", "dm", "invite", "publish",
  "post", "share", "broadcast", "announce", "dispatch", "page", "call", "forward", "move",
  // start something irreversible
  "initiate", "submit", "execute", "launch", "trigger", "fire", "unpause", "release",
  "approve", "confirm", "finalize", "commit", "merge", "deploy",
]);

/** Verbs that only ever read. A name ending in one of these is a read (the
 *  trailing token is the action in `noun_verb` naming, so nouns before it are
 *  just the subject being read), and so is a name that merely CONTAINS one, on
 *  the two conditions `mechanicalRisk` documents. Shared with build-time
 *  extraction for the same reason {@link DESTRUCTIVE_VERBS} is. */
export const READ_VERBS: ReadonlySet<string> = new Set([
  "get", "list", "fetch", "read", "show", "query", "describe", "count", "search",
  "find", "lookup", "view", "peek", "head", "exists", "check", "preview", "export",
]);

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

/**
/**
 * The trailing token — the one that decides whether a name is READ-shaped.
 *
 * This is the noun-vs-verb discrimination that makes the vote a second opinion.
 * In `subject_verb` naming the last token is the action, so `gmail_message_get`
 * ends in `get` and is a read even though `message` is in the destructive set:
 * `message` there is the subject being read, not a verb. Checking the trailing
 * read verb FIRST is what keeps that noun from withholding a legitimate read.
 */
function trailingToken(name: string): string | undefined {
  const parts = words(name);
  return parts.length === 0 ? undefined : parts[parts.length - 1];
}

/**
 * §12's SECOND MECHANICAL VOTE: the risk a tool's HTTP method and verb shape
 * imply, computed WITHOUT consulting the AI-assigned label.
 *
 * Not reading `descriptor.risk` is the whole point — a vote that consults the
 * label is not a second opinion, it is the label wearing a hat. `resolvedRisk`
 * is where the two are combined, and disagreement resolves against the tool.
 *
 * Order matters: a destructive verb beats a permissive method (a deletion
 * exposed over GET is still a deletion), and a mutating method beats a
 * read-shaped name (a POST that calls itself `get` is not a read).
 *
 * Both name axes now match a verb ANYWHERE, which is the symmetry this vote
 * lacked until 2026-07-31 (see the read-anywhere rule below). Position is still
 * what breaks the tie between them: the TRAILING token is checked first, so a
 * destructive NOUN cannot withhold a read (`gmail_message_get`), and the
 * destructive scan is checked before the read one, so a read verb cannot rescue a
 * compound (`list_and_delete`).
 *
 * The method axis reads {@link ToolDescriptor.bindingRisk} — the distilled fact
 * the actions registry derives from a tool's execution binding. It read a raw
 * `method` field off the descriptor until 2026-07-31, which meant it never fired
 * in production at all: host-extracted descriptors are minted by `descriptorOf`,
 * a field whitelist that dropped `binding.method`, so a DELETE-bound tool an
 * extractor or an override labelled `write` resolved `write` and was projected
 * into unattended runs. Half a vote, dark on exactly the AI-assigned labels the
 * vote exists to check.
 */
export function mechanicalRisk(descriptor: ToolDescriptor): RiskLabel {
  // A deletion is a deletion whatever the tool calls itself, so the binding is
  // read before the name is looked at.
  if (descriptor.bindingRisk === "destructive") return "destructive";
  // Any other mutating shape (POST/PUT/PATCH, a tRPC or GraphQL mutation, a
  // server action) is not by itself destructive — §12 says automations may read
  // and write — but it does disqualify the read short-circuit below.
  const mutating = descriptor.bindingRisk !== undefined;

  const trailing = trailingToken(descriptor.name);

  // A TRAILING read verb settles it, and it is checked FIRST on purpose. In
  // `subject_verb` naming the trailing token IS the action, so everything before
  // it is the subject being read — which is exactly why `gmail_message_get` is a
  // read and not a deletion. The method still has to agree: a POST that calls
  // itself `get` is not a read. This short-circuit is the whole noun-vs-verb
  // discrimination; it must run before the destructive scan below.
  if (trailing !== undefined && READ_VERBS.has(trailing) && !mutating) return "read";

  const tokens = words(descriptor.name);

  // Not read-shaped, so a destructive verb ANYWHERE in the name decides. Match
  // anywhere, not just at the ends: `maple_customer_delete_all` and
  // `maple_money_transfer_out` bury the verb in the middle of a long name with a
  // qualifier tail (`_all`, `_out`, `_now`), and end-position-only checks let
  // those slip through as `write` and into unattended runs. The read short-circuit
  // above already protected the destructive-NOUN reads, so matching anywhere here
  // costs a false-positive only on a non-read-shaped name that merely mentions a
  // destructive word — which is the fail-toward-destructive direction §12 wants.
  //
  // This stays AHEAD of the read-anywhere rule below, which is what keeps a
  // compound (`list_and_delete`, `get_then_purge`, `fetch_and_wire_funds`)
  // destructive: the two rules overlap on exactly those names, and the
  // destructive one has to win.
  if (tokens.some((token) => DESTRUCTIVE_VERBS.has(token))) return "destructive";

  // A read verb ANYWHERE is a read, which is the same-position symmetry the
  // destructive scan above has had since 2026-07-30. Only the TRAILING token was
  // inspected until 2026-07-31, so `verb_noun` — which is how essentially every
  // extracted host read is named — fell through to the fail-closed default:
  // `host_listAccounts`, `host_getAccount`, `host_getProfile` and
  // `host_listTransactions` all voted `write` on the flagship demo despite being
  // GET-bound reads. Downstream a `write` IS a mutating call, so each took an
  // effect-ledger receipt on every call and a host rule matching `{risk:"write"}`
  // would card a plain read — both against §12's "reads are silent, always".
  //
  // It cannot LOWER anything, because it is reached only when the two escalating
  // axes have already had their say: no destructive verb appears anywhere (the
  // check above returned), and the binding is not mutating (`!mutating`, so a
  // POST-bound `host_listInvoices` stays `write` and a DELETE never gets here at
  // all). A read verb never talks a mutating shape down.
  if (!mutating && tokens.some((token) => READ_VERBS.has(token))) return "read";

  // Everything else is a write: fail-closed, because an unrecognised verb is not
  // evidence of safety — but not `destructive`, because withholding every
  // unknown tool from every automation would make them useless.
  return "write";
}

/** `ungraded` outranks every real grade, so the mechanical vote can never
 *  launder "nobody has graded this" into a `write` it guessed from the name —
 *  the state exists precisely to say the risk is unknown, and a guess is not an
 *  answer (risk-grading redesign D1/D3). The vote still escalates every label
 *  someone did assign, which is the job §12 gave it. */
const RANK: Record<RiskLabel, number> = { read: 0, write: 1, destructive: 2, ungraded: 3 };

/**
 * The risk the guard should act on: the RISKIER of the AI-assigned label and the
 * mechanical vote. §12: "Eligibility never rests on the AI-assigned risk label
 * alone … disagreement treats the tool as destructive."
 *
 * The vote is scoped to where the label came from (build contract §8,
 * clarification 2026-07-31). `AI-assigned` is the operative word: the vote is
 * there to catch an extractor or a connector mislabelling someone ELSE's API. A
 * Vendo-authored label (`isVendoAuthored`) was hand-written and reviewed in this
 * repo, so a second opinion has nobody to disagree with — while the vote's
 * heuristic, calibrated for extracted `noun_verb` host names, mis-votes on the
 * names we chose ourselves: `ask_user`, `validate` and `search_components` all
 * end in a noun, so the read short-circuit missed them and the fail-closed
 * default called a question and two checks `write`. Downstream, a `write` IS a
 * mutating call — the guard writes it an effect-ledger row, and a re-run of that
 * call then answers from the receipt instead of re-executing — against §12's
 * "reads are silent, always".
 *
 * Provenance rides the descriptor as a symbol, so it cannot be claimed by
 * anything that arrived as data, and every laundering path drops it — which
 * fails closed, back to the vote. Nothing else about this function moves: for
 * every AI-assigned label the two votes still combine, and disagreement still
 * resolves against the tool.
 */
export function resolvedRisk(descriptor: ToolDescriptor): RiskLabel {
  if (isVendoAuthored(descriptor)) return descriptor.risk;
  const mechanical = mechanicalRisk(descriptor);
  return RANK[mechanical] > RANK[descriptor.risk] ? mechanical : descriptor.risk;
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
 *   - `{ venue: "app", presence: "away" }` is a real unattended firing — that is
 *     the shape a scheduled app fn fires with (`apps/src/schedules.ts`), so a
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
  ctx: Pick<RunContext, "venue" | "presence">,
): ToolDescriptor[] {
  if (!isUnattended(ctx)) return [...descriptors];
  return descriptors.filter((descriptor) => !withheldFromUnattended(descriptor));
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
 */
export function withheldFromUnattended(descriptor: ToolDescriptor): boolean {
  const resolved = resolvedRisk(descriptor);
  return resolved === "destructive" || resolved === "ungraded";
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
    return descriptor !== undefined && resolvedRisk(descriptor) !== "destructive";
  });
}
