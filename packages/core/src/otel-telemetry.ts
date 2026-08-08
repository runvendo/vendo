/**
 * OTel GenAI telemetry — the one switch that lets a host SEE the agent.
 *
 * The AI SDK emits OpenTelemetry GenAI spans (model, tokens, cost, latency,
 * tool calls, errors) only when a call passes `experimental_telemetry`. It is
 * off by default there, deliberately: a library must not export a host's
 * prompts without being asked.
 *
 * Vendo never passed it, so a host that had registered a tracer provider still
 * saw nothing from any Vendo model call — silently, with no warning and no
 * error. Measured in a third-party Next.js host: a 4.4-minute turn that
 * generated a working app produced zero spans; with these call sites emitting,
 * the same prompt produced cost per turn, the model ladder escalating
 * mini -> full, the whole tool graph, and the app-repair lane firing.
 *
 * There is NO vendor coupling here and no new dependency. The AI SDK resolves
 * whatever provider the host registered through `@opentelemetry/api`; Vendo
 * runs inside the host's process, so the spans simply join what is already
 * there — Langfuse, Braintrust, Datadog, or nothing at all.
 *
 * OPT-IN, off by default:
 *
 *   VENDO_OTEL_TRACING=1        spans WITH inputs/outputs (the SDK's default
 *                               once enabled: full prompts and tool results)
 *   VENDO_OTEL_TRACING=metrics  spans WITHOUT payloads — latency, tokens,
 *                               cost, model and errors only
 *   unset / 0 / false           no spans at all (unchanged behaviour)
 *
 * The `metrics` mode exists because enabling tracing should not force a host to
 * ship user prompts and tool results to its tracing backend. Hosts that share a
 * backend across tenants, or that care about data minimisation, need the
 * numbers without the payloads. Per-call `recordInputs`/`recordOutputs`
 * override the env for a lane that needs different treatment.
 *
 * (Arguably tracing should default to on whenever a provider is registered — a
 * host that installed OTel has already opted into collecting traces — but that
 * is a behaviour change and belongs in its own decision, not this one.)
 */

/** Vendo's span names, so a host can filter its dashboard by lane. */
export type TelemetryLane =
  | "vendo.agent.turn"
  | "vendo.agent.compaction"
  | "vendo.apps.generate"
  | "vendo.apps.check";

export interface OtelTelemetryOptions {
  /** Host-meaningful labels (tenant, seat, surface) attached to the span. */
  metadata?: Record<string, string | number | boolean>;
  /** Override the env default for this call. */
  recordInputs?: boolean;
  /** Override the env default for this call. */
  recordOutputs?: boolean;
}

interface TelemetrySettings {
  isEnabled: true;
  functionId: string;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

type Mode = "off" | "full" | "metrics";

function mode(): Mode {
  switch (process.env.VENDO_OTEL_TRACING) {
    case "1":
    case "true":
      return "full";
    case "metrics":
      return "metrics";
    default:
      return "off";
  }
}

/**
 * Spread into an ai-SDK `streamText` / `generateText` call:
 *
 * ```ts
 * const result = streamText({ model, messages, ...otelTelemetry("vendo.agent.turn") });
 * ```
 *
 * Returns `{}` when disabled, so the call is byte-identical to today's
 * behaviour unless a host asks for tracing.
 */
export function otelTelemetry(
  lane: TelemetryLane,
  options: OtelTelemetryOptions = {},
): { experimental_telemetry?: TelemetrySettings } {
  const current = mode();
  if (current === "off") return {};

  // `metrics` withholds payloads; explicit options always win over the env, so
  // a host can trace one lane in full while the rest stay metric-only.
  const recordInputs = options.recordInputs ?? current === "full";
  const recordOutputs = options.recordOutputs ?? current === "full";

  return {
    experimental_telemetry: {
      isEnabled: true,
      functionId: lane,
      recordInputs,
      recordOutputs,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    },
  };
}
