import { z } from "zod";
import type { PermissionGrant } from "./grants.js";
import type { Principal } from "./principal.js";
import type { RunContext } from "./run-context.js";
import { toolCallSchema, type ToolCall, type ToolOutcome, type ToolRegistry } from "./tools.js";

/** 01-core §13 */
export type ActAs = (principal: Principal, grant: PermissionGrant) => Promise<AuthMaterial | null>;

/** 01-core §13 */
export interface AuthMaterial {
  headers: Record<string, string>;
}

/** 01-core §13 */
export const authMaterialSchema = z.object({
  headers: z.record(z.string()),
}).passthrough() satisfies z.ZodType<AuthMaterial>;

/** 01-core §13 */
export interface SecretsProvider {
  get(name: string): Promise<string | undefined>;
}

/** 01-core §13 */
export type AgentRunner = (
  task: {
    prompt: string;
    tools: ToolRegistry;
    budget?: { maxToolCalls?: number };
    /** Best-effort in-process cancellation; runners that do not support it may ignore it. */
    abortSignal?: AbortSignal;
  },
  ctx: RunContext,
) => Promise<AgentRunReport>;

/** 01-core §13 */
export interface AgentRunReport {
  status: "ok" | "error" | "stopped";
  summary: string;
  toolCalls: Array<{ call: ToolCall; outcome: ToolOutcome["status"] }>;
}

/** 01-core §13 */
export const agentRunReportSchema = z.object({
  status: z.enum(["ok", "error", "stopped"]),
  summary: z.string(),
  toolCalls: z.array(z.object({
    call: toolCallSchema,
    outcome: z.enum(["ok", "error", "pending-approval", "blocked"]),
  }).passthrough()),
}).passthrough() satisfies z.ZodType<AgentRunReport>;
