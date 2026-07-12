import { z } from "zod";
import { appIdSchema, runIdSchema, type AppId, type RunId } from "./ids.js";
import { principalSchema, type Principal } from "./principal.js";
import type { TriggerSource } from "./triggers.js";

/** 01-core §3 */
export interface TriggerRef {
  runId: RunId;
  kind: TriggerSource["kind"];
}

/** 01-core §3 */
export const triggerRefSchema = z.object({
  runId: runIdSchema,
  kind: z.enum(["schedule", "host-event", "external"]),
}).passthrough() satisfies z.ZodType<TriggerRef>;

/** 01-core §3 */
export interface RunContext {
  principal: Principal;
  venue: "chat" | "app" | "automation" | "mcp";
  presence: "present" | "away";
  sessionId: string;
  appId?: AppId;
  trigger?: TriggerRef;
  requestHeaders?: Record<string, string>;
}

/** 01-core §3 */
export const runContextSchema = z.object({
  principal: principalSchema,
  venue: z.enum(["chat", "app", "automation", "mcp"]),
  presence: z.enum(["present", "away"]),
  sessionId: z.string(),
  appId: appIdSchema.optional(),
  trigger: triggerRefSchema.optional(),
  requestHeaders: z.record(z.string()).optional(),
}).passthrough() satisfies z.ZodType<RunContext>;
