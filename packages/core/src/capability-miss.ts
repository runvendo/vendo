import { z } from "zod";
import {
  appIdSchema,
  isoDateTimeSchema,
  threadIdSchema,
  type AppId,
  type IsoDateTime,
  type ThreadId,
} from "./ids.js";
import { TOOL_NAME_PATTERN } from "./tools.js";

export const VENDO_CAPABILITY_MISS_FORMAT = "vendo/capability-miss@1" as const;

export interface CapabilityMissToolFailure {
  tool: string;
  attempt: number;
  failure: { code?: string; message: string };
}

export type CapabilityMissTrigger =
  | { kind: "no-matching-tool"; toolsConsidered: string[] }
  | {
      kind: "repeated-tool-failure";
      toolsConsidered: string[];
      attempts: [CapabilityMissToolFailure, CapabilityMissToolFailure, ...CapabilityMissToolFailure[]];
    }
  | { kind: "agent-give-up"; toolsConsidered: string[]; toolsAttempted: string[] };

export interface CapabilityMissEvent {
  format: typeof VENDO_CAPABILITY_MISS_FORMAT;
  id: string;
  at: IsoDateTime;
  hostId: string;
  appId?: AppId;
  sessionId: string;
  threadId?: ThreadId;
  intent: string;
  surface: {
    format: "vendo/tools@1";
    hash: string;
  };
  trigger: CapabilityMissTrigger;
}

const toolNameSchema = z.string().regex(TOOL_NAME_PATTERN);

export const capabilityMissToolFailureSchema = z.object({
  tool: toolNameSchema,
  attempt: z.number().int().positive(),
  failure: z.object({
    code: z.string().optional(),
    message: z.string().min(1),
  }).passthrough(),
}).passthrough() satisfies z.ZodType<CapabilityMissToolFailure>;

export const capabilityMissTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("no-matching-tool"),
    toolsConsidered: z.array(toolNameSchema),
  }).passthrough(),
  z.object({
    kind: z.literal("repeated-tool-failure"),
    toolsConsidered: z.array(toolNameSchema),
    attempts: z.array(capabilityMissToolFailureSchema).min(2),
  }).passthrough(),
  z.object({
    kind: z.literal("agent-give-up"),
    toolsConsidered: z.array(toolNameSchema),
    toolsAttempted: z.array(toolNameSchema),
  }).passthrough(),
]) as unknown as z.ZodType<CapabilityMissTrigger>;

export const capabilityMissEventSchema = z.object({
  format: z.literal(VENDO_CAPABILITY_MISS_FORMAT),
  id: z.string().regex(/^mis_.+$/),
  at: isoDateTimeSchema,
  hostId: z.string().min(1),
  appId: appIdSchema.optional(),
  sessionId: z.string().min(1),
  threadId: threadIdSchema.optional(),
  intent: z.string().min(1),
  surface: z.object({
    format: z.literal("vendo/tools@1"),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).passthrough(),
  trigger: capabilityMissTriggerSchema,
}).passthrough() satisfies z.ZodType<CapabilityMissEvent>;
