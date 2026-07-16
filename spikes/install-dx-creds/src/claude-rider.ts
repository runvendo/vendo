/**
 * SPIKE rung 2 — persistent-process provider over the Claude Agent SDK,
 * riding the machine's authed `claude` login (no ANTHROPIC_API_KEY).
 *
 * Shape: one long-lived query() in streaming-input mode = one persistent
 * session. Vendo host tools are bridged via an in-process MCP server
 * (createSdkMcpServer). Vendo's consent semantics ride the canUseTool
 * permission callback: read-risk tools resolve immediately, write-risk tools
 * PARK on the ApprovalBroker until the (simulated) user approves.
 */

import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ApprovalBroker, executeSpikeTool } from "./vendo-tools.js";
import { now, type TurnMetrics } from "./metrics.js";

const SYSTEM_APPEND = [
  "You are Vendo's embedded product agent for a demo bank.",
  "Only use the provided vendo tools. Never use shell, file or web tools.",
  "Answer in one short sentence.",
].join(" ");

interface PendingTurn {
  startedAt: number;
  ttftMs: number | null;
  answer: string;
  toolCalls: string[];
  resolve: (m: Omit<TurnMetrics, "rung" | "scenario" | "trial">) => void;
}

export class ClaudeRider {
  readonly broker = new ApprovalBroker();
  private q: Query | null = null;
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private pending: PendingTurn | null = null;
  public model: string | undefined;
  public approvalDelayMs: number;

  constructor(opts: { approvalDelayMs?: number } = {}) {
    this.approvalDelayMs = opts.approvalDelayMs ?? 0;
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  /** Spawn the persistent session. Resolves once the SDK reports init. */
  async start(): Promise<{ spawnMs: number; model: string | undefined }> {
    const t0 = now();
    const vendoServer = createSdkMcpServer({
      name: "vendo",
      version: "0.0.0",
      tools: [
        tool(
          "payments_list",
          "List the user's recent payments (read-only).",
          { limit: z.number().optional() },
          async (args) => ({
            content: [
              { type: "text", text: JSON.stringify(executeSpikeTool("vendo_payments_list", args)) },
            ],
          }),
        ),
        tool(
          "payments_send",
          "Send a payment to a payee. DESTRUCTIVE: moves real money.",
          { payee: z.string(), amountCents: z.number() },
          async (args) => {
            this.broker.mark("tool-executed", "payments_send");
            return {
              content: [
                { type: "text", text: JSON.stringify(executeSpikeTool("vendo_payments_send", args)) },
              ],
            };
          },
        ),
      ],
    });

    this.q = query({
      prompt: this.input(),
      options: {
        mcpServers: { vendo: vendoServer },
        // Keep the ridden harness tool-less apart from our bridge: no
        // filesystem/shell/web tools are permitted (defense in depth: the
        // canUseTool below also denies anything that is not mcp__vendo__*).
        disallowedTools: [
          "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch",
          "WebSearch", "Task", "TodoWrite", "NotebookEdit", "KillShell",
          "BashOutput", "ExitPlanMode",
        ],
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
        // Isolation: do not load the machine's user/project settings or hooks.
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 100,
        stderr: (data: string) => {
          if (process.env.SPIKE_DEBUG) console.error(`[claude stderr] ${data}`);
        },
        // Vendo consent projection lives here. This is the survival test:
        // a destructive call PARKS on the broker and resumes on approval.
        canUseTool: async (toolName, input) => {
          this.pending?.toolCalls.push(toolName);
          if (!toolName.startsWith("mcp__vendo__")) {
            this.broker.mark("tool-denied", toolName);
            return { behavior: "deny", message: "Only vendo tools are permitted." };
          }
          if (toolName === "mcp__vendo__payments_send") {
            const id = `apr_${Date.now()}`;
            if (this.approvalDelayMs > 0) this.broker.autoApproveAfter(id, this.approvalDelayMs);
            const approved = await this.broker.waitForDecision(id);
            if (!approved) {
              return { behavior: "deny", message: "The user declined this payment." };
            }
            return { behavior: "allow", updatedInput: input };
          }
          this.broker.mark("tool-auto-allowed", toolName);
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    // In streaming-input mode the SDK emits nothing (not even system:init)
    // until the first user message is yielded — do NOT block on init here.
    void this.consume(() => {});
    return { spawnMs: now() - t0, model: this.model };
  }

  private async consume(onInit: () => void): Promise<void> {
    if (!this.q) return;
    try {
      for await (const message of this.q as AsyncIterable<SDKMessage>) {
        if (message.type === "system" && message.subtype === "init") {
          this.model = (message as { model?: string }).model;
          onInit();
        } else if (message.type === "stream_event") {
          const event = (message as { event?: { type?: string; delta?: { type?: string } } }).event;
          if (
            this.pending &&
            this.pending.ttftMs === null &&
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            this.pending.ttftMs = now() - this.pending.startedAt;
          }
        } else if (message.type === "assistant") {
          const content = (message as { message: { content: Array<{ type: string; text?: string }> } })
            .message.content;
          for (const block of content) {
            if (block.type === "text" && block.text) this.pending && (this.pending.answer = block.text);
          }
        } else if (message.type === "result") {
          const r = message as {
            usage?: unknown;
            total_cost_usd?: number;
            result?: string;
            subtype: string;
          };
          const p = this.pending;
          this.pending = null;
          p?.resolve({
            ttftMs: p.ttftMs,
            totalMs: now() - p.startedAt,
            model: this.model,
            usage: { usage: r.usage, totalCostUsd: r.total_cost_usd, subtype: r.subtype },
            answer: r.result ?? p.answer,
            notes: `tools=[${p.toolCalls.join(",")}]`,
          });
        }
      }
    } catch (err) {
      const p = this.pending;
      this.pending = null;
      p?.resolve({
        ttftMs: p.ttftMs,
        totalMs: now() - p.startedAt,
        answer: "",
        notes: `stream error: ${String(err)}`,
      });
    }
  }

  /** Send one user turn into the live session and wait for its result. */
  sendTurn(text: string): Promise<Omit<TurnMetrics, "rung" | "scenario" | "trial">> {
    return new Promise((resolve) => {
      this.pending = { startedAt: now(), ttftMs: null, answer: "", toolCalls: [], resolve };
      this.queue.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      this.wake?.();
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.wake?.();
    try {
      await this.q?.interrupt();
    } catch {
      /* already gone */
    }
  }
}
