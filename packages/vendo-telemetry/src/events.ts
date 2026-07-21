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

/**
 * Cloud-lane property keys, the second half of the lane split: the anonymous
 * lane (no or invalid VENDO_API_KEY) is EVENT_ALLOWLIST only, and these keys
 * are stripped even if callers pass them; when a valid Vendo Cloud key is
 * present the client accepts allowlisted keys ∪ CLOUD_PROP_KEYS on EVERY
 * event. A closed set like the allowlist — nothing outside it is ever sent —
 * and TELEMETRY.md ("When Vendo Cloud is configured") documents it. The lane
 * markers themselves (`cloud`, `cloudKeyHash`) are producer-set in client.ts
 * and deliberately NOT listed here, so callers can never spoof them.
 */
export const CLOUD_PROP_KEYS: ReadonlySet<string> = new Set([
  // Project identity a paying customer expects the console to show.
  "projectName",
  "repoHost",
  // Scrubbed, truncated error text (see scrub.ts); never raw messages.
  "errorDetail",
  // Setup shape: counts and short enums only.
  "connectionsConfigured",
  "toolkitsEnabled",
  "servedApps",
  "experimentalFlags",
  // Per-stage init timings (milliseconds).
  "detectMs",
  "engineMs",
  "themeMs",
  "wiringMs",
  "componentsMs",
]);

export type EventName =
  | "init_started"
  | "init_completed"
  | "init_failed"
  | "doctor_run"
  | "extract_completed"
  | "command_run"
  | "star_prompt"
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
    // What kind of project init ran against — bools and closed enums only.
    "typescript",
    // Next router flavor: app | pages | none.
    "router",
    // AI-polish engine that ran: claude | codex | npx-engine | none.
    "engine",
    // How the API surface was detected: route-scan | zod | none.
    "apiDetectMethod",
    "routeCount",
    "themeExtracted",
    // Bare dependency versions (range prefixes stripped) — non-identifying,
    // in line with what Astro/Nx collect anonymously.
    "frameworkVersion",
    "reactVersion",
    "zodVersion",
    "typescriptVersion",
  ]),
  init_failed: new Set([...BASE_PROP_KEYS, "framework", "failedStep", "errorClass"]),
  // `vendo doctor` health-check run: counts + a wired bool, never any content.
  doctor_run: new Set([...BASE_PROP_KEYS, "failures", "warnings", "wired"]),
  // `vendo extract --apply` result: counts, enums, versions — same voice as
  // init_completed. `method` is the api-detect enum: route-scan | zod | none.
  extract_completed: new Set([
    ...BASE_PROP_KEYS,
    "framework",
    "method",
    "routeCount",
    "toolCount",
    "ok",
    "durationMs",
    "frameworkVersion",
    "zodVersion",
  ]),
  // One row per tracked CLI command run — each a standalone `vendo <command>`
  // except cloud-init, which fires from the cloud step inside `vendo init`
  // (the standalone run of the same claim ceremony is `login`).
  // `command` is a closed enum: login | extract | theme | eject | playground
  // | refine | sync | cloud-init | mcp.
  // failedStep/errorClass are short enums/class names, never message text.
  command_run: new Set([
    ...BASE_PROP_KEYS,
    "command",
    "ok",
    "failedStep",
    "errorClass",
    "durationMs",
  ]),
  // Interactive init's consented star ask (CLI-5): outcome is a closed enum
  // starred | star-failed | declined. Never fires on non-interactive runs.
  star_prompt: new Set([...BASE_PROP_KEYS, "outcome"]),
  // dev-time feature usage
  agent_run: new Set([...BASE_PROP_KEYS]),
  error_class: new Set([...BASE_PROP_KEYS, "errorClass"]),
} as const;
