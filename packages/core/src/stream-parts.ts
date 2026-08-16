import { z } from "zod";
import {
  appIdSchema,
  approvalIdSchema,
  grantIdSchema,
  isoDateTimeSchema,
  turnIdSchema,
  type AppId,
  type ApprovalId,
  type GrantId,
  type IsoDateTime,
  type TurnId,
} from "./ids.js";
import { knowledgeKindSchema, knowledgeVisibilitySchema, type KnowledgeKind, type KnowledgeVisibility } from "./knowledge.js";
import { riskLabelSchema, type RiskLabel } from "./tools.js";
import type { ToolCall } from "./tools.js";
import { uiPayloadSchema, type UIPayload } from "./genui/tree-node.js";
import { triggerSchema, type Trigger } from "./triggers.js";

/** 01-core §16 */
export interface VendoViewPart {
  type: "data-vendo-view";
  appId: AppId;
  payload: UIPayload;
  /** The turn that painted this view, so a screen on someone's page joins back
   *  to the exchange that made it and to that exchange's audit rows. Absent on a
   *  paint outside a turn (a reopen, a tour replay). */
  turnId?: TurnId;
}

/** 01-core §16 */
export const vendoViewPartSchema = z.object({
  type: z.literal("data-vendo-view"),
  appId: appIdSchema,
  payload: uiPayloadSchema,
  turnId: turnIdSchema.optional(),
}).passthrough() satisfies z.ZodType<VendoViewPart>;

/** The ai-SDK envelope the wire and persisted UIMessages ACTUALLY carry. The
 *  flat §16 interfaces above are the logical parts; on the wire the data-chunk
 *  schema
 *  requires the payload nested under `data`, with an optional reconciliation
 *  `id`. Producers convert with {@link toVendoWirePart}; consumers parse with
 *  {@link vendoViewWirePartSchema}. */
export interface VendoWirePart<Part extends { type: string }> {
  type: Part["type"];
  data: Omit<Part, "type">;
  /** Stable ai-SDK data-part id so successive writes reconcile in place. */
  id?: string;
}

export type VendoViewWirePart = VendoWirePart<VendoViewPart>;

/** Nest a flat §16 part into its wire envelope ({ type, ...rest } → { type, data: rest }). */
export function toVendoWirePart<Part extends { type: string }>(
  part: Part,
  id?: string,
): VendoWirePart<Part> {
  const { type, ...data } = part;
  return { type, data, ...(id === undefined ? {} : { id }) } as VendoWirePart<Part>;
}

const wirePartSchema = <Type extends string, Data extends z.ZodRawShape>(
  type: Type,
  data: z.ZodObject<Data>,
) => z.object({
  type: z.literal(type),
  data: data.passthrough(),
  id: z.string().optional(),
}).passthrough();

/**
 * Additive internal bridge seam: one tool execution can publish client parts
 * mid-flight, on the stream ids it names.
 *
 * It exists because `vendo_make`'s model-facing output is a {@link MakeReceipt} —
 * four fields of words. Anything the CLIENT needs and the model must not be handed
 * travels here instead, published explicitly by the producer rather than
 * duck-typed out of a tool's return value at the bridge (01-core §16's
 * anti-smuggling rule, which duck-typing was the exception to).
 */
export const VENDO_VIEW_STREAM = Symbol.for("@vendoai/core/vendo-view-stream");

/** What a tool execution may publish: the screen, the automation card an armed
 *  automation raises, and the limit card a refused generation raises. */
export type VendoStreamedPart = VendoViewPart | VendoAutomationPart | VendoLimitPart;

export interface VendoViewStreamUpdate {
  id: string;
  part: VendoStreamedPart;
}

export type VendoViewStreamingToolCall = ToolCall & {
  [VENDO_VIEW_STREAM]?: (update: VendoViewStreamUpdate) => void;
};

/** Stable ai-SDK data-part id so partial and final views reconcile in place. */
export const vendoViewStreamId = (appId: AppId): string => `vendo-view:${appId}`;

/**
 * THE producer of a `data-vendo-view` part — one builder, one validator.
 *
 * Four writers hand-wrote this object literal (the render seam, the create
 * door, the harness tool bridge, the authoring assembler) and only two of them
 * validated it, so a part that could never render was emitted by two paths and
 * silently dropped by a third. Building it here makes {@link
 * vendoViewPartSchema} unavoidable and derives the stream id from the app id,
 * which is the only correct source for it.
 *
 * A part that does not parse is NOT a view: this returns `undefined` and the
 * caller emits nothing, which is the law the render seam already lived by for
 * content that does not compile.
 *
 * `streaming` stays the CALLER's business — it rides inside `payload`, because
 * only the mid-build emitter knows whether this is the last paint.
 */
export const vendoViewPart = (input: {
  appId: AppId;
  payload: UIPayload;
  turnId?: TurnId;
}): { streamId: string; part: VendoViewPart } | undefined => {
  const parsed = vendoViewPartSchema.safeParse({
    type: "data-vendo-view",
    appId: input.appId,
    payload: input.payload,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  });
  if (!parsed.success) return undefined;
  return { streamId: vendoViewStreamId(parsed.data.appId), part: parsed.data };
};

/** 01-core §16 — the inline connect-card part: emitted beside the native tool
 * part when a connector call ends `connect-required` (04-actions §3), keyed by
 * `toolCallId` exactly like the approval part. */
export interface VendoConnectPart {
  type: "data-vendo-connect";
  toolCallId: string;
  connector: string;
  toolkit: string;
  message: string;
}

/** 01-core §16 */
export const vendoConnectPartSchema = z.object({
  type: z.literal("data-vendo-connect"),
  toolCallId: z.string(),
  connector: z.string().min(1),
  toolkit: z.string().min(1),
  message: z.string(),
}).passthrough() satisfies z.ZodType<VendoConnectPart>;

/** 01-core §16 */
export interface VendoApprovalPart {
  type: "data-vendo-approval";
  toolCallId: string;
  risk: RiskLabel;
  approvalId?: ApprovalId;
  invalidatedGrant?: {
    id: GrantId;
    grantedAt: IsoDateTime;
  };
}

/** 01-core §16 */
export const vendoApprovalPartSchema = z.object({
  type: z.literal("data-vendo-approval"),
  toolCallId: z.string(),
  risk: riskLabelSchema,
  approvalId: approvalIdSchema.optional(),
  invalidatedGrant: z.object({
    id: grantIdSchema,
    grantedAt: isoDateTimeSchema,
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<VendoApprovalPart>;

/** Streamed when the agent loop stops because it exhausted its step cap, so
 *  the exhaustion is visible to the client instead of the turn just ending
 *  mid-plan. Consumers
 *  that don't recognize it ignore it (§15 forward-compat). */
export interface VendoStepLimitPart {
  type: "data-vendo-step-limit";
  /** The step cap the run exhausted. */
  limit: number;
  /** A renderable, provider-safe explanation. */
  message: string;
}

export const vendoStepLimitPartSchema = z.object({
  type: z.literal("data-vendo-step-limit"),
  limit: z.number().int().positive(),
  message: z.string(),
}).passthrough() satisfies z.ZodType<VendoStepLimitPart>;

/** Streamed when a turn's stream errors, so the failure is part of the
 *  ASSISTANT MESSAGE rather than only ephemeral client state. The
 *  ai-SDK `error` chunk sets `useChat`'s transient `error` and is gone on the
 *  next mount, so a reloaded (or refetched) thread showed the user's question
 *  answered by a blank reply — the keyless install's whole first experience.
 *  `message` is the gated wire string (agent wireErrorMessage): Vendo's own
 *  crafted text or the fixed generic line, never provider internals.
 *  Consumers that don't recognize it ignore it (§15 forward-compat). */
export interface VendoTurnErrorPart {
  type: "data-vendo-turn-error";
  /** A renderable, provider-safe explanation of why the turn ended. */
  message: string;
}

export const vendoTurnErrorPartSchema = z.object({
  type: z.literal("data-vendo-turn-error"),
  message: z.string().min(1),
}).passthrough() satisfies z.ZodType<VendoTurnErrorPart>;

/** Streamed beside the native tool part when an app BUILD terminally fails in a
 *  chat turn, so the thread shows the classified reason instead of ending (or
 *  retrying for minutes) with no visible trace.
 *  `reason` is the runtime's canned, non-leaky failure line (06-apps
 *  buildFailureReason) — never a raw provider message. Consumers that don't
 *  recognize it ignore it (§15 forward-compat). */
export interface VendoBuildFailedPart {
  type: "data-vendo-build-failed";
  /** The failed `vendo_make` call, for placement beside its beat. */
  toolCallId: string;
  /** The renderable, provider-safe failure reason. */
  reason: string;
}

export const vendoBuildFailedPartSchema = z.object({
  type: z.literal("data-vendo-build-failed"),
  toolCallId: z.string(),
  reason: z.string().min(1),
}).passthrough() satisfies z.ZodType<VendoBuildFailedPart>;

/** Streamed when the host's limits policy DENIES a request — a message turned
 *  away before the turn starts, or an app generation refused mid-turn — so the
 *  thread says the cap was reached instead of answering with silence.
 *  `message` is the host policy's own sentence when it returned one: the host
 *  set the cap, so only the host can say what it is or when it lifts, and a
 *  policy that says nothing gets the chrome's own line instead. Consumers that
 *  don't recognize it ignore it (§15 forward-compat). */
export interface VendoLimitPart {
  type: "data-vendo-limit";
  /** The host policy's own explanation, when it gave one. */
  message?: string;
}

export const vendoLimitPartSchema = z.object({
  type: z.literal("data-vendo-limit"),
  message: z.string().optional(),
}).passthrough() satisfies z.ZodType<VendoLimitPart>;

/** Streamed when a turn creates or arms an automation, so the thread can
 *  render the automation AS an automation — name, trigger →
 *  action flow, enabled state — instead of describing it in prose. The chrome
 *  renders it with the same card vocabulary as the workspace Automations
 *  panel. Consumers that don't recognize it ignore it (§15 forward-compat). */
export interface VendoAutomationPart {
  type: "data-vendo-automation";
  appId: AppId;
  /** The automation document's display name. */
  name: string;
  /** Whether the automations engine reports it enabled. */
  enabled: boolean;
  /** The document's trigger (schedule/event → run), for the flow nodes. */
  trigger?: Trigger;
  /** The document's one-line description, when it has one. */
  description?: string;
  /** Standing-grant asks still undecided: the card reads
   *  "Enabled · waiting on N permissions" until the set is granted. */
  pendingGrants?: number;
}

export const vendoAutomationPartSchema = z.object({
  type: z.literal("data-vendo-automation"),
  appId: appIdSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
  // The trigger carries the automation's terms as words (`Trigger.rules`) — the
  // card lists them, and no second field on this part can disagree with it.
  trigger: triggerSchema.optional(),
  description: z.string().optional(),
  pendingGrants: z.number().int().nonnegative().optional(),
}).passthrough() satisfies z.ZodType<VendoAutomationPart>;

/** Streamed when arming an automation minted a grant SET — multiple
 *  standing-grant asks that one consent moment decides together. The chrome
 *  renders ONE card enumerating every permission with a single Approve/Deny;
 *  `toolCallId` keys it to the parked native call the
 *  decision settles, exactly like the approval part. Consumers that don't
 *  recognize it ignore it (§15 forward-compat). */
export interface VendoGrantSetPart {
  type: "data-vendo-grant-set";
  /** The parked native call this card settles, for placement beside its beat. */
  toolCallId: string;
  /** The set every permission below belongs to — one decision settles all
   *  (mirrors the automations engine's enable() grantSetId). */
  grantSetId: string;
  appId: AppId;
  /** The automation document's display name. */
  name: string;
  /** Every requested permission: its pending guard approval, the tool, the
   *  descriptor's one-line description, and its risk. */
  permissions: Array<{
    approvalId: ApprovalId;
    tool: string;
    description?: string;
    risk: RiskLabel;
  }>;
}

export const vendoGrantSetPartSchema = z.object({
  type: z.literal("data-vendo-grant-set"),
  toolCallId: z.string(),
  grantSetId: z.string().min(1),
  appId: appIdSchema,
  name: z.string().min(1),
  permissions: z.array(z.object({
    approvalId: approvalIdSchema,
    tool: z.string().min(1),
    description: z.string().optional(),
    risk: riskLabelSchema,
  }).passthrough()).min(1),
}).passthrough() satisfies z.ZodType<VendoGrantSetPart>;

/** The envelope tag `vendo_knowledge_search` carries on its ok-output. The agent
 *  tool-bridge keys on it to lift the FULL citation data onto the citations part
 *  below BEFORE the tool-output cap can truncate
 *  anything; named once here so producer (@vendoai/knowledge) and consumer
 *  (@vendoai/harnesses) never string-match each other. */
export const VENDO_KNOWLEDGE_RESULT_KIND = "vendo/knowledge-result@1" as const;

/** One citation as the UI receives it. `title` is required on this surface
 *  (chips render titles); the bridge falls back to the docId when an engine's
 *  hit carries none. `visibility` rides from KnowledgeHit.visibility so the
 *  popover origin line can state it instead of guessing. */
export interface VendoKnowledgeCitation {
  docId: string;
  chunkId?: string;
  title: string;
  source?: string;
  kind: KnowledgeKind;
  visibility: KnowledgeVisibility;
  snippet: string;
}

export const vendoKnowledgeCitationSchema = z.object({
  docId: z.string().min(1),
  chunkId: z.string().optional(),
  title: z.string().min(1),
  source: z.string().optional(),
  kind: knowledgeKindSchema,
  visibility: knowledgeVisibilitySchema,
  snippet: z.string(),
}).passthrough() satisfies z.ZodType<VendoKnowledgeCitation>;

/** Streamed beside the native tool part when a knowledge search resolves, so
 *  the thread renders
 *  citation chips (answered), the structured refusal line
 *  (insufficient-evidence), or the knowledge-unavailable flag (unavailable)
 *  from data — never from free text. Consumers that don't recognize it
 *  ignore it (§15 forward-compat). */
export interface VendoCitationsPart {
  type: "data-vendo-citations";
  /** The `vendo_knowledge_search` call, for placement beside its beat. */
  toolCallId: string;
  citations: VendoKnowledgeCitation[];
  outcome: "answered" | "insufficient-evidence" | "unavailable";
}

export const vendoCitationsPartSchema = z.object({
  type: z.literal("data-vendo-citations"),
  toolCallId: z.string(),
  citations: z.array(vendoKnowledgeCitationSchema),
  outcome: z.enum(["answered", "insufficient-evidence", "unavailable"]),
}).passthrough() satisfies z.ZodType<VendoCitationsPart>;

/** The nested wire envelope of {@link vendoViewPartSchema}. */
export const vendoViewWirePartSchema = wirePartSchema(
  "data-vendo-view",
  vendoViewPartSchema.omit({ type: true }),
) satisfies z.ZodType<VendoViewWirePart>;
