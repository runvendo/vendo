/**
 * The closed allowlist of telemetry events and their permitted property keys.
 * TELEMETRY.md mirrors this file. Nothing outside these sets is ever sent.
 * Base properties (see base-props.ts) are permitted on every event implicitly.
 */
export const BASE_PROP_KEYS = ["vendoVersion", "osPlatform", "nodeVersion"] as const;

export type EventName = "init_started" | "init_completed" | "init_failed" | "agent_run" | "error_class";

export const EVENT_ALLOWLIST: Record<EventName, ReadonlySet<string>> = {
  // CLI / build
  init_started: new Set([...BASE_PROP_KEYS, "framework"]),
  init_completed: new Set([
    ...BASE_PROP_KEYS,
    "framework",
    "provider",
    "llmSkipped",
    "keyPrompt",
    "componentCount",
    "toolCount",
    "durationMs",
  ]),
  init_failed: new Set([...BASE_PROP_KEYS, "framework", "failedStep"]),
  // dev-time feature usage
  agent_run: new Set([...BASE_PROP_KEYS]),
  error_class: new Set([...BASE_PROP_KEYS, "errorClass"]),
} as const;

export function isAllowedProps(event: EventName, props: Record<string, unknown>): boolean {
  const allowed = EVENT_ALLOWLIST[event];
  return Object.keys(props).every((k) => allowed.has(k));
}
