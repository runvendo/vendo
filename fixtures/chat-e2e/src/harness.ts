/** The chat-path e2e harness: composes REAL blocks the way the umbrella
 * (09 §2) will — real PGlite store, real guard (createGuard + guard.bind), real
 * agent (createAgent / asRunner) — around a scripted deterministic
 * LanguageModel, and asserts side effects with raw SQL over the vendo_* tables.
 *
 * The dependency-guard pins packages/agent → core only and scans its tests, so
 * this cross-block wiring cannot live inside the agent package; it lives here,
 * in a fixture the guard never scans (scripts/dependency-guard.mjs only walks
 * packages/*).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  descriptorHash,
  sha256Hex,
  type ApprovalDecision,
  type ApprovalId,
  type AuditEvent,
  type GrantDuration,
  type GrantScope,
  type Json,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createGuard, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createAgent, type VendoAgent } from "@vendoai/agent";
import {
  MockLanguageModelV3,
  simulateReadableStream,
} from "ai/test";
import type { LanguageModel, UIMessage } from "ai";
import { expect } from "vitest";

// ---------------------------------------------------------------------------
// Scripted LanguageModel (the agent tests' technique, copied — the fixture
// cannot import packages/agent/src/test-helpers, it is not a package export).
// ---------------------------------------------------------------------------

type LanguageModelV3Prompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];
type LanguageModelV3StreamPart = Awaited<
  ReturnType<MockLanguageModelV3["doStream"]>
>["stream"] extends ReadableStream<infer Part> ? Part : never;
type LanguageModelV3GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
type LanguageModelV3Content = LanguageModelV3GenerateResult["content"][number];

export const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

export function textTurn(text: string, id = "text_1"): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

export function toolCallTurn(
  toolName: string,
  input: unknown,
  toolCallId = "call_1",
): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

export type ScriptedModel = MockLanguageModelV3 & {
  prompts: LanguageModelV3Prompt[];
};

export function scriptedModel(turns: LanguageModelV3StreamPart[][]): ScriptedModel {
  const remaining = turns.map((turn) => [...turn]);
  const prompts: LanguageModelV3Prompt[] = [];
  const shift = (prompt: LanguageModelV3Prompt): LanguageModelV3StreamPart[] => {
    prompts.push(structuredClone(prompt));
    const chunks = remaining.shift();
    if (chunks === undefined) throw new Error("scripted model exhausted");
    return chunks;
  };
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const chunks = shift(request.prompt);
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async (request): Promise<LanguageModelV3GenerateResult> => {
      const chunks = shift(request.prompt);
      const finish = chunks.find((part) => part.type === "finish");
      const content: LanguageModelV3Content[] = [];
      const text = chunks
        .filter((part): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
      if (text.length > 0) content.push({ type: "text", text });
      for (const part of chunks) {
        if (part.type === "tool-call") content.push(structuredClone(part));
      }
      return {
        content,
        finishReason: finish?.finishReason ?? { unified: "stop", raw: undefined },
        usage: finish?.usage ?? ZERO_USAGE,
        warnings: [],
      };
    },
  }) as ScriptedModel;
  model.prompts = prompts;
  return model;
}

// ---------------------------------------------------------------------------
// Spy tool registry — the UNBOUND ToolRegistry handed to guard.bind. Real
// executions (the ones the guard actually lets through) are counted, so tests
// can assert "ran exactly once" / "never ran".
// ---------------------------------------------------------------------------

export function descriptor(
  overrides: Partial<ToolDescriptor> & { name: string },
): ToolDescriptor {
  return {
    description: `${overrides.name} fixture tool`,
    inputSchema: { type: "object", additionalProperties: true },
    risk: "write",
    ...overrides,
  };
}

export class SpyRegistry implements ToolRegistry {
  readonly calls: Array<{ call: ToolCall; ctx: RunContext }> = [];
  readonly #descriptors: ToolDescriptor[];
  readonly #outputs: Record<string, Json>;

  constructor(descriptors: ToolDescriptor[], outputs: Record<string, Json> = {}) {
    this.#descriptors = descriptors;
    this.#outputs = outputs;
  }

  /** Real executions per tool name — only increments when the guard runs it. */
  count(tool: string): number {
    return this.calls.filter((entry) => entry.call.tool === tool).length;
  }

  async descriptors(): Promise<ToolDescriptor[]> {
    return this.#descriptors.map((value) => structuredClone(value));
  }

  async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
    this.calls.push({ call: structuredClone(call), ctx: structuredClone(ctx) });
    return { status: "ok", output: this.#outputs[call.tool] ?? { ran: call.tool } };
  }
}

// ---------------------------------------------------------------------------
// Environment: one real store + one real guard, agents/runners built on demand.
// ---------------------------------------------------------------------------

export interface Env {
  store: VendoStore;
  guard: VendoGuard;
  /** guard.bind(registry) — the one sanctioned path to execution (05 §2). */
  bound(registry: ToolRegistry): ToolRegistry;
  /** A real agent whose tools are guard-bound over this registry. */
  agentFor(registry: ToolRegistry, model: LanguageModel): VendoAgent;
  /** Raw SQL over the real store (store.raw()) — the vendo_* table asserts. */
  sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
  count(table: string, where?: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export interface EnvOptions {
  policy?: PolicyConfig;
}

export async function createEnv(options: EnvOptions = {}): Promise<Env> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-chat-e2e-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({
    store,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });

  const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };

  const sql = async <Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]> => {
    const result = await raw.query(query, params);
    return result.rows as Row[];
  };

  const count = async (table: string, where?: string, params?: unknown[]): Promise<number> => {
    const clause = where === undefined ? "" : ` WHERE ${where}`;
    const rows = await sql<{ count: unknown }>(
      `SELECT COUNT(*)::int AS count FROM ${table}${clause}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  };

  return {
    store,
    guard,
    bound: (registry) => guard.bind(registry),
    agentFor: (registry, model) =>
      createAgent({ model, tools: guard.bind(registry), guard, store }),
    sql,
    count,
    async close() {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Context + principal helpers
// ---------------------------------------------------------------------------

export function userCtx(subject: string, overrides: Partial<RunContext> = {}): RunContext {
  const principal: Principal = { kind: "user", subject };
  return {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: `sess_${subject}`,
    ...overrides,
  };
}

export function ephemeralCtx(subject: string, overrides: Partial<RunContext> = {}): RunContext {
  const principal: Principal = { kind: "user", subject, ephemeral: true };
  return {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: `sess_${subject}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Grant seeding (mimics enable-capture / prior grants without a live model) —
// exactly the guard-fixture pattern, writing through the store's grant table.
// ---------------------------------------------------------------------------

export async function seedGrant(
  store: VendoStore,
  options: {
    subject: string;
    descriptor: ToolDescriptor;
    scope?: GrantScope;
    duration?: GrantDuration;
    appId?: string;
    source?: PermissionGrant["source"];
  },
): Promise<PermissionGrant> {
  const grant: PermissionGrant = {
    id: `grt_${globalThis.crypto.randomUUID()}`,
    subject: options.subject,
    tool: options.descriptor.name,
    descriptorHash: descriptorHash(options.descriptor),
    scope: options.scope ?? { kind: "tool" },
    duration: options.duration ?? "standing",
    ...(options.appId === undefined ? {} : { appId: options.appId }),
    source: options.source ?? "chat",
    grantedAt: new Date().toISOString(),
  };
  await store.records("vendo_grants").put({
    id: grant.id,
    data: grant,
    refs: {
      subject: grant.subject,
      tool: grant.tool,
      ...(grant.appId === undefined ? {} : { app_id: grant.appId }),
    },
  });
  return grant;
}

export function exactScope(tool: string, args: unknown): GrantScope {
  return {
    kind: "exact",
    inputHash: `sha256:${sha256Hex(canonicalJson(args))}`,
    inputPreview: `${tool} ${canonicalJson(args)}`,
  };
}

// ---------------------------------------------------------------------------
// Agent stream / approval-resume plumbing (the ai-SDK UI-message-stream wire).
// ---------------------------------------------------------------------------

export interface StreamRead {
  parts: Array<Record<string, unknown>>;
}

export async function readSse(response: Response): Promise<StreamRead> {
  const raw = await response.text();
  expect(raw.endsWith("\n\n")).toBe(true);
  const blocks = raw.slice(0, -2).split("\n\n");
  const parts = blocks
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { parts };
}

export function partsOfType(read: StreamRead, type: string): Array<Record<string, unknown>> {
  return read.parts.filter((part) => part.type === type);
}

/** The core approvalId (apr_...) surfaced beside the native tool part. The
 *  wire chunk is the ai-SDK data-part envelope: fields ride under `data`. */
export function vendoApprovalId(read: StreamRead): ApprovalId {
  const part = partsOfType(read, "data-vendo-approval")[0];
  expect(part).toBeDefined();
  return (part!.data as { approvalId?: ApprovalId }).approvalId as ApprovalId;
}

/** The native (ai-SDK) approval id — carried back on the resume message. */
export function nativeApprovalId(read: StreamRead): string {
  const part = partsOfType(read, "tool-approval-request")[0];
  expect(part).toBeDefined();
  return part!.approvalId as string;
}

export async function lastAssistant(agent: VendoAgent, threadId: string, ctx: RunContext): Promise<UIMessage> {
  const thread = await agent.threads.get(threadId, ctx);
  expect(thread).not.toBeNull();
  const assistant = [...thread!.messages].reverse().find((message) => message.role === "assistant");
  expect(assistant).toBeDefined();
  return assistant!;
}

/** Flip the parked tool part to `approval-responded` so the next stream() resumes it. */
export function respondToApproval(
  message: UIMessage,
  toolCallId: string,
  toolName: string,
  input: unknown,
  approved: boolean,
): UIMessage {
  let updated = false;
  const parts = message.parts.map((part) => {
    const candidate = part as unknown as Record<string, unknown>;
    if (candidate.type !== "dynamic-tool" || candidate.toolCallId !== toolCallId) return part;
    updated = true;
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId,
      state: "approval-responded",
      input,
      approval: { id: nativeId(candidate), approved },
    } as unknown as UIMessage["parts"][number];
  });
  expect(updated).toBe(true);
  return { ...message, parts };
}

function nativeId(part: Record<string, unknown>): string {
  const approval = part.approval as { id?: unknown } | undefined;
  if (approval && typeof approval.id === "string") return approval.id;
  throw new Error("tool part carried no native approval id");
}

export function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export async function auditEvents(env: Env, subject: string): Promise<AuditEvent[]> {
  const rows = await env.sql<{ event: AuditEvent }>(
    "SELECT event FROM vendo_audit WHERE subject = $1 ORDER BY at ASC",
    [subject],
  );
  return rows.map((row) => row.event);
}
