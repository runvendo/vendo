/**
 * The wire half of the runtime — build contract §1.6: "converts HarnessEvents
 * plus mirrored tool calls into the existing ai-SDK UIMessage stream with today's
 * `data-vendo-*` parts (packages/core/src/stream-parts.ts — UNCHANGED; no new
 * wire format)". Harness adapters contain no wire code; this is the only file
 * that knows what a chunk looks like.
 *
 * The `data-vendo-*` parts are NOT written here: the view channel, the approval
 * card, the connect card, the build-failed banner and the citations part all come
 * from the shipped bridge (`guardedCall`/`previewApproval` in @vendoai/agent), so
 * a harness turn produces the identical wire a `createAgent` turn does.
 *
 * ONE addition, and deliberately NOT in core's stream-parts.ts: `status` (§1.5)
 * has no existing part and must be screen-only. The ai-SDK's own
 * `transient: true` data chunk is exactly "delivered to the client, never added
 * to message history", so a transient `data-vendo-status` is the native
 * mechanism rather than a persisted format. See VENDO_STATUS_PART.
 */
import {
  toVendoWirePart,
  vendoViewStreamId,
  type AppId,
  type BeatPhase,
  type ToolOutcome,
  type ToolResult,
  type VendoViewPart,
} from "@vendoai/core";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import type { MirrorEvent } from "./turn-tools.js";

/**
 * The one wire name this lane adds. Transient, so it is screen-only by the SDK's
 * own rule and never lands in a persisted UIMessage — which is what §1.5 asks
 * for. It lives here rather than in core because §1.6 freezes stream-parts.ts.
 */
export const VENDO_STATUS_PART = "data-vendo-status" as const;

type Writer = UIMessageStreamWriter<UIMessage>;

/**
 * The assistant's words for one turn. A turn is NOT one text part: a reply that
 * spans tool calls must render as prose, then tool, then prose — so the channel
 * closes the current part whenever something else is mirrored and opens a fresh
 * one on the next delta. Collapsing it into a single part destroys the
 * interleaving the thread UI renders.
 */
export class TextChannel {
  private open = false;
  private index = 0;
  private id = "";

  constructor(private readonly writer: Writer) {}

  delta(delta: string): void {
    if (!this.open) {
      this.index += 1;
      this.id = `txt_${this.index}_${globalThis.crypto.randomUUID()}`;
      this.open = true;
      this.writer.write({ type: "text-start", id: this.id });
    }
    this.writer.write({ type: "text-delta", id: this.id, delta });
  }

  /** Close the current part, so whatever comes next renders after it. */
  break(): void {
    if (!this.open) return;
    this.open = false;
    this.writer.write({ type: "text-end", id: this.id });
  }

  end(): void {
    this.break();
  }
}

/**
 * §1.5 `status` → screen only — one BEAT.
 *
 * `phase` and `appId` ride the same transient part rather than a second channel:
 * a beat with a phase is still a beat, and the receiver reads one part type. Both
 * are omitted when absent, so a harness that only says `label` puts the exact
 * chunk on the wire it always did.
 */
export function writeStatus(writer: Writer, beat: { label: string; phase?: BeatPhase; appId?: AppId }): void {
  writer.write({
    type: VENDO_STATUS_PART,
    data: {
      label: beat.label,
      ...(beat.phase === undefined ? {} : { phase: beat.phase }),
      ...(beat.appId === undefined ? {} : { appId: beat.appId }),
    },
    transient: true,
  } as never);
}

/** §1.6 hot-path render seam — today's part, today's stable per-app stream id. */
export function writeView(writer: Writer, part: VendoViewPart): void {
  writer.write(toVendoWirePart(part, vendoViewStreamId(part.appId)) as never);
}

/**
 * §1.5 `error` → the screen's failure affordance. The ai-SDK error chunk is what
 * the thread UI renders as a banner with Retry and (for a Vendo-shaped message) a
 * detail line — the same affordance `createAgent`'s `onError` produces, carrying
 * the same `wireErrorMessage` string, meter-exhausted sentence included.
 */
export function writeError(writer: Writer, message: string): void {
  writer.write({ type: "error", errorText: message });
}

/**
 * Mirror one tool call onto the wire. Dynamic tools are the right shape: a
 * harness's tool set is resolved at runtime from the registry, exactly like the
 * agent bridge's `dynamicTool` calls, so hosts render these with the component
 * they already have.
 */
export function writeMirror(writer: Writer, event: MirrorEvent): void {
  if (event.kind === "call") {
    writer.write({
      type: "tool-input-start",
      toolCallId: event.toolCallId,
      toolName: event.name,
      dynamic: true,
    });
    writer.write({
      type: "tool-input-available",
      toolCallId: event.toolCallId,
      toolName: event.name,
      input: event.args as unknown,
      dynamic: true,
    });
    return;
  }
  if (event.kind === "approval") {
    writer.write({ type: "tool-approval-request", approvalId: event.approvalId, toolCallId: event.toolCallId });
    return;
  }
  writeToolResult(writer, event.toolCallId, event.result, event.outcome);
}

function writeToolResult(writer: Writer, toolCallId: string, result: ToolResult, outcome?: ToolOutcome): void {
  // `connect-required` is a typed outcome the SCREEN acts on, not a failure: the
  // shipped ConnectCard reads it off the native part (the ai-SDK path puts it
  // there too). Collapsing it into the model-facing `denied` leaves the user a
  // silent dead end with nothing to click.
  if (outcome?.status === "connect-required") {
    writer.write({ type: "tool-output-available", toolCallId, output: outcome, dynamic: true });
    return;
  }
  if (result.status === "ok") {
    writer.write({ type: "tool-output-available", toolCallId, output: result.output as unknown, dynamic: true });
    return;
  }
  if (result.status === "denied") {
    // `denied` is its own affordance: a refusal is not a failure, and rendering it
    // as one would tell the user something went wrong when nothing did.
    writer.write({ type: "tool-output-denied", toolCallId });
    return;
  }
  writer.write({ type: "tool-output-error", toolCallId, errorText: result.error.message, dynamic: true });
}
