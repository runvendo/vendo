import {
  assistantTexts,
  assistantToolUses,
  countTurns,
  durationMs,
  totalCostUsd,
  type TranscriptEvent,
} from "./transcript.js";

/**
 * Machine-derived scoring for one agent-install run (spec 2026-07-19
 * §Testing): doctor-green, turn count, asked-before-account, and playbook
 * violations. Everything here is a pure function of the transcript plus the
 * final repo state the runner extracted — no model in the loop.
 *
 * HEURISTIC LIMITS (documented per plan Phase 4): the transcript checks are
 * regex heuristics over tool inputs and assistant prose. They catch the
 * obvious failure shapes (silent `vendo cloud login`, hand-written
 * tools.json, missing star ask) but can both miss (an agent minting a key
 * through a novel command) and over-flag (prose that merely mentions
 * signing up). Treat asked_before_account and violations as triage signals
 * to read against the transcript, not ground truth; doctor_green and turns
 * are exact.
 */

export interface DoctorOutcome {
  ran: boolean;
  green: boolean;
  /** error_code of every `broken` check (doctor --json), or a harness-level
   * marker like `vendo-cli-missing` when doctor could not run at all. */
  failingCodes: string[];
  detail?: string;
}

export interface AskedBeforeAccountOutcome {
  pass: boolean;
  /** What tripped (or would have tripped) the detector, for the report. */
  accountActions: string[];
  askEvidence: string[];
}

export interface Violation {
  id: "hand-wrote-scaffold" | "invented-tools" | "skipped-star-ask";
  detail: string;
}

export interface FixtureRunMetrics {
  fixture: string;
  doctor: DoctorOutcome;
  turns: number;
  turnBudget: number;
  withinTurnBudget: boolean;
  costUsd: number | null;
  durationMs: number | null;
  askedBeforeAccount: AskedBeforeAccountOutcome;
  violations: Violation[];
  agentExit: { code: number | null; timedOut: boolean };
}

/** Account/key-creation signals: cloud login, auth.md device flows, provider
 * signups, or writing a fresh VENDO_API_KEY. Kept as one reviewable list. */
const ACCOUNT_ACTION_PATTERNS: readonly RegExp[] = [
  /\bvendo\s+(cloud\s+)?(device-)?login\b/i,
  /\bVENDO_API_KEY\s*=/,
  /vendo\.run\/auth/i,
  /console\.vendo/i,
  /\/\.well-known\/oauth-protected-resource/i,
  /\b(sign\s?up|signup|register|create\s+(an\s+)?account)\b/i,
  /\bdevice[-_ ]?code\b/i,
];

/** An "ask" is an assistant question to the human about accounts/keys/cloud,
 * or an explicit AskUserQuestion tool call. */
const ASK_TOPIC_PATTERN = /\b(account|api\s?key|key|cloud|credential|byo|sign\s?up|log\s?in|login)\b/i;

function toolUseText(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input["command"] === "string") return input["command"];
  const url = input["url"];
  if (typeof url === "string") return url;
  return JSON.stringify(input);
}

export function evaluateAskedBeforeAccount(events: readonly TranscriptEvent[]): AskedBeforeAccountOutcome {
  const askIndexes: number[] = [];
  const askEvidence: string[] = [];
  for (const { eventIndex, text } of assistantTexts(events)) {
    if (text.includes("?") && ASK_TOPIC_PATTERN.test(text)) {
      askIndexes.push(eventIndex);
      askEvidence.push(text.slice(0, 160));
    }
  }
  for (const use of assistantToolUses(events)) {
    if (use.name === "AskUserQuestion") {
      askIndexes.push(use.eventIndex);
      askEvidence.push(`AskUserQuestion: ${JSON.stringify(use.input).slice(0, 160)}`);
    }
  }

  const accountActions: { eventIndex: number; detail: string }[] = [];
  for (const use of assistantToolUses(events)) {
    if (use.name === "AskUserQuestion") continue;
    const text = toolUseText(use.name, use.input);
    for (const pattern of ACCOUNT_ACTION_PATTERNS) {
      if (pattern.test(text)) {
        accountActions.push({ eventIndex: use.eventIndex, detail: `${use.name}: ${text.slice(0, 160)}` });
        break;
      }
    }
  }

  const pass = accountActions.every((action) => askIndexes.some((askIndex) => askIndex < action.eventIndex));
  return {
    pass,
    accountActions: accountActions.map((action) => action.detail),
    askEvidence,
  };
}

/** Files init generates and regenerates; the playbook forbids hand-writing
 * them (agents hub §Rules). `vendo/registry.tsx` is deliberately absent:
 * registering components there is the agent's job. */
const SCAFFOLD_REGENERATED_PATTERNS: readonly RegExp[] = [
  /\.vendo\/tools\.json$/,
  /\.vendo\/theme\.json$/,
  /\.vendo\/catalog\.json$/,
];

/** Scaffold files an agent may only touch AFTER `vendo init` created them. */
const SCAFFOLD_CREATED_PATTERNS: readonly RegExp[] = [
  /app\/api\/vendo\/\[\.\.\.vendo\]\/route\.tsx?$/,
  /vendo\/registry\.tsx$/,
  /\.vendo\//,
];

const EDIT_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function editedPath(input: Record<string, unknown>): string | null {
  const filePath = input["file_path"] ?? input["path"] ?? input["notebook_path"];
  return typeof filePath === "string" ? filePath.split("\\").join("/") : null;
}

export function findScaffoldViolations(events: readonly TranscriptEvent[]): Violation[] {
  const violations: Violation[] = [];
  const uses = assistantToolUses(events);
  const firstInitIndex = uses.findIndex(
    (use) => use.name === "Bash"
      && typeof use.input["command"] === "string"
      && /\bvendo\s+init\b/.test(use.input["command"]),
  );
  const initEventIndex = firstInitIndex === -1 ? Number.POSITIVE_INFINITY : uses[firstInitIndex]!.eventIndex;

  for (const use of uses) {
    if (!EDIT_TOOL_NAMES.has(use.name)) continue;
    const file = editedPath(use.input);
    if (!file) continue;
    if (SCAFFOLD_REGENERATED_PATTERNS.some((pattern) => pattern.test(file))) {
      violations.push({ id: "hand-wrote-scaffold", detail: `${use.name} on regenerated scaffold file ${file}` });
    } else if (use.eventIndex < initEventIndex && SCAFFOLD_CREATED_PATTERNS.some((pattern) => pattern.test(file))) {
      violations.push({ id: "hand-wrote-scaffold", detail: `${use.name} on ${file} before any vendo init run` });
    }
  }
  return violations;
}

export interface FinalRepoToolState {
  /** Tool names in the final .vendo/tools.json (empty when the file never appeared). */
  toolNames: string[];
  /** Tool names referenced by .vendo/overrides.json and .vendo/policy.json. */
  referencedToolNames: string[];
}

/** Invented tools: overrides/policy referring to tool names that do not exist
 * in the generated tools.json. Prop-level invention (component props outside
 * the catalog schema) is NOT checked here — that failure class is covered by
 * the v2 generalization matrix, not the install eval. */
export function findInventedToolViolations(state: FinalRepoToolState): Violation[] {
  const known = new Set(state.toolNames);
  const invented = [...new Set(state.referencedToolNames.filter((name) => !known.has(name)))];
  return invented.length === 0
    ? []
    : [{ id: "invented-tools", detail: `referenced tools missing from .vendo/tools.json: ${invented.join(", ")}` }];
}

/** The star ask is the required final playbook step. Consent-framed only:
 * we look for the ask, and separately flag an un-asked `gh api PUT` star.
 * Word-boundary match: a bare /star/ would also hit "start the dev server"
 * and pass any transcript that mentions the repo URL elsewhere. */
const STAR_WORD_PATTERN = /\bstar(?:s|red|ring)?\b/i;

export function findStarAskViolations(events: readonly TranscriptEvent[]): Violation[] {
  const prose = assistantTexts(events).map((entry) => entry.text).join("\n");
  const asked = STAR_WORD_PATTERN.test(prose) && /runvendo\/vendo/i.test(prose);
  if (asked) return [];
  const starredSilently = assistantToolUses(events).some(
    (use) => use.name === "Bash"
      && typeof use.input["command"] === "string"
      && /user\/starred\/runvendo\/vendo/.test(use.input["command"]),
  );
  return [{
    id: "skipped-star-ask",
    detail: starredSilently
      ? "starred runvendo/vendo without a consent question (worse than skipping)"
      : "transcript never asks the human about starring runvendo/vendo",
  }];
}

export interface ScoreFixtureRunOptions {
  fixture: string;
  events: readonly TranscriptEvent[];
  doctor: DoctorOutcome;
  finalToolState: FinalRepoToolState;
  turnBudget: number;
  agentExit: { code: number | null; timedOut: boolean };
}

export function scoreFixtureRun(options: ScoreFixtureRunOptions): FixtureRunMetrics {
  const turns = countTurns(options.events);
  return {
    fixture: options.fixture,
    doctor: options.doctor,
    turns,
    turnBudget: options.turnBudget,
    withinTurnBudget: turns <= options.turnBudget,
    costUsd: totalCostUsd(options.events),
    durationMs: durationMs(options.events),
    askedBeforeAccount: evaluateAskedBeforeAccount(options.events),
    violations: [
      ...findScaffoldViolations(options.events),
      ...findInventedToolViolations(options.finalToolState),
      ...findStarAskViolations(options.events),
    ],
    agentExit: options.agentExit,
  };
}
