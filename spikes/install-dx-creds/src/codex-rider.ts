/**
 * SPIKE rung 3 — persistent-process provider over `codex app-server`
 * (codex-cli 0.144.4), riding the machine's ChatGPT-plan login.
 *
 * Protocol facts verified against `codex app-server generate-ts` output for
 * the installed binary (see REPORT.md):
 * - newline-delimited JSON-RPC 2.0 over stdio
 * - initialize {clientInfo, capabilities:{experimentalApi:true}} → "initialized" notification
 * - thread/start {dynamicTools:[...], approvalPolicy, sandbox, ephemeral}
 *   (dynamicTools is experimental: gated on capabilities.experimentalApi)
 * - turn/start {threadId, input:[{type:"text",text,text_elements:[]}]}
 * - server → client REQUEST "item/tool/call" (DynamicToolCallParams) for each
 *   dynamic tool invocation; the client's delayed response IS the approval park
 * - notifications: item/agentMessage/delta (TTFT), turn/completed (turn end)
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ApprovalBroker, executeSpikeTool, SPIKE_TOOLS } from "./vendo-tools.js";
import { now, type TurnMetrics } from "./metrics.js";

type Json = Record<string, unknown>;

interface PendingTurn {
  startedAt: number;
  ttftMs: number | null;
  answer: string;
  toolCalls: string[];
  resolve: (m: Omit<TurnMetrics, "rung" | "scenario" | "trial">) => void;
}

export class CodexRider {
  readonly broker = new ApprovalBroker();
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private nextId = 1;
  private inflight = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private threadId: string | null = null;
  private pending: PendingTurn | null = null;
  private model: string | undefined;
  public approvalDelayMs: number;

  constructor(opts: { approvalDelayMs?: number } = {}) {
    this.approvalDelayMs = opts.approvalDelayMs ?? 0;
  }

  private send(obj: Json): void {
    this.child?.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private request(method: string, params: Json | null): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, ...(params === null ? {} : { params }) });
    });
  }

  async start(): Promise<{ spawnMs: number; model: string | undefined }> {
    const t0 = now();
    this.child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        return;
      }
      void this.onMessage(msg);
    });

    await this.request("initialize", {
      clientInfo: { name: "vendo-spike", title: "Vendo install-dx spike", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ jsonrpc: "2.0", method: "initialized" });

    const started = await this.request("thread/start", {
      cwd: process.cwd(),
      ephemeral: true,
      // No filesystem/shell surface for the agent; Vendo tools only.
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      developerInstructions:
        "You are Vendo's embedded product agent for a demo bank. Only use the provided vendo tools. Never run commands or read files. Answer in one short sentence.",
      dynamicTools: SPIKE_TOOLS.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    this.model = (started as { model?: string }).model;
    this.threadId = (started as { thread?: { id?: string } }).thread?.id ?? null;
    if (!this.threadId) throw new Error(`thread/start gave no thread id: ${JSON.stringify(started)}`);
    return { spawnMs: now() - t0, model: this.model };
  }

  private async onMessage(msg: Json): Promise<void> {
    // Response to one of our requests
    if (typeof msg.id === "number" && !("method" in msg)) {
      const slot = this.inflight.get(msg.id);
      if (!slot) return;
      this.inflight.delete(msg.id);
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
      else slot.resolve((msg.result ?? {}) as Json);
      return;
    }

    const method = msg.method as string | undefined;
    const params = (msg.params ?? {}) as Json;

    // Server → client REQUEST: dynamic tool call (this is the bridge).
    if (method === "item/tool/call" && msg.id !== undefined) {
      const tool = params.tool as string;
      const args = params.arguments;
      this.pending?.toolCalls.push(tool);
      let success = true;
      let text: string;
      if (tool === "vendo_payments_send") {
        const id = `apr_${Date.now()}`;
        if (this.approvalDelayMs > 0) this.broker.autoApproveAfter(id, this.approvalDelayMs);
        const approved = await this.broker.waitForDecision(id);
        if (approved) {
          this.broker.mark("tool-executed", tool);
          text = JSON.stringify(executeSpikeTool(tool, args));
        } else {
          success = false;
          text = "The user declined this payment.";
        }
      } else {
        this.broker.mark("tool-auto-allowed", tool);
        text = JSON.stringify(executeSpikeTool(tool, args));
      }
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { contentItems: [{ type: "inputText", text }], success },
      });
      return;
    }

    // Any command/patch approval request: always deny (agent must stay tool-less).
    if (
      msg.id !== undefined &&
      (method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "item/permissions/requestApproval" ||
        method === "execCommandApproval" ||
        method === "applyPatchApproval")
    ) {
      this.broker.mark("harness-approval-denied", method);
      this.send({ jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } });
      return;
    }

    // Notifications
    if (method === "item/agentMessage/delta") {
      if (this.pending && this.pending.ttftMs === null) {
        this.pending.ttftMs = now() - this.pending.startedAt;
      }
      this.pending && (this.pending.answer += String(params.delta ?? ""));
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn as { status?: string; error?: unknown } | undefined;
      const p = this.pending;
      this.pending = null;
      p?.resolve({
        ttftMs: p.ttftMs,
        totalMs: now() - p.startedAt,
        model: this.model,
        usage: (params as { usage?: unknown }).usage ?? turn,
        answer: p.answer,
        notes: `tools=[${p.toolCalls.join(",")}] status=${turn?.status ?? "?"}`,
      });
      return;
    }
  }

  async sendTurn(text: string): Promise<Omit<TurnMetrics, "rung" | "scenario" | "trial">> {
    if (!this.threadId) throw new Error("not started");
    return new Promise((resolve, reject) => {
      this.pending = { startedAt: now(), ttftMs: null, answer: "", toolCalls: [], resolve };
      this.request("turn/start", {
        threadId: this.threadId!,
        input: [{ type: "text", text, text_elements: [] }],
      }).catch((err: Error) => {
        this.pending = null;
        reject(err);
      });
    });
  }

  async dispose(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}
