import { AGENT_CONTEXT_MARK, isAgentContextText, isVendoAppsTool, riskLabelSchema, VENDO_APP_BUILD_FAILED_PREFIX, VENDO_MAKE_TOOL, type ApprovalRequest, type JsonSchema, type RiskLabel, type VendoCitationsPart, type VendoKnowledgeCitation } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { previewArgs } from "../humanize.js";
import { LONG_TEXT_CAP, truncateHead } from "../truncate.js";

export function partData(part: UIMessage["parts"][number]): unknown {
  return "data" in part ? part.data : part;
}

/** The marker the agent's `wireErrorMessage` puts on its OWN safe error text
 * (VendoError code + operator-crafted message). Only prefixed strings may be
 * shown in detail to an end user; raw transport/provider strings never carry
 * it. Read by both error surfaces (the banner and the turn-error part). */
export const VENDO_ERROR_PREFIX = "Vendo: ";

/**
 * The sentence a broken turn CARRIES, verbatim — minus the marker — or nothing.
 *
 * The marker says the sentence is OURS: a VendoError's operator-crafted message
 * plus its code, which is the one error shape a reader may see in detail. It
 * reaches them unedited. This used to look the code up in a dictionary of canned
 * first-person lines and print that instead, which spoke as the agent AND threw
 * the actionable half away — "Vendo: check ANTHROPIC_API_KEY in .env.local
 * (validation)" arrived as "I couldn't make that request work".
 *
 * An UNPREFIXED string is a raw transport/provider error (those carry request
 * URLs, keys and prompts), so it still yields nothing and the surface says
 * {@link TURN_FAILURE_NOTICE} in its own voice instead.
 */
export function turnErrorSentence(message: string | undefined): string | undefined {
  if (message === undefined || !message.startsWith(VENDO_ERROR_PREFIX)) return undefined;
  const body = message.slice(VENDO_ERROR_PREFIX.length).trim();
  return body.length === 0 ? undefined : body;
}

/** What the CHROME says when a turn broke with nothing of ours to repeat: the
 *  system in third person, never the agent in first. */
export const TURN_FAILURE_NOTICE = "This request couldn’t be completed — nothing was changed.";

/**
 * What a person is told when an app build fails: the runtime's own reason.
 *
 * `buildFailureReason` (apps' build-messages.ts) emits only classified,
 * non-leaky text — "timed out", "quota exhausted", the watchdog's line — and
 * passes the dev-model's actionable lines through verbatim (a missing
 * `@ai-sdk/*` package, a rejected key). Those are exactly what the reader needs,
 * and one canned first-person sentence used to replace all of them. The
 * operator's fuller record — the reason plus every blocking finding — keeps its
 * home in the server's `[vendo] app build failed (app_…)` line.
 *
 * A reason off the WIRE arrives behind the build-failed marker ("app build
 * failed: timed out"), because the bridge sends the VendoError's whole message;
 * the marker is plumbing, so it comes off.
 */
export function buildFailureNotice(reason: string | undefined): string {
  const marker = `${VENDO_APP_BUILD_FAILED_PREFIX}:`;
  const body = (reason ?? "").trim();
  const detail = (body.startsWith(marker) ? body.slice(marker.length) : body).trim();
  return detail.length === 0 ? "This view couldn’t be built — nothing was changed." : detail;
}

/**
 * What a person is told when the host's limits policy denies them: the host's
 * own sentence, verbatim.
 *
 * The host set the cap, so the host is the only one who can say what it is, or
 * when it lifts — the same reason `buildFailureNotice` above passes the
 * runtime's classified line through rather than replacing it with one canned
 * sentence. A policy that returned no message gets the chrome's own line, which
 * claims nothing it cannot know: only that the request never ran.
 */
export function limitNotice(message: string | undefined): string {
  const detail = (message ?? "").trim();
  return detail.length === 0 ? "This request wasn’t run — nothing was changed." : detail;
}

// A stable placeholder for the in-thread synthesized ApprovalRequest's required
// `createdAt`: the wire approval part carries no timestamp, and the value is
// never displayed (the card hides the context byline in-thread). Fixed, not
// `new Date()`, so it does not churn on every re-render.
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

    `descriptor` rides here too when the server has one: the wire parts are
    `.passthrough()`, so a newer server can send the declared
    schema/title/description with the ask and an older one simply omits it
    (buildApprovalRequest then degrades to host ToolMeta). */
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

/** What a turn's `data-vendo-citations` parts add up to. Chips render only
    ANSWERED citations (a refusal's weak hits stay off the chip row); the flags
    carry the refusal/outage states. */
export interface TurnKnowledgeSources {
  citations: VendoKnowledgeCitation[];
  refused: boolean;
  unavailable: boolean;
}

/** Fold a turn's citations parts into the one summary TurnCitations renders,
    deduped by doc+chunk across multiple knowledge calls in the same turn. */
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

/** Collapse runs of consecutive identical tool chips (e.g. eight
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

/** A call PARKED on the user — the one state whose consent card is the turn's
    live surface, so the turn's hover actions stand down and the beat above the
    card sits directly on it. Narrower than `toolCallPending` on purpose:
    pending is also true for a call abandoned mid-flight (Stop never reconciles
    an aborted call out of `input-available`), and gating the actions on that
    took Copy/Regenerate away from a stopped turn for good. */
export function toolCallParked(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part) && part.state === "approval-requested";
}

/** A call the HOST's OWN RULES refused — a policy block, a usage limit — which
    settles carrying the `blocked` outcome (harnesses/src/wire.ts). Distinct from
    `output-denied`, which the ai-SDK reserves for an approval the PERSON turned
    down: nobody asked them about this one, so the beat must not say they said
    no. */
export function toolCallRefused(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part) && part.state === "output-available"
    && (part.output as { status?: unknown } | null | undefined)?.status === "blocked";
}

/** A failed, refused or declined call is CONTENT, not progress: its beat stays
    visible after the turn folds, and it never counts as a thing the agent did.
    Everything else is progress, and progress folds into the summary. */
export function toolCallIsContent(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part)
    && (part.state === "output-error" || part.state === "output-denied" || toolCallRefused(part));
}

/** The app-building call this turn's app card is narrating. The card bar
    narrates that step ("Building your view…" → the app's name), so a beat
    beside it would narrate the same work twice; the settled summary still
    counts it. Recognized the way the server decides to emit the view part (the
    apps tool namespace + a tree surface), never by duck-typing an output.

    A running `vendo_make` is recognized by tool IDENTITY, before its output
    exists: it is the one tool that streams partial views, so the card is
    already up during the build window. No other apps tool streams a partial
    view, so for the rest the beat is the only narration until their tree lands
    — and a build parked on an approval or FAILED has no card, so its beat is
    the whole record. */
export function narratedByAppCard(
  part: UIMessage["parts"][number],
  siblingParts: UIMessage["parts"],
): boolean {
  if (!isToolUIPart(part)) return false;
  // A build that FAILED terminally narrates through its own
  // `data-vendo-build-failed` block, so the failed call's own ✕ beat would
  // print a second ✕ line. The part names the call it is about, so the
  // suppression is exact rather than a guess by tool identity.
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
    // `vendo_make` answers with a `MakeReceipt` — words, no tree — so a settled
    // build cannot be recognized by its output. The card's own part on the wire
    // is the test: if the view is there, that is what the reader is looking at.
    return siblingParts.some(sibling => sibling.type === "data-vendo-view");
  }
  if (part.state !== "output-available") return false;
  const output = part.output as { kind?: unknown } | null | undefined;
  if (typeof output !== "object" || output === null || output.kind !== "tree") return false;
  return siblingParts.some(sibling => sibling.type === "data-vendo-view");
}

/**
 * The grounding carrier: a text part the MODEL reads and the person never sees.
 * An affordance that opens the conversation about a specific thing (the ✦ remix
 * popover) has to tell the agent WHICH thing, and the identifier is an app id —
 * plumbing, not something a person types or reads. So it rides the sent message
 * as its own marked text part; the transcript skips it and `userText` (which
 * seeds "edit last message") leaves it out.
 *
 * A text part is the carrier because it is the ONLY channel that reaches the
 * model: `convertToModelMessages` keeps text and drops metadata and data parts.
 */
export const AGENT_CONTEXT_METADATA = { vendo: { agentContext: true } } as const;

/**
 * The SAME mark, in the text itself — core's, re-exported for the chrome's
 * consumers.
 *
 * `providerMetadata` alone is not enough: a store that persists a text part as
 * `{ type, text }` — which the wire contract permits — drops it, and the marked
 * part comes back as an ORDINARY text part, so a reloaded transcript prints the
 * app id. The mark lives in core because the SERVER needs it too: thread titles
 * are minted in @vendoai/agent.
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
    for "edit last message". */
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

/** The in-thread approval preview, built client-side: readable `Label: value`
    lines instead of raw JSON with literal \n escapes. */
export function preview(input: unknown): string {
  // Bound the result before it reaches the DOM: a huge argument blob (dumped
  // rows, base64) otherwise renders unbounded inside the approval card's <pre>,
  // blowing up layout and the node count.
  const formatted = previewArgs(input);
  return formatted.length > LONG_TEXT_CAP
    ? `${truncateHead(formatted)}\n… (${(formatted.length / 1000).toFixed(0)}k chars, truncated)`
    : formatted;
}
