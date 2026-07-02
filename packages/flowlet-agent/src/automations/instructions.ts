/**
 * Compiler guidance (spec section d): the system-prompt block a host appends
 * so its chat agent doubles as the automation compiler. The agent, not this
 * text, is the authority on the closed world — create_automation re-validates
 * everything server-side; this guidance exists to make first attempts good.
 */

export interface HostEventDoc {
  name: string;
  description?: string;
  /** Human-readable payload field list shown to the compiler. */
  payloadFields?: string;
}

export interface AutomationInstructionOptions {
  hostEvents?: HostEventDoc[];
}

export function buildAutomationInstructions(
  options: AutomationInstructionOptions = {},
): string {
  const events = options.hostEvents ?? [];
  const eventLines =
    events.length === 0
      ? ["- (no host events are declared; only schedules and Composio triggers apply)"]
      : events.map(
          (e) =>
            `- "${e.name}"${e.description ? `: ${e.description}` : ""}${
              e.payloadFields ? ` — trigger payload fields: ${e.payloadFields}` : ""
            }`,
        );

  return [
    "AUTOMATIONS — when the user asks for standing behavior (\"whenever X, do Y\",",
    "\"every Sunday…\", \"if a charge over $500 hits…\"), COMPILE it into an automation",
    "with the create_automation tool. Do NOT perform the action yourself and do NOT",
    "just promise to remember — the automation does the work when it fires.",
    "",
    "Tier rules (the spec's execution.mode):",
    "- PREFER deterministic: mode \"steps\" with fixed tool steps. Predictable, cheap,",
    "  no LLM per firing. Most \"when X do Y\" rules land here.",
    "- Add an agent STEP only where a step genuinely needs judgment over unstructured",
    "  data (summarize, extract from prose). Give it a tools allowlist ([] for pure",
    "  judgment) and an output JSON schema so later steps can reference typed fields.",
    "- Fully agentic (mode \"agent\") only when the steps themselves are unknowable in",
    "  advance. Needs a non-empty tools allowlist.",
    "",
    "Spec rules:",
    "- Step ids are snake_case, unique across the whole tree.",
    "- Expressions are JSONata. Inside string values use {{ expr }} interpolation; a",
    "  value that is exactly one {{ expr }} resolves to the raw JSON value. Guards",
    "  (top-level `if`, per-step `if`, branch `if`) are bare JSONata predicates.",
    "- Expression scope: trigger (the trigger payload), steps.<id>.output, run",
    "  { id, automationId, firedAt }, user (the user's claims). Nothing else. No",
    "  $eval, no function definitions.",
    "- Reference ONLY tools that are currently registered in your toolset, and only",
    "  the host events listed below. onError.retry is only valid on idempotent tools.",
    "- Triggers: { type: \"schedule\", cron, timezone } (IANA timezone required; or a",
    "  one-shot { type: \"schedule\", at }), { type: \"host_event\", event }, or",
    "  { type: \"composio\", trigger, config }.",
    "",
    "Available host events:",
    ...eventLines,
    "",
    "Approval and grants:",
    "- Creating, updating, and deleting automations always requires user approval",
    "  (the card shows the compiled spec).",
    "- grantedTools: list a tool there ONLY when the user explicitly said the",
    "  automation may do that gated action unattended. Never invent grants. Without",
    "  a grant, a gated step pauses and asks the user each firing — say so.",
    "- After creating, you can test with run_automation_now (a dry run by default:",
    "  mutating tools are simulated; pass live: true only if the user asks).",
    "",
    "Managing: list_automations, get_automation_runs, pause_automation,",
    "resume_automation, update_automation (a fresh version; grants are re-collected),",
    "delete_automation.",
  ].join("\n");
}
