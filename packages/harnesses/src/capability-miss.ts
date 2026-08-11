import {
  TOOL_NAME_PATTERN,
  type CapabilityMissEvent,
  type CapabilityMissToolFailure,
  type CapabilityMissTrigger,
  type Json,
  type RunContext,
  type ThreadId,
  type ToolCall,
  type ToolListing,
  type ToolOutcome,
} from "@vendoai/core";
import type { UIMessage } from "ai";

export const CAPABILITY_MISS_TOOL_NAME = "vendo_report_capability_miss";

export interface CapabilityMissConfig {
  hostId: string;
  /** #557 — a LAZY, memoized factory rather than an eager promise: resolving the
   *  surface hash drives the actions registry's `loadHost`, which now awaits the
   *  cloud overrides fetch. Deferring keeps that fetch off the compose path
   *  (Workers global scope). Awaited only when a miss is actually reported. */
  surface: () => Promise<CapabilityMissEvent["surface"]>;
  emit(event: CapabilityMissEvent): void | Promise<void>;
}

interface DetectorOptions {
  config: CapabilityMissConfig;
  ctx: RunContext;
  intent: string;
  threadId?: ThreadId;
  /** The names a report's `toolsConsidered` may claim — the projected surface,
   *  resolved at report time so a fabricated name never lands in telemetry and
   *  building the detector costs nothing. Unset (or failing) keeps every
   *  pattern-valid name, which is the honest degradation. */
  available?: () => Promise<ReadonlySet<string>>;
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
} as NonNullable<ToolListing["inputSchema"]>;

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

/** The reporter tool, directly exposed: the runtime lists `listing` on the
 *  turn's surface and dispatches calls to `execute`. Never through the guard —
 *  reporting a miss spends no authority (§12: reads are silent, always). */
export interface CapabilityMissReporter {
  listing: ToolListing;
  execute(args: Json): Promise<ToolOutcome>;
}

export interface CapabilityMissDetector {
  onCall(call: ToolCall): (outcome: ToolOutcome) => void;
  reporter: CapabilityMissReporter;
}

export function createCapabilityMissDetector(options: DetectorOptions): CapabilityMissDetector {
  const attempted: string[] = [];
  const failures = new Map<string, CapabilityMissToolFailure[]>();
  let reported = false;

  const report = (trigger: CapabilityMissTrigger): boolean => {
    if (reported) return false;
    reported = true;
    void (async () => {
      const surface = await options.config.surface();
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
    reporter: {
      listing: {
        name: CAPABILITY_MISS_TOOL_NAME,
        title: "Report that this cannot be done",
        description: "Report that the current user ask cannot be fulfilled. Use only for no matching tool or an explicit terminal give-up.",
        risk: "read",
        inputSchema: REPORT_INPUT_SCHEMA,
      },
      execute: async (input): Promise<ToolOutcome> => {
        const parsed = record(input);
        const kind = parsed?.kind;
        if (kind !== "no-matching-tool" && kind !== "agent-give-up") {
          return { status: "error", error: { code: "validation", message: "Invalid capability-miss trigger" } };
        }
        const names = toolNames(parsed?.toolsConsidered);
        const offered = await options.available?.().catch(() => undefined);
        const toolsConsidered = offered === undefined
          ? names
          : names.filter((name) => offered.has(name));
        const emitted = kind === "no-matching-tool"
          ? report({ kind, toolsConsidered })
          : report({ kind, toolsConsidered, toolsAttempted: [...attempted] });
        return { status: "ok", output: { reported: emitted } };
      },
    },
  };
}
