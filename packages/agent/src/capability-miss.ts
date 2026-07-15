import {
  TOOL_NAME_PATTERN,
  VendoError,
  type CapabilityMissEvent,
  type CapabilityMissToolFailure,
  type CapabilityMissTrigger,
  type RunContext,
  type ThreadId,
  type ToolCall,
  type ToolOutcome,
} from "@vendoai/core";
import { dynamicTool, jsonSchema, type ToolSet, type UIMessage } from "ai";

export const CAPABILITY_MISS_TOOL_NAME = "vendo_report_capability_miss";

export interface CapabilityMissConfig {
  hostId: string;
  surface: Promise<CapabilityMissEvent["surface"]>;
  emit(event: CapabilityMissEvent): void | Promise<void>;
}

interface DetectorOptions {
  config: CapabilityMissConfig;
  ctx: RunContext;
  intent: string;
  threadId?: ThreadId;
}

const REPORT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["no-matching-tool", "agent-give-up"] },
    toolsConsidered: {
      type: "array",
      items: { type: "string", pattern: TOOL_NAME_PATTERN.source },
      maxItems: 100,
    },
  },
  required: ["kind", "toolsConsidered"],
  additionalProperties: false,
} as Parameters<typeof jsonSchema>[0];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((name): name is string => typeof name === "string" && TOOL_NAME_PATTERN.test(name))
    .slice(0, 100))];
}

/** Deterministic, deliberately conservative removal of common credential/PII forms. */
export function scrubCapabilityMissText(value: string): string {
  const scrubbed = value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, "$1[redacted-secret]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-secret]")
    .replace(/\b(?:sk|pk|rk|vnd|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted-secret]")
    .replace(/\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted-secret]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[redacted-phone]")
    .trim()
    .slice(0, 1_000);
  return scrubbed || "Unspecified request";
}

function textFromPart(part: UIMessage["parts"][number]): string | undefined {
  const candidate = part as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string"
    ? candidate.text
    : undefined;
}

export function latestUserIntent(messages: UIMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) return "Unspecified request";
  return scrubCapabilityMissText(message.parts.map(textFromPart).filter(Boolean).join(" "));
}

export interface CapabilityMissDetector {
  onCall(call: ToolCall): (outcome: ToolOutcome) => void;
  attach(tools: ToolSet): void;
}

export function createCapabilityMissDetector(options: DetectorOptions): CapabilityMissDetector {
  const attempted: string[] = [];
  const failures = new Map<string, CapabilityMissToolFailure[]>();
  let reported = false;

  const report = (trigger: CapabilityMissTrigger): boolean => {
    if (reported) return false;
    reported = true;
    void (async () => {
      const surface = await options.config.surface;
      const event: CapabilityMissEvent = {
        format: "vendo/capability-miss@1",
        id: `mis_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
        at: new Date().toISOString(),
        hostId: options.config.hostId,
        ...(options.ctx.appId === undefined ? {} : { appId: options.ctx.appId }),
        sessionId: options.ctx.sessionId,
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        intent: scrubCapabilityMissText(options.intent),
        surface,
        trigger,
      };
      await options.config.emit(event);
    })().catch(() => {
      // Reporting is deliberately fire-and-forget. It cannot alter the agent turn.
    });
    return true;
  };

  return {
    onCall(call) {
      if (!attempted.includes(call.tool)) attempted.push(call.tool);
      return (outcome) => {
        if (reported || outcome.status !== "error") return;
        const toolFailures = failures.get(call.tool) ?? [];
        toolFailures.push({
          tool: call.tool,
          attempt: toolFailures.length + 1,
          failure: {
            ...(outcome.error.code.length === 0 ? {} : { code: outcome.error.code }),
            message: scrubCapabilityMissText(outcome.error.message),
          },
        });
        failures.set(call.tool, toolFailures);
        if (toolFailures.length < 2) return;
        report({
          kind: "repeated-tool-failure",
          toolsConsidered: [...attempted],
          attempts: [...toolFailures] as [
            CapabilityMissToolFailure,
            CapabilityMissToolFailure,
            ...CapabilityMissToolFailure[],
          ],
        });
      };
    },
    attach(tools) {
      if (tools[CAPABILITY_MISS_TOOL_NAME] !== undefined) {
        throw new VendoError("conflict", `Reserved internal tool name: ${CAPABILITY_MISS_TOOL_NAME}`);
      }
      const availableTools = new Set(Object.keys(tools));
      tools[CAPABILITY_MISS_TOOL_NAME] = dynamicTool({
        description: "Report that the current user ask cannot be fulfilled. Use only for no matching tool or an explicit terminal give-up.",
        inputSchema: jsonSchema(REPORT_INPUT_SCHEMA),
        execute: async (input): Promise<ToolOutcome> => {
          const parsed = record(input);
          const kind = parsed?.kind;
          if (kind !== "no-matching-tool" && kind !== "agent-give-up") {
            return { status: "error", error: { code: "validation", message: "Invalid capability-miss trigger" } };
          }
          const toolsConsidered = toolNames(parsed?.toolsConsidered)
            .filter((name) => availableTools.has(name));
          const emitted = kind === "no-matching-tool"
            ? report({ kind, toolsConsidered })
            : report({ kind, toolsConsidered, toolsAttempted: [...attempted] });
          return { status: "ok", output: { reported: emitted } };
        },
      });
    },
  };
}
