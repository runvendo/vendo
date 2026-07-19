#!/usr/bin/env node
/**
 * Test stub speaking just enough of the codex app-server JSON-RPC surface
 * (newline-delimited JSON-RPC 2.0 over stdio) to exercise CodexSessionRider:
 * initialize handshake, thread/start with dynamicTools, turn/start with
 * agent-message deltas, an item/tool/call round trip (the response is awaited
 * — the approval park), and one harness approval request the client must deny.
 */
import { createInterface } from "node:readline";

let dynamicTools = [];
let turnCount = 0;
let pendingToolCallId = null;
let pendingApprovalId = null;
let toolResultText = null;
let approvalDecision = null;
let requireExperimental = false;
let sawExperimental = false;

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // Responses to OUR server→client requests.
  if (message.id !== undefined && message.method === undefined) {
    if (message.id === pendingToolCallId) {
      pendingToolCallId = null;
      toolResultText = message.result?.contentItems?.[0]?.text ?? null;
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: `tool said: ${toolResultText}` } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
    }
    if (message.id === pendingApprovalId) {
      pendingApprovalId = null;
      approvalDecision = message.result?.decision ?? null;
    }
    return;
  }

  const { method, id, params } = message;
  if (method === "initialize") {
    sawExperimental = params?.capabilities?.experimentalApi === true;
    if (requireExperimental && !sawExperimental) {
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "experimentalApi required" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { userAgent: "stub-codex" } });
    return;
  }
  if (method === "initialized") return;
  if (method === "thread/start") {
    dynamicTools = params?.dynamicTools ?? [];
    send({ jsonrpc: "2.0", id, result: { thread: { id: "thr_stub" }, model: "stub-model" } });
    return;
  }
  if (method === "turn/start") {
    turnCount += 1;
    const text = params?.input?.[0]?.text ?? "";
    if (text.includes("use the tool") && dynamicTools.length > 0) {
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "calling... " } });
      pendingToolCallId = 1000 + turnCount;
      send({
        jsonrpc: "2.0",
        id: pendingToolCallId,
        method: "item/tool/call",
        params: { tool: dynamicTools[0].name, arguments: { value: "from-stub" } },
      });
      // turn/completed is sent when the tool response arrives (see above).
      return;
    }
    if (text.includes("try the shell")) {
      pendingApprovalId = 2000 + turnCount;
      send({
        jsonrpc: "2.0",
        id: pendingApprovalId,
        method: "item/commandExecution/requestApproval",
        params: { command: "rm -rf /" },
      });
      // Report the decision back through the turn so the test can observe it.
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: `approval: ${approvalDecision}` } });
        send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
      }, 50);
      return;
    }
    if (text.includes("report home")) {
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: `home=${process.env.CODEX_HOME ?? ""}` } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
      return;
    }
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "Hello " } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "from stub." } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
