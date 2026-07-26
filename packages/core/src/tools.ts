import { z } from "zod";
import { approvalIdSchema, jsonSchemaSchema, type ApprovalId, type Json, type JsonSchema } from "./ids.js";
import type { RunContext } from "./run-context.js";

const requiredJsonValueSchema = z.unknown().refine(
  (value) => value !== undefined,
  { message: "required JSON value is missing" },
) as z.ZodType<{}>;

/** 01-core §4 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 01-core §4/§16 — the app runtime's reserved agent-tool namespace. Tools
 *  under this prefix are the only ones whose ok-outcome may carry an
 *  OpenSurface onto the view channel; the agent bridge and the apps runtime
 *  both read this constant so the seam is named once, here, instead of each
 *  side string-matching the other. */
export const VENDO_APPS_TOOL_PREFIX = "vendo_apps_";

/** 01-core §16 — the one prefixed tool whose execution may also stream
 *  partial views through the VENDO_VIEW_STREAM bridge seam (stream-parts). */
export const VENDO_APPS_CREATE_TOOL = "vendo_apps_create";

/** 0.4.4 cert defect B — the message prefix the apps runtime stamps on a
 *  terminally failed BUILD's error ("app build failed: <classified reason>").
 *  The agent loop reads it to end the turn and raise the failed-build banner;
 *  named once here so neither side string-matches the other. Only this class
 *  ends a turn — a cheap create error (input validation, feature-flag
 *  refusal) stays the model's to handle. */
export const VENDO_APP_BUILD_FAILED_PREFIX = "app build failed";

/** 01-core §4 */
export type RiskLabel = "read" | "write" | "destructive";

/** 01-core §4 */
export const riskLabelSchema = z.enum(["read", "write", "destructive"]) satisfies z.ZodType<RiskLabel>;

/** 01-core §4 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: RiskLabel;
  critical?: boolean;
  /** A short human label for the surfaces that show this tool to a PERSON —
   *  MCP clients' tool menus, approval cards. Presentation only: it never
   *  changes what the tool can do, and absent it those surfaces fall back to
   *  `name`. Sync's AI enrichment proposes it; `.vendo/overrides.json`
   *  corrects it. */
  title?: string;
  /** The connectable toolkit this tool belongs to (04-actions §3), present
   *  only on connector tools whose usefulness is gated by a per-user connected
   *  account (e.g. Composio's gmail/slack). Composition seams read it to skip
   *  work that is pointless without a connection — the apps runtime's
   *  create-time shape probes skip unconnected toolkits (re-gate 2026-07-26
   *  finding 2). Metadata only: it never changes what the tool can do, and
   *  execution still answers `connect-required` on its own. */
  toolkit?: string;
}

/** 01-core §4 */
export const toolDescriptorSchema = z.object({
  name: z.string().regex(TOOL_NAME_PATTERN),
  description: z.string(),
  inputSchema: jsonSchemaSchema,
  risk: riskLabelSchema,
  critical: z.boolean().optional(),
  title: z.string().optional(),
  toolkit: z.string().optional(),
}).passthrough() satisfies z.ZodType<ToolDescriptor>;

/** 01-core §4 */
export interface ToolCall {
  id: string;
  tool: string;
  args: Json;
}

/** 01-core §4 */
export const toolCallSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: requiredJsonValueSchema,
}).passthrough() satisfies z.ZodType<ToolCall>;

/** 01-core §4 — a connector call that needs a per-user connected account first
 * (04-actions §3). `connector`/`toolkit` key the umbrella's /connections
 * endpoints; the UI renders an inline connect card and retries after connecting. */
export interface ConnectRequired {
  connector: string;
  toolkit: string;
  message: string;
}

/** 01-core §4 */
const connectRequiredSchema = z.object({
  connector: z.string().min(1),
  toolkit: z.string().min(1),
  message: z.string(),
}).passthrough() satisfies z.ZodType<ConnectRequired>;

/** 01-core §4 */
export type ToolOutcome =
  | { status: "ok"; output: Json }
  | { status: "error"; error: { code: string; message: string } }
  | { status: "pending-approval"; approvalId: ApprovalId }
  | { status: "blocked"; reason: string }
  | { status: "connect-required"; connect: ConnectRequired };

/** 01-core §4 */
export const toolOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), output: requiredJsonValueSchema }).passthrough(),
  z.object({
    status: z.literal("error"),
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
  }).passthrough(),
  z.object({ status: z.literal("pending-approval"), approvalId: approvalIdSchema }).passthrough(),
  z.object({ status: z.literal("blocked"), reason: z.string() }).passthrough(),
  z.object({ status: z.literal("connect-required"), connect: connectRequiredSchema }).passthrough(),
]) satisfies z.ZodType<ToolOutcome>;

/** 01-core §4 */
export interface ToolRegistry {
  descriptors(): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}
