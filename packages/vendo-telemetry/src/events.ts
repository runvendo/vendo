/**
 * The closed allowlist of telemetry events and their permitted property keys.
 * TELEMETRY.md mirrors this file. Nothing outside these sets is ever sent.
 * Base properties (see base-props.ts) are permitted on every event implicitly.
 */
export const BASE_PROP_KEYS = [
  "vendoVersion",
  "osPlatform",
  "nodeVersion",
  // Salted one-way sha256 of the git origin URL (else package.json name);
  // omitted when neither exists. See projectProps in base-props.ts.
  "projectIdHash",
  // Closed enum npm | pnpm | yarn | bun from npm_config_user_agent; omitted
  // when unknown.
  "packageManager",
] as const;

export type EventName =
  | "init_started"
  | "init_completed"
  | "init_failed"
  | "doctor_run"
  | "agent_run"
  | "error_class";

export const EVENT_ALLOWLIST: Record<EventName, ReadonlySet<string>> = {
  // CLI / build
  init_started: new Set([...BASE_PROP_KEYS, "framework"]),
  init_completed: new Set([
    ...BASE_PROP_KEYS,
    "framework",
    "provider",
    "llmSkipped",
    "keyPrompt",
    // Which command drove the run (always "init" since the bin's only writer
    // is init; kept so historical rows stay distinguishable).
    "command",
    // Catalog picker: offered = componentsOffered, accepted = componentCount.
    "componentsOffered",
    "componentCount",
    // Remix picker anchor counts (TELEMETRY.md table).
    "remixOffered",
    "remixWrapped",
    "remixSkipped",
    "toolCount",
    "durationMs",
  ]),
  init_failed: new Set([...BASE_PROP_KEYS, "framework", "failedStep"]),
  // `vendo doctor` health-check run: counts + a wired bool, never any content.
  doctor_run: new Set([...BASE_PROP_KEYS, "failures", "warnings", "wired"]),
  // dev-time feature usage
  agent_run: new Set([...BASE_PROP_KEYS]),
  error_class: new Set([...BASE_PROP_KEYS, "errorClass"]),
} as const;
