import type {
  AuditEvent,
  PermissionGrant,
  Principal,
  RunContext,
  StoreAdapter,
  ToolCall,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
} from "@vendoai/core";
import { descriptorHash } from "@vendoai/core";

export const alice: Principal = { kind: "user", subject: "user_alice", display: "Alice" };
export const bob: Principal = { kind: "user", subject: "user_bob", display: "Bob" };

export function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    principal: alice,
    venue: "chat",
    presence: "present",
    sessionId: "session_1",
    ...overrides,
  };
}

export function descriptor(
  risk: ToolDescriptor["risk"] = "read",
  overrides: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    name: `host_${risk}`,
    description: `${risk} fixture tool`,
    inputSchema: { type: "object", additionalProperties: true },
    risk,
    ...overrides,
  };
}

export function call(tool = "host_read", args: ToolCall["args"] = { value: 1 }, id = "call_1"): ToolCall {
  return { id, tool, args };
}

export const fixtureDescriptors: ToolDescriptor[] = [
  descriptor("read"),
  descriptor("write"),
  descriptor("destructive"),
  descriptor("destructive", {
    name: "host_critical",
    description: "critical fixture tool",
    critical: true,
  }),
];

export class FixtureTools implements ToolRegistry {
  readonly executions: Array<{ call: ToolCall; ctx: RunContext }> = [];
  #outcomes = new Map<string, ToolOutcome | Error>();

  constructor(readonly available: ToolDescriptor[] = fixtureDescriptors) {}

  setOutcome(tool: string, outcome: ToolOutcome | Error): void {
    this.#outcomes.set(tool, outcome);
  }

  async descriptors(): Promise<ToolDescriptor[]> {
    return this.available;
  }

  async execute(toolCall: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
    this.executions.push({ call: structuredClone(toolCall), ctx: structuredClone(ctx) });
    const scripted = this.#outcomes.get(toolCall.tool);
    if (scripted instanceof Error) throw scripted;
    return scripted ?? { status: "ok", output: { tool: toolCall.tool, args: toolCall.args } };
  }
}

export async function seedGrant(
  store: StoreAdapter,
  options: {
    descriptor: ToolDescriptor;
    subject?: string;
    id?: string;
    scope?: PermissionGrant["scope"];
    duration?: PermissionGrant["duration"];
    contextKey?: string;
    appId?: string;
    source?: PermissionGrant["source"];
    grantedAt?: string;
    expiresAt?: string;
    revokedAt?: string;
    descriptorHash?: string;
  },
): Promise<PermissionGrant> {
  const grant: PermissionGrant = {
    id: options.id ?? `grt_${crypto.randomUUID()}`,
    subject: options.subject ?? alice.subject,
    tool: options.descriptor.name,
    descriptorHash: options.descriptorHash ?? descriptorHash(options.descriptor),
    scope: options.scope ?? { kind: "tool" },
    duration: options.duration ?? "standing",
    ...(options.contextKey === undefined ? {} : { contextKey: options.contextKey }),
    ...(options.appId === undefined ? {} : { appId: options.appId }),
    source: options.source ?? "chat",
    grantedAt: options.grantedAt ?? new Date().toISOString(),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ...(options.revokedAt === undefined ? {} : { revokedAt: options.revokedAt }),
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

export function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `aud_${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    kind: "tool-call",
    principal: alice,
    venue: "chat",
    presence: "present",
    ...overrides,
  };
}
