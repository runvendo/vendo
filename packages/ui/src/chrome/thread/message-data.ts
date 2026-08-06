import { AGENT_CONTEXT_MARK, isAgentContextText, isVendoAppsTool, riskLabelSchema, VENDO_MAKE_TOOL, vendoErrorCodeSchema, type ApprovalRequest, type JsonSchema, type RiskLabel, type VendoCitationsPart, type VendoErrorCode, type VendoKnowledgeCitation } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { previewArgs } from "../humanize.js";
import { LONG_TEXT_CAP, truncateHead } from "../truncate.js";

export function partData(part: UIMessage["parts"][number]): unknown {
  return "data" in part ? part.data : part;
}

/** ENG-214 — the marker the agent's `wireErrorMessage` puts on its OWN safe
 * error text (VendoError code + operator-crafted message). Only prefixed
 * strings may be shown in detail to an end user; raw transport/provider
 * strings never carry it. Read by both error surfaces (the banner and the
 * in-thread turn-error part). */
export const VENDO_ERROR_PREFIX = "Vendo: ";

/**
 * CR-3 — what a PERSON is told about a broken turn, BY CODE.
 *
 * The `"Vendo: "` marker says a sentence is safe to put on the WIRE (it is
 * ours, not the provider's). It has never said the sentence was written for a
 * reader, and mostly it was not: `packages/vendo/src/sandbox.ts` raises
 * `Vendo Cloud sandbox sbx_… is gone (destroyed by the provider): <raw provider
 * message>` — an id AND a nested exception, inside a conversation — and
 * demo/dev refusals name shell commands ("Run `vendo login` for a free dev
 * key"). Prefix-only was therefore a hole exactly as wide as the set of
 * sentences our own code raises.
 *
 * So the reader gets copy chosen by the VendoError CODE, exactly the
 * `refusalCopy` pattern the consent cards use, and the operator's sentence is
 * never printed. Ruling 14 rules out re-using `consumerVoiceViolation` as a
 * runtime gate: a regex set cannot decide what a person may read.
 *
 * One exception, named and narrow: 01-core's `formatMeterExhausted` composes a
 * sentence that IS consumer copy (Pricing v3 §5 — the meter, the figures, the
 * reset date and the two exits, all from structured fields). It survives
 * verbatim, recognized by the head that function always writes.
 *
 * The code and the operator's own sentence keep the home they already have:
 * the server log and the browser console line `wireErrorMessage` writes.
 */
const TURN_ERROR_COPY: Record<VendoErrorCode, string> = {
  validation: "I couldn’t make that request work — nothing was changed. Ask again and I’ll try a different approach.",
  blocked: "That isn’t something I’m allowed to do here, so I stopped — nothing was changed.",
  "not-implemented": "That isn’t something this workspace can do yet — nothing was changed.",
  "sandbox-unavailable": "I couldn’t reach the place I run things just now — nothing was changed. Ask again in a moment.",
  "cloud-required": "That isn’t turned on for this workspace yet — nothing was changed.",
  "not-found": "What that was about isn’t there any more — nothing was changed.",
  conflict: "Something else changed this while I was working — nothing was changed. Ask again and I’ll pick up where things stand now.",
  forbidden: "That isn’t yours to change — nothing was changed.",
};

/** The head `formatMeterExhausted` always writes (01-core meter-exhausted.ts). */
const METER_SENTENCE = /^Vendo Cloud paused /;

export function turnErrorSentence(message: string | undefined): string | undefined {
  if (message === undefined || !message.startsWith(VENDO_ERROR_PREFIX)) return undefined;
  let body = message.slice(VENDO_ERROR_PREFIX.length).trim();
  let code: VendoErrorCode | undefined;
  // The closed 01-core code enum, so stripping a token can never eat a
  // sentence's own parenthetical ("(1,204,000 of 1,000,000 used; …)"). EVERY
  // trailing token comes off, not just the first: a message that crossed the
  // gate twice ("… (validation) (cloud-required)") left one of them on screen.
  // The outermost is the one `wireErrorMessage` added last, so it is the code.
  for (;;) {
    const trailing = vendoErrorCodeSchema.options.find(option => body.endsWith(`(${option})`));
    if (trailing === undefined) break;
    code ??= trailing;
    body = body.slice(0, -`(${trailing})`.length).trimEnd();
  }
  if (METER_SENTENCE.test(body)) return body;
  // No code, or one this build does not know: the surfaces' own headline
  // ("Something went wrong and the response didn't finish.") is the honest
  // answer, and printing the wire instead of it is the whole defect.
  return code === undefined ? undefined : TURN_ERROR_COPY[code];
}

/**
 * Spec §15 + §16 law 3 — what a PERSON is told when an app build fails.
 *
 * The wire's `reason` is the runtime's classified, provider-safe line, and
 * provider-safe is not the same as the reader's language: it is written for
 * whoever can FIX the build. The wave E2E photographed all of it in a real
 * user's thread — the honesty gate's teaching sentence names components and
 * expressions (`amount / sum(spending.data.amount)`), the no-model-key lines
 * name environment variables and npm packages, the watchdog line says to check
 * the host server log. Same class as the slot's `loadFailureCopy`, so the same
 * answer: the developer sentence keeps the home it already has (the server logs
 * it in full with every blocking finding — `[vendo] app build failed (app_…)`,
 * apps/runtime.ts), and the person gets §15's standing copy law — what happened
 * · nothing was changed · what happens next.
 *
 * ONE sentence for every class, deliberately. Splitting the copy by the
 * runtime's classification was tried and reverted on live evidence: the
 * classifier is a substring scan over the concatenated findings
 * (`buildFailureReason`), and `host_listScheduledPayments` in a finding's tool
 * inventory contains "payment", so an ordinary validation failure is persisted
 * as "quota exhausted" (observed 2026-08-03, fix-defects proof). Copy that
 * branches on an unreliable label just tells a different lie — "try again
 * later" for a build that will fail identically. Asking again is true and
 * harmless for every class, so that is what it says.
 */
export const BUILD_FAILURE_COPY =
  "I couldn't finish building that view — nothing was changed."
  + " Ask again and I'll try a different approach.";

// ENG-216 — a stable placeholder for the in-thread synthesized ApprovalRequest's
// required `createdAt`. The wire approval part carries no timestamp; this value
// is never displayed (the card hides the context byline in-thread) and a fixed
// constant replaces the former per-render `new Date()` that churned on every
// re-render and broke deterministic tests.
export const SYNTHESIZED_CREATED_AT = "1970-01-01T00:00:00.000Z";

export function riskByCall(messages: UIMessage[]): Map<string, RiskLabel> {
  const risks = new Map<string, RiskLabel>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as { toolCallId?: unknown; risk?: unknown };
      if (typeof data.toolCallId === "string" && riskLabelSchema.safeParse(data.risk).success) {
        risks.set(data.toolCallId, data.risk as RiskLabel);
      }
    }
  }
  return risks;
}

/** Guard approval metadata by tool call — carried in the data-vendo-approval
    part beside the native ai-SDK approval (whose own id is transport-local).

    spec §16 law 2 — `descriptor` rides here too when the server has one: the
    §16 parts are `.passthrough()`, so a newer server can send the declared
    schema/title/description with the ask and an older one simply omits it
    (buildApprovalRequest degrades to host ToolMeta). */
export function approvalByCall(messages: UIMessage[]): Map<string, ApprovalWireMeta> {
  const approvals = new Map<string, ApprovalWireMeta>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as {
        toolCallId?: unknown;
        approvalId?: unknown;
        invalidatedGrant?: { id?: unknown; grantedAt?: unknown };
        descriptor?: unknown;
      };
      if (typeof data.toolCallId !== "string") continue;
      const descriptor = data.descriptor;
      approvals.set(data.toolCallId, {
        ...(typeof data.approvalId === "string" ? { approvalId: data.approvalId } : {}),
        ...(typeof data.invalidatedGrant?.id === "string"
          && typeof data.invalidatedGrant.grantedAt === "string"
          ? { invalidatedGrant: data.invalidatedGrant as NonNullable<ApprovalRequest["invalidatedGrant"]> }
          : {}),
        ...(typeof descriptor === "object" && descriptor !== null && !Array.isArray(descriptor)
          ? { descriptor: descriptor as ApprovalWireMeta["descriptor"] }
          : {}),
      });
    }
  }
  return approvals;
}

export interface ApprovalWireMeta {
  approvalId?: string;
  invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
  /** The passthrough descriptor fields buildApprovalRequest consumes. */
  descriptor?: { title?: string; description?: string; inputSchema?: JsonSchema };
}

/** Grant-set membership by tool call — carried in the data-vendo-grant-set
    part beside the parked native call. The thread uses it to (a) hand the
    parked call to the set card instead of the plain ApprovalCard, and (b)
    resume on a decided announcement that matches the SET (by grantSetId or
    any member approval id), not just the raw native id. */
export function grantSetByCall(messages: UIMessage[]): Map<string, {
  grantSetId: string;
  approvalIds: string[];
}> {
  const sets = new Map<string, { grantSetId: string; approvalIds: string[] }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-grant-set") continue;
      const data = partData(part) as {
        toolCallId?: unknown;
        grantSetId?: unknown;
        permissions?: Array<{ approvalId?: unknown }>;
      };
      if (typeof data.toolCallId !== "string" || typeof data.grantSetId !== "string") continue;
      const approvalIds = Array.isArray(data.permissions)
        ? data.permissions
            .map(permission => permission.approvalId)
            .filter((value): value is string => typeof value === "string")
        : [];
      sets.set(data.toolCallId, { grantSetId: data.grantSetId, approvalIds });
    }
  }
  return sets;
}

/** Knowledge K1 — what a turn's `data-vendo-citations` parts add up to.
    Chips render only ANSWERED citations (a refusal's weak hits stay off the
    chip row — mockup state 2 shows the searched-line alone); the flags carry
    the refusal/outage states. */
export interface TurnKnowledgeSources {
  citations: VendoKnowledgeCitation[];
  refused: boolean;
  unavailable: boolean;
}

/** Knowledge K1 (pattern: approvalByCall) — fold a turn's citations parts
    into the one summary TurnCitations renders, deduped by doc+chunk across
    multiple knowledge calls in the same turn. */
export function sourcesFor(message: UIMessage): TurnKnowledgeSources {
  const citations: VendoKnowledgeCitation[] = [];
  const seen = new Set<string>();
  let refused = false;
  let unavailable = false;
  for (const part of message.parts) {
    if (part.type !== "data-vendo-citations") continue;
    const data = partData(part) as Partial<VendoCitationsPart>;
    if (data.outcome === "unavailable") unavailable = true;
    if (data.outcome === "insufficient-evidence") refused = true;
    if (data.outcome !== "answered" || !Array.isArray(data.citations)) continue;
    for (const citation of data.citations) {
      if (typeof citation?.docId !== "string" || typeof citation.title !== "string") continue;
      if (typeof citation.snippet !== "string" || typeof citation.kind !== "string") continue;
      if (citation.visibility !== "public" && citation.visibility !== "internal") continue;
      const key = `${citation.docId}::${citation.chunkId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
    }
  }
  return { citations, refused, unavailable };
}

export function toolName(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  return part.type === "dynamic-tool" && "toolName" in part ? part.toolName : part.type.replace(/^tool-/, "");
}

/** The app-boundary title: the payload's `name`, else its first heading Text node. */
export function appTitle(payload: unknown): string | undefined {
  const named = (payload as { name?: unknown }).name;
  if (typeof named === "string" && named.trim()) return named;
  const nodes = (payload as { nodes?: Array<{ component?: string; props?: Record<string, unknown> }> }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (node.component === "Text" && node.props?.variant === "heading" && typeof node.props.text === "string") {
      return node.props.text;
    }
  }
  return undefined;
}

/** A stable signature for a tool part — same tool + same input = the same call. */
function toolSignature(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  const input = "input" in part ? part.input : undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }
  return `${toolName(part)}::${serialized}`;
}

/** ENG-216 — collapse runs of consecutive identical tool chips (e.g. eight
    `host_listClientDocuments` calls) into one entry carrying a count. The
    latest part in the run is kept so the chip icon reflects the final state. */
export function collapseToolRuns(
  parts: UIMessage["parts"],
): { part: UIMessage["parts"][number]; index: number; count: number }[] {
  const items: { part: UIMessage["parts"][number]; index: number; count: number }[] = [];
  parts.forEach((part, index) => {
    const previous = items.at(-1);
    if (
      isToolUIPart(part)
      && previous !== undefined
      && isToolUIPart(previous.part)
      && toolSignature(previous.part) === toolSignature(part)
    ) {
      previous.count += 1;
      previous.part = part;
      return;
    }
    items.push({ part, index, count: 1 });
  });
  return items;
}

/** A tool call the turn is still working, or waiting on: the transcript's beats
    stay open until every call in the turn has reached a terminal state (a
    settled output, an error, or a refused ask). */
export function toolCallPending(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part)
    && part.state !== "output-available"
    && part.state !== "output-error"
    && part.state !== "output-denied";
}

/** Spec §15 — a failed or declined call is CONTENT, not progress: its beat
    stays visible after the turn folds, and it never counts as a thing the agent
    did. Everything else is progress, and progress folds into the summary. */
export function toolCallIsContent(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part)
    && (part.state === "output-error" || part.state === "output-denied");
}

/** Spec §8 D1 — the app-building call this turn's app card is narrating. The
    card bar narrates that step ("Building your view…" → the app's name), so a
    beat beside it would narrate the same work twice; the settled summary still
    counts it. Recognized exactly the way the server decides to emit the view
    part (06-apps §1: the apps tool namespace + a tree surface), never by
    duck-typing an arbitrary tool's output.

    Wave E2E defect D1 — the card goes up at build START (`vendo_make` is the one
    tool that streams partial views through the VENDO_VIEW_STREAM bridge), so
    checking only the RESULT left the whole build window narrating twice: a
    "Build an app…" beat above a bar already saying "Building your view…". The
    running build is therefore recognized by tool IDENTITY, before its output
    exists. No other apps tool streams a partial view, so for the rest the beat
    is the only narration until their tree lands — and a build that is parked on
    an approval or has FAILED is narrated by no card at all, so its beat is the
    whole record (§15). */
export function narratedByAppCard(
  part: UIMessage["parts"][number],
  siblingParts: UIMessage["parts"],
): boolean {
  if (!isToolUIPart(part)) return false;
  // M20 — a build that FAILED terminally narrates through its own block (the
  // `data-vendo-build-failed` part: a ✕ beat reading "Couldn't build the app"
  // plus what it means for the reader). The failed call's own ✕ beat sat right
  // above it, so one failure printed two ✕ lines. The part names the call it
  // is about, so the suppression is exact rather than a guess by tool identity.
  const failed = siblingParts.some(sibling => sibling.type === "data-vendo-build-failed"
    && (partData(sibling) as { toolCallId?: unknown; reason?: unknown }).toolCallId === part.toolCallId
    && typeof (partData(sibling) as { reason?: unknown }).reason === "string");
  if (failed) return true;
  const name = toolName(part);
  if (!isVendoAppsTool(name)) return false;
  const building = part.state === "input-streaming" || part.state === "input-available";
  if (name === VENDO_MAKE_TOOL) {
    if (building) return true;
    if (part.state !== "output-available") return false;
    // A SETTLED build used to be recognized by its output carrying a tree.
    // `vendo_make` answers with a `MakeReceipt` — four fields of words — so that
    // test can never match again, and leaving it would have printed a "Make you
    // a screen" ✓ beat beside the very card it describes. The card's own part on
    // the wire is the test now, which is exact rather than a guess: if the view
    // is there, the card is what the reader is looking at.
    return siblingParts.some(sibling => sibling.type === "data-vendo-view");
  }
  if (part.state !== "output-available") return false;
  const output = part.output as { kind?: unknown } | null | undefined;
  if (typeof output !== "object" || output === null || output.kind !== "tree") return false;
  return siblingParts.some(sibling => sibling.type === "data-vendo-view");
}

/**
 * LEAK 4's grounding carrier (spec §16 law 3): a text part the MODEL reads and
 * the person never sees. An affordance that opens the conversation about a
 * specific thing (the ✦ remix popover) has to tell the agent WHICH thing, and
 * the identifier for it is an app id — our plumbing, not something a person
 * types or reads. So it rides the sent message as its own text part, marked
 * here; the transcript skips it and `userText` (which seeds "edit last
 * message") leaves it out, so it stays out of every surface a person touches.
 *
 * A text part is the carrier because it is the ONLY channel that reaches the
 * model: `convertToModelMessages` keeps text and drops metadata and data parts.
 */
export const AGENT_CONTEXT_METADATA = { vendo: { agentContext: true } } as const;

/**
 * The SAME mark, in the text itself — 01-core's, re-exported so the chrome's
 * consumers keep the name they import today.
 *
 * THE HOLE the post-check found: `providerMetadata` is the only thing saying
 * "never show this", and a store that persists a text part as `{ type, text }`
 * — which the wire contract permits and several stores do — drops it. The
 * marked part then comes back as an ORDINARY text part, so a reloaded
 * transcript prints the app id, and "edit last message" seeds the composer
 * with it. That is the exact leak the carrier was invented to avoid, one
 * reload later.
 *
 * It lives in core (not here) because the SERVER needs it too: the thread title
 * is minted in @vendoai/agent, which had no concept of the mark and persisted
 * "[vendo:context] Declined to connect Gmail." into the thread rail.
 */
export { AGENT_CONTEXT_MARK };

/** The text part that carries grounding to the model and to nobody else. */
export function agentContextPart(context: string): { type: "text"; text: string; providerMetadata: typeof AGENT_CONTEXT_METADATA } {
  return {
    type: "text",
    text: context.startsWith(AGENT_CONTEXT_MARK) ? context : `${AGENT_CONTEXT_MARK} ${context}`,
    providerMetadata: AGENT_CONTEXT_METADATA,
  };
}

export function isAgentContext(part: UIMessage["parts"][number]): boolean {
  if (part.type !== "text") return false;
  const vendo = (part.providerMetadata as { vendo?: { agentContext?: unknown } } | undefined)?.vendo;
  return vendo?.agentContext === true || isAgentContextText(part.text);
}

/** The plain text a user turn carried, joined across its text parts — the seed
    for "edit last message" (ENG-215). */
export function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
      part.type === "text" && !isAgentContext(part))
    .map(part => part.text)
    .join("");
}

/** What "copy this turn" yields for an assistant message: its text parts (the
    markdown source), blank-line separated — tool beats and views don't copy. */
export function assistantText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("\n\n");
}

/** ENG-216 — the in-thread approval preview is built client-side (the wire part
    carries no descriptor), so format args as readable `Label: value` lines
    instead of the raw JSON with literal \n escapes end users were reading. */
export function preview(input: unknown): string {
  // ENG-216 — readable `Label: value` lines instead of raw JSON. ENG-218 — then
  // bound the result before it reaches the DOM: a huge argument blob (dumped
  // rows, base64) otherwise renders unbounded inside the approval card's <pre>,
  // blowing up layout and the node count.
  const formatted = previewArgs(input);
  return formatted.length > LONG_TEXT_CAP
    ? `${truncateHead(formatted)}\n… (${(formatted.length / 1000).toFixed(0)}k chars, truncated)`
    : formatted;
}
