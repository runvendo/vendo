import {
  toVendoWirePart,
  type Guard,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { isToolUIPart, type ToolSet, type UIMessage, type UIMessageStreamWriter } from "ai";
import { approvalPart, buildAgentTools, type ToolBridgeOptions } from "./tools.js";

/**
 * ENG-338 dev-mode rider seam (install-dx design §2, spike ENG-337).
 *
 * A "rider" is a persistent external model harness (Claude Agent SDK session,
 * codex app-server thread) that OWNS the model loop for a Vendo thread while
 * Vendo keeps owning tool execution and consent: every tool call the rider
 * surfaces is routed through the SAME guard.check → registry.execute path as
 * the native ai-SDK loop (buildAgentTools), so approval UI parts, grants,
 * audit, and abandoned-approval semantics are unchanged on the wire.
 *
 * The bridge below reproduces the native ai-SDK UI message chunk sequences
 * exactly (verified against the native loop):
 *
 *   text turn:  start / start-step / text-start / text-delta* / text-end /
 *               finish-step / finish{stop}
 *   tool run:   ... start-step / tool-input-available / tool-output-available /
 *               finish-step ...
 *   ask:        data-vendo-approval / start-step / tool-input-available /
 *               tool-approval-request / finish-step / finish{tool-calls}
 *   resume:     start{same messageId} / tool-output-available (or -denied) /
 *               start-step / text ... / finish{stop}
 *
 * Cross-request approval parking: the rider's tool callback stays pending
 * inside the persistent session while the HTTP stream that surfaced the
 * approval ends (finishReason "tool-calls", same as native). The next request
 * carrying the client's approval-responded tool part resolves the parked call
 * and streams the rest of the rider's turn onto the new response.
 */

/** Result handed back to the rider harness for one tool call. */
export interface RiderToolResult {
  /** Serialized tool outcome the model sees (same JSON as the native loop). */
  text: string;
  ok: boolean;
}

export interface RiderSessionStart {
  system: string;
  tools: ToolDescriptor[];
  /** The bridge's guarded executor; resolves when the tool call fully settles
   *  (which may be parked on a human approval for arbitrarily long). */
  onToolCall(call: { tool: string; args: unknown }): Promise<RiderToolResult>;
}

/** One persistent rider harness session, pinned to one Vendo thread. */
export interface RiderSession {
  start(options: RiderSessionStart): Promise<void>;
  runTurn(text: string, onTextDelta: (delta: string) => void): Promise<{ text: string }>;
  dispose(): Promise<void>;
}

/** Umbrella-owned session factory. Returning null falls back to the native
 *  streamText loop for this thread (e.g. env-key rungs need no rider). */
export type RiderSessionProvider = (input: { threadId: string }) => Promise<RiderSession | null>;

interface AttachedStream {
  writer: UIMessageStreamWriter<UIMessage>;
  /** Resolves the request's execute() promise, closing the SSE response. */
  finish(reason: "stop" | "tool-calls" | "error"): void;
  stepOpen: boolean;
  textId: string | null;
  textCount: number;
  closed: boolean;
}

interface ParkedCall {
  toolCallId: string;
  tool: string;
  args: unknown;
  resolve(result: RiderToolResult): void;
}

const deniedResult = (message: string): RiderToolResult => ({
  text: JSON.stringify({ status: "denied", message }),
  ok: false,
});

function randomId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export interface RiderBridgeConfig {
  registry: ToolRegistry;
  guard: Guard;
  toolOutputCap?: number;
  onCall?: ToolBridgeOptions["onCall"];
}

/** Per-thread bridge between one rider session and the Vendo wire. */
export class RiderThreadBridge {
  private readonly session: RiderSession;
  private readonly config: RiderBridgeConfig;
  private readonly parked = new Map<string, ParkedCall>();
  private attached: AttachedStream | null = null;
  private descriptors = new Map<string, ToolDescriptor>();
  private tools: ToolSet = {};
  private ctx: RunContext;
  private started = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** The in-flight rider turn (survives across requests while parked). */
  private turn: Promise<void> | null = null;

  constructor(session: RiderSession, config: RiderBridgeConfig, ctx: RunContext) {
    this.session = session;
    this.config = config;
    this.ctx = ctx;
  }

  private write(chunk: Record<string, unknown>): void {
    const attached = this.attached;
    if (attached === null || attached.closed) return;
    try {
      attached.writer.write(chunk as never);
    } catch {
      // A dead client stream must never take the rider turn down.
    }
  }

  private ensureStep(): void {
    const attached = this.attached;
    if (attached === null || attached.closed || attached.stepOpen) return;
    this.write({ type: "start-step" });
    attached.stepOpen = true;
  }

  private closeText(): void {
    const attached = this.attached;
    if (attached === null || attached.closed || attached.textId === null) return;
    this.write({ type: "text-end", id: attached.textId });
    attached.textId = null;
  }

  private closeStep(): void {
    const attached = this.attached;
    if (attached === null || attached.closed) return;
    this.closeText();
    if (attached.stepOpen) {
      this.write({ type: "finish-step" });
      attached.stepOpen = false;
    }
  }

  private finishAttached(reason: "stop" | "tool-calls" | "error"): void {
    const attached = this.attached;
    if (attached === null || attached.closed) return;
    this.closeStep();
    this.write({ type: "finish", finishReason: reason });
    attached.closed = true;
    this.attached = null;
    attached.finish(reason);
  }

  private onTextDelta = (delta: string): void => {
    const attached = this.attached;
    if (attached === null || attached.closed || delta.length === 0) return;
    this.ensureStep();
    if (attached.textId === null) {
      attached.textCount += 1;
      attached.textId = `text_${attached.textCount}`;
      this.write({ type: "text-start", id: attached.textId });
    }
    this.write({ type: "text-delta", id: attached.textId, delta });
  };

  /** Rebuild the guarded tool executors against the CURRENT request's ctx so
   *  present-credential forwarding and audit reflect the live request, exactly
   *  like the native loop rebuilding its ToolSet per request. */
  private async refreshTools(ctx: RunContext): Promise<void> {
    this.ctx = ctx;
    const writerProxy: Pick<UIMessageStreamWriter<UIMessage>, "write"> = {
      write: (chunk) => this.write(chunk as never),
    };
    this.tools = await buildAgentTools({
      registry: this.config.registry,
      guard: this.config.guard,
      ctx,
      writer: writerProxy as UIMessageStreamWriter<UIMessage>,
      ...(this.config.toolOutputCap === undefined ? {} : { toolOutputCap: this.config.toolOutputCap }),
      ...(this.config.onCall === undefined ? {} : { onCall: this.config.onCall }),
    });
    if (this.descriptors.size === 0) {
      for (const descriptor of await this.config.registry.descriptors()) {
        this.descriptors.set(descriptor.name, descriptor);
      }
    }
  }

  /** Execute one settled (non-parked) tool call through the same guarded
   *  executor the native loop uses; returns the model-facing outcome. */
  private async executeGuarded(
    tool: string,
    args: unknown,
    toolCallId: string,
  ): Promise<ToolOutcome> {
    const executor = this.tools[tool]?.execute as
      | ((input: unknown, options: { toolCallId: string }) => Promise<ToolOutcome>)
      | undefined;
    if (executor === undefined) {
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${tool}` } };
    }
    try {
      return await executor(args, { toolCallId });
    } catch {
      return { status: "error", error: { code: "execution", message: "Tool execution failed." } };
    }
  }

  /** The rider's tool callback: guard first (native needsApproval parity),
   *  then execute or park. */
  private onToolCall = async (call: { tool: string; args: unknown }): Promise<RiderToolResult> => {
    const toolCallId = randomId("call");
    const descriptor = this.descriptors.get(call.tool);
    if (descriptor === undefined) {
      return {
        text: JSON.stringify({
          status: "error",
          error: { code: "not-found", message: `Unknown tool: ${call.tool}` },
        }),
        ok: false,
      };
    }

    let ask = false;
    try {
      const decision = await this.config.guard.check(
        { id: toolCallId, tool: call.tool, args: call.args },
        descriptor,
        this.ctx,
      );
      if (decision.action === "ask") {
        ask = true;
        // Same wire part the native needsApproval path writes (core §16).
        this.write({ ...toVendoWirePart(approvalPart(
          toolCallId,
          descriptor.risk,
          decision.approval.id,
          decision.approval.invalidatedGrant,
        )) });
      }
    } catch {
      // Native parity: a guard failure fails CLOSED into the ask flow.
      ask = true;
    }

    if (!ask) {
      this.closeStep();
      this.ensureStep();
      this.write({ type: "tool-input-available", toolCallId, toolName: call.tool, input: call.args, dynamic: true });
      const outcome = await this.executeGuarded(call.tool, call.args, toolCallId);
      this.write({ type: "tool-output-available", toolCallId, output: outcome, dynamic: true });
      this.closeStep();
      return { text: JSON.stringify(outcome), ok: outcome.status === "ok" };
    }

    // Park: surface the approval, end this response like the native loop
    // (finishReason "tool-calls"), and hold the rider until the decision
    // arrives on a later request (or the approval is abandoned).
    this.closeStep();
    this.ensureStep();
    this.write({ type: "tool-input-available", toolCallId, toolName: call.tool, input: call.args, dynamic: true });
    this.write({ type: "tool-approval-request", approvalId: randomId("aprq"), toolCallId });
    const parked = new Promise<RiderToolResult>((resolve) => {
      this.parked.set(toolCallId, { toolCallId, tool: call.tool, args: call.args, resolve });
    });
    this.finishAttached("tool-calls");
    return parked;
  };

  private async ensureStarted(system: string): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.session.start({
      system,
      tools: [...this.descriptors.values()],
      onToolCall: this.onToolCall,
    });
  }

  /** Resolve every parked approval as abandoned (the user moved on) — the
   *  stored parts were already rewritten by abandonPendingApprovals; the rider
   *  gets the same denial the native model history shows. The rider's reply to
   *  that denial belongs to the abandoned turn and is never streamed. */
  private abandonParked(): void {
    for (const parked of this.parked.values()) {
      parked.resolve(deniedResult("The user did not approve this tool call."));
    }
    this.parked.clear();
  }

  /** Launch one rider turn; its then/catch closes the attached stream when
   *  the turn completes (or fails), matching the native loop's finish wire. */
  private launchTurn(text: string): void {
    this.turn = this.session
      .runTurn(text, this.onTextDelta)
      .then(() => {
        this.turn = null;
        this.finishAttached("stop");
      })
      .catch((error: unknown) => {
        this.turn = null;
        // Rider failures are dev-mode infrastructure: keep the wire generic
        // but give the operator the real cause on the server log.
        console.error("[vendo] dev-mode rider turn failed:", error);
        this.write({ type: "error", errorText: "An error occurred while generating the response." });
        this.finishAttached("error");
      });
  }

  /** One user turn. Resolves when THIS response should close. */
  handleUserTurn(input: {
    message: UIMessage;
    system: string;
    ctx: RunContext;
    writer: UIMessageStreamWriter<UIMessage>;
  }): Promise<void> {
    return this.enqueueRequest(async (finish) => {
      this.abandonParked();
      if (this.turn !== null) {
        // Drain the abandoned turn without a stream attached; its trailing
        // text is deliberately dropped (native parity: the model never spoke).
        await this.turn.catch(() => undefined);
        this.turn = null;
      }
      await this.refreshTools(input.ctx);
      await this.ensureStarted(input.system);

      const text = input.message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
      this.attach(input.writer, randomId("msg"), finish);
      this.launchTurn(text);
      // The response stays open until the turn completes or parks
      // (finishAttached resolves `finish` in both cases).
    });
  }

  /** An approval-responded resubmission: settle parked calls and stream the
   *  rest of the rider's turn onto this response. */
  handleApprovalResponse(input: {
    message: UIMessage;
    system: string;
    ctx: RunContext;
    writer: UIMessageStreamWriter<UIMessage>;
  }): Promise<void> {
    return this.enqueueRequest(async (finish) => {
      await this.refreshTools(input.ctx);
      this.attach(input.writer, input.message.id, finish);

      const responses = input.message.parts.filter(
        (part) => isToolUIPart(part) && part.state === "approval-responded",
      ) as Array<{
        toolCallId: string;
        toolName: string;
        input?: unknown;
        approval?: { approved?: boolean };
      }>;
      let sawLiveTurn = this.turn !== null;
      for (const part of responses) {
        const { toolCallId, toolName } = part;
        const approved = part.approval?.approved === true;
        const parkedInput = part.input;
        const parked = this.parked.get(toolCallId);
        this.parked.delete(toolCallId);

        let outcome: ToolOutcome | null = null;
        if (approved) {
          outcome = await this.executeGuarded(toolName, parked?.args ?? parkedInput, toolCallId);
          this.write({ type: "tool-output-available", toolCallId, output: outcome, dynamic: true });
        } else {
          this.write({ type: "tool-output-denied", toolCallId });
        }

        if (parked !== undefined) {
          parked.resolve(
            outcome === null
              ? deniedResult("The user declined this tool call.")
              : { text: JSON.stringify(outcome), ok: outcome.status === "ok" },
          );
        } else if (this.turn === null) {
          // The park did not survive (dev-server restart): the tool outcome is
          // settled above through the same guarded path; hand the rider a
          // fresh turn carrying the settlement so it can continue the thread.
          await this.ensureStarted(input.system);
          sawLiveTurn = true;
          this.launchTurn(
            outcome === null
              ? `[system] The user declined your earlier ${toolName} call. Continue helping the user.`
              : `[system] The user approved your earlier ${toolName} call; it ran with result ${JSON.stringify(outcome)}. Continue helping the user.`,
          );
        }
      }

      if (!sawLiveTurn && this.turn === null) {
        // Nothing to resume (no parked call, no restart fallback started).
        this.finishAttached("stop");
      }
      // Otherwise the live (or fallback) turn closes this response when it
      // completes or parks again — finishAttached targets the attached stream.
    });
  }

  private attach(
    writer: UIMessageStreamWriter<UIMessage>,
    messageId: string,
    finish: (reason: string) => void,
  ): void {
    this.attached = {
      writer,
      finish: finish as AttachedStream["finish"],
      stepOpen: false,
      textId: null,
      textCount: 0,
      closed: false,
    };
    this.write({ type: "start", messageId });
  }

  /** Wrap one HTTP request: the returned promise resolves when the response
   *  should close (turn finished OR parked), NOT when the rider turn ends.
   *  Requests are serialized — a thread has at most one rider turn in flight. */
  private enqueueRequest(
    handler: (finish: (reason: string) => void) => Promise<void>,
  ): Promise<void> {
    const run = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        handler(() => resolve()).catch(reject);
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async dispose(): Promise<void> {
    this.abandonParked();
    await this.session.dispose();
  }
}

/** True when the submitted message is the client's approval-responded
 *  resubmission of the paused assistant message (native resume trigger). */
export function isApprovalResponseMessage(message: UIMessage): boolean {
  return (
    message.role === "assistant" &&
    message.parts.some((part) => isToolUIPart(part) && part.state === "approval-responded")
  );
}
