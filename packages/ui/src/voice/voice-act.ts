/** ENG-319 — the realtime tool-call bridge: a live voice session acts through
    Vendo. The realtime model gets ONE function tool, `vendo_act`; every call
    runs a REAL agent turn over the wire (03 §4) — the same guarded pipeline the
    chat surface rides. Views the agent mints stream into the stage feed;
    approvals the guard parks land in the standing queue, where the stage's
    consent bar (already polling, ENG-229) decides them; the turn then resumes
    exactly like the thread surface does — the assistant message upserted with
    the approval response (AGENT-12), with the guard authoritative over the
    recorded decision (05 §1). No new server surface, no contract change. */
import { DefaultChatTransport, isToolUIPart, readUIMessageStream, type UIMessage } from "ai";
import type { VendoClient } from "../client.js";
import type { VoiceConnectRequest, VoiceSessionView, VoiceToolBridge } from "./driver.js";

const THREAD_ID_HEADER = "x-vendo-thread-id";
const THREAD_ID_PATTERN = /^thr_.+$/;
const DECIDE_POLL_MS = 1_200;
const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_RESUMES = 4;

export interface VoiceActBridgeOptions {
  client: VendoClient;
  /** Continue an existing conversation; a fresh server-minted thread otherwise. */
  threadId?: string;
  /** Poll cadence while waiting for a parked approval's decision. */
  decidePollMs?: number;
  /** Give up waiting for a decision after this long (the call is denied as unanswered). */
  approvalTimeoutMs?: number;
}

const VENDO_ACT_TOOL = {
  type: "function",
  name: "vendo_act",
  description:
    "Act inside this product on the user's behalf: look things up, draft or send things, build or "
    + "update views. Describe what to do in plain language. Actions that need the user's permission "
    + "will ask them on screen — report what the result says, including anything still awaiting "
    + "approval or denied.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "What to do, in plain language, with every detail the user gave.",
      },
    },
    required: ["request"],
  },
} satisfies Record<string, unknown>;

interface PendingApproval {
  messageId: string;
  toolCallId: string;
  guardApprovalId?: string;
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function partData(part: UIMessage["parts"][number]): unknown {
  return "data" in part ? part.data : part;
}

function viewsOf(message: UIMessage, turn: number): VoiceSessionView[] {
  const views: VoiceSessionView[] = [];
  message.parts.forEach((part, index) => {
    if (part.type !== "data-vendo-view") return;
    const data = partData(part) as { appId?: unknown; payload?: unknown };
    if (typeof data.appId !== "string" || data.payload === undefined) return;
    // Same id across resume passes of the same turn: the feed replaces, not stacks.
    views.push({
      id: `act-${turn}-${index}`,
      appId: data.appId,
      payload: data.payload as VoiceSessionView["payload"],
    });
  });
  return views;
}

/** Voice-lane Cn-A — connector calls that ended `connect-required`, mirroring
    ThreadConnectRequests' detection (04-actions §3): the typed outcome on the
    native tool part is the source of truth. */
function connectRequestsOf(message: UIMessage): VoiceConnectRequest[] {
  return message.parts
    .filter(isToolUIPart)
    .flatMap((part) => {
      if (part.state !== "output-available") return [];
      const output = part.output as { status?: unknown; connect?: unknown } | undefined;
      const connect = output?.status === "connect-required"
        ? output.connect as { connector?: unknown; toolkit?: unknown; message?: unknown } | undefined
        : undefined;
      if (typeof connect?.connector !== "string" || typeof connect.toolkit !== "string") return [];
      return [{
        id: `connect-${part.toolCallId}`,
        connector: connect.connector,
        toolkit: connect.toolkit,
        message: typeof connect.message === "string" ? connect.message : `Connect ${connect.toolkit} to continue.`,
      }];
    });
}

function pendingApprovalsOf(message: UIMessage): PendingApproval[] {
  const guardIds = new Map<string, string>();
  for (const part of message.parts) {
    if (part.type !== "data-vendo-approval") continue;
    const data = partData(part) as { toolCallId?: unknown; approvalId?: unknown };
    if (typeof data.toolCallId === "string" && typeof data.approvalId === "string") {
      guardIds.set(data.toolCallId, data.approvalId);
    }
  }
  const pending: PendingApproval[] = [];
  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.state !== "approval-requested") continue;
    const guardApprovalId = guardIds.get(part.toolCallId);
    pending.push({
      messageId: message.id,
      toolCallId: part.toolCallId,
      ...(guardApprovalId === undefined ? {} : { guardApprovalId }),
    });
  }
  return pending;
}

/** Flip every requested approval on the message to a response — the resume
    upsert AGENT-12 accepts. `approved` here only resumes the loop; the guard's
    recorded decision (made in the consent bar) is what actually executes. */
function answerApprovals(message: UIMessage, approved: boolean): UIMessage {
  const parts = message.parts.map((part) => {
    if (!isToolUIPart(part) || part.state !== "approval-requested") return part;
    return {
      ...part,
      state: "approval-responded",
      approval: { id: part.approval.id, approved },
    };
  });
  return { ...message, parts: parts as UIMessage["parts"] };
}

export function createVoiceActBridge(options: VoiceActBridgeOptions): VoiceToolBridge {
  const { client } = options;
  const decidePollMs = options.decidePollMs ?? DECIDE_POLL_MS;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
  let threadId = options.threadId;
  // The running voice conversation, one entry per completed turn message.
  const messages: UIMessage[] = [];
  let turn = 0;

  const transport = new DefaultChatTransport<UIMessage>({
    api: `${client.baseUrl.replace(/\/$/, "")}/threads`,
    headers: client.headers,
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const returned = response.headers.get(THREAD_ID_HEADER);
      if (returned !== null && THREAD_ID_PATTERN.test(returned)) threadId = returned;
      return response;
    },
    prepareSendMessagesRequest: ({ messages: outgoing }) => {
      const message = outgoing.at(-1);
      if (!message) throw new Error("Cannot send an empty voice turn.");
      return {
        body: threadId === undefined ? { message } : { threadId, message },
        headers: { ...client.headers },
      };
    },
  });

  /** One wire round trip: stream the turn, return the settled assistant message. */
  async function runTurn(): Promise<UIMessage> {
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: threadId ?? "voice",
      messageId: undefined,
      messages,
      abortSignal: undefined,
    });
    let last: UIMessage | undefined;
    for await (const snapshot of readUIMessageStream({ stream })) {
      last = snapshot;
    }
    if (last === undefined || last.role !== "assistant") {
      throw new Error("The agent turn produced no assistant message.");
    }
    return last;
  }

  /** Wait for the consent bar's decision: a parked guard approval leaving the
      standing queue means it was decided (either way — the guard enforces
      which on resume). Times out to "unanswered". */
  async function waitForDecision(guardApprovalId: string): Promise<boolean> {
    const deadline = Date.now() + approvalTimeoutMs;
    while (Date.now() < deadline) {
      const pending = await client.approvals.pending().catch(() => undefined);
      if (pending !== undefined && !pending.some((request) => request.id === guardApprovalId)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, decidePollMs));
    }
    return false;
  }

  /** Voice-lane Cn-A — the stage's docked ConnectCard runs the OAuth loop;
      here we only wait for the toolkit's connection to report `active`, then
      resume the turn so the blocked call re-executes. Same pacing knobs as
      approvals; times out to "not connected". */
  async function waitForConnection(toolkit: string): Promise<boolean> {
    const deadline = Date.now() + approvalTimeoutMs;
    while (Date.now() < deadline) {
      const accounts = await client.connections.list().catch(() => undefined);
      if (accounts?.some((account) => account.toolkit === toolkit && account.status === "active")) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, decidePollMs));
    }
    return false;
  }

  return {
    tools: [VENDO_ACT_TOOL],
    async onToolCall(call, session) {
      if (call.name !== "vendo_act") {
        return { error: `Unknown tool: ${call.name}` };
      }
      const request = String((call.args as { request?: unknown } | undefined)?.request ?? "").trim();
      if (request.length === 0) return { error: "vendo_act needs a request." };

      turn += 1;
      messages.push({
        id: `voice-act-${turn}`,
        role: "user",
        parts: [{ type: "text", text: request }],
      });

      let assistant = await runTurn();
      messages.push(assistant);
      const emitted = new Set<string>();
      const emitViews = (message: UIMessage) => {
        for (const view of viewsOf(message, turn)) {
          if (emitted.has(view.id)) continue;
          emitted.add(view.id);
          session.emitView(view);
        }
      };
      emitViews(assistant);

      let unanswered = 0;
      let unconnected = 0;
      const surfacedConnects = new Set<string>();
      for (let resume = 0; resume < MAX_RESUMES; resume += 1) {
        // Cn-A: connector calls blocked on a connection — dock the card on the
        // stage, wait for the account to go active, then resume the turn.
        const connects = connectRequestsOf(assistant).filter((c) => !surfacedConnects.has(c.id));
        if (connects.length > 0) {
          for (const connect of connects) {
            surfacedConnects.add(connect.id);
            session.emitConnect?.(connect);
          }
          let allConnected = true;
          for (const connect of connects) {
            if (!(await waitForConnection(connect.toolkit))) allConnected = false;
          }
          if (allConnected) {
            messages.push({
              id: `voice-act-${turn}-connect-${resume}`,
              role: "user",
              parts: [{ type: "text", text: "The account is connected now — retry what was blocked." }],
            });
            assistant = await runTurn();
            messages.push(assistant);
            emitViews(assistant);
            continue;
          }
          unconnected += connects.length;
        }
        const pending = pendingApprovalsOf(assistant);
        if (pending.length === 0) break;
        // The guard's parked records are already on the consent bar via the
        // stage's polling — wait for the user to decide there.
        let allDecided = true;
        for (const approval of pending) {
          const decided = approval.guardApprovalId === undefined
            ? false
            : await waitForDecision(approval.guardApprovalId);
          if (!decided) allDecided = false;
        }
        if (!allDecided) unanswered += pending.length;
        // Resume the parked turn: upsert the assistant message with the
        // approvals answered (approved resumes; an actually-denied guard
        // record still blocks the call server-side).
        const responded = answerApprovals(assistant, allDecided);
        messages[messages.length - 1] = responded;
        assistant = await runTurn();
        // The continuation may re-stream the same assistant message (upsert)
        // or mint a fresh one — mirror whichever the server did.
        if (messages.at(-1)?.id === assistant.id) messages[messages.length - 1] = assistant;
        else messages.push(assistant);
        emitViews(assistant);
      }

      const spoken = textOf(assistant);
      const notes = [
        ...(unanswered > 0 ? [`${unanswered} permission request(s) went unanswered and were not executed.`] : []),
        ...(unconnected > 0 ? [`${unconnected} action(s) are waiting on an account connection and were not executed.`] : []),
      ];
      return {
        result: spoken.length > 0 ? spoken : "Done.",
        viewsShown: emitted.size,
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };
    },
  };
}
