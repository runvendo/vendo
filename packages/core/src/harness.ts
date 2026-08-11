/**
 * The harness contract.
 *
 * Types only, so every block may speak them: `defineHarness` and the runtime
 * that builds a `Turn` live in `@vendoai/harnesses` (build contract §2). The
 * dividing line these shapes draw: we own state, tools, checks, guard, and
 * skills; the harness owns thinking — and orchestration is thinking. A harness
 * receives a `Turn` and yields a closed event vocabulary; it never persists,
 * never touches the wire, and never decides whether a call is allowed.
 *
 * §1.5's `HarnessEvent` list is CLOSED — the one post-v1 addition is `notice`
 * (2026-08-10 ruling: code never speaks in the assistant's voice), routed to
 * the transcript as a persisted system part; hosts that don't recognize the
 * part ignore it (§15 forward-compat).
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LanguageModel, UIMessage } from "ai";
import type { AppId, Json, TurnId } from "./ids.js";
import type { JsonSchema } from "./ids.js";
import type { SeatModels } from "./model-seats.js";
import type { VendoStepLimitPart } from "./stream-parts.js";
import type { RiskLabel } from "./tools.js";
import type { WorkspaceFs } from "./workspace.js";

/** Build contract §1 */
export interface Harness<Options = unknown> {
  readonly name: string;
  /** Declares the per-turn-overridable knobs. */
  readonly optionsSchema?: StandardSchemaV1;
  /**
   * Boot-time composition check — never a runtime surprise.
   *
   * A harness whose thinker is not in this process reaches `turn.tools` over the
   * host's own MCP door, and composition is the only place that can mount one.
   * Unlike `sandbox`, `toolDoor` is never a boot ERROR — declaring it is how a
   * harness asks composition for a door, and composition always answers.
   */
  readonly requires?: { sandbox?: boolean; toolDoor?: boolean };
  /**
   * How this harness wants the equipped-tool surface shaped. `curated: false` =
   * skip the discovery loadout (the ctx safety projection still applies);
   * `withhold` = names never listed to and never callable by this harness.
   */
  readonly toolSurface?: { curated?: false; withhold?: readonly string[] };
  run(turn: Turn<Options>): AsyncGenerator<HarnessEvent, void, void>;
}

/** Build contract §1 */
export interface Turn<Options = unknown> {
  /** Canonical transcript, oldest → newest. Ours; read-only. */
  readonly messages: readonly UIMessage[];
  readonly tools: TurnTools;
  readonly skills: TurnSkills;
  /** §3; the harness's file hands. */
  readonly workspace: WorkspaceFs;
  /** §4 — the seats this turn was handed. Any subset: a seat is required only
   *  where a harness actually reads it.
   *  `SeatModels` itself is generic so `@vendoai/store` can speak seats without
   *  an `ai` dependency; a `Turn` is handed to an in-process harness that passes
   *  the seat straight to `streamText`, so here the model type is named. */
  readonly models: SeatModels<LanguageModel>;
  /** §1.3 */
  readonly state: TurnState;
  /** Parsed by optionsSchema, incl. per-turn overrides. */
  readonly options: Options;
  readonly signal: AbortSignal;
  /** Present iff the caller proved presence (a click/message/submit). */
  readonly interactive: boolean;
  /**
   * The deployment's assembled system prompt — the product brief, the host's
   * voice, the guard's directions, the knowledge index, the discovery rail.
   * Composition assembles it per turn because it needs the `RunContext` a `Turn`
   * deliberately does not carry, so it cannot be a construction-time dep of the
   * harness value: a host who writes `harness: vendo()` builds that value once,
   * at boot, with no ctx in sight. Unset only for a runtime driven without
   * composition.
   */
  readonly system?: string;
  /**
   * The conversation's stable identity. Session-owning adapters (a machine pool,
   * a native session ref) need a per-conversation key; deriving one from
   * `messages[0].id` is a hack that history edits can orphan. Opaque to adapters.
   */
  readonly threadId: string;
  /**
   * This turn's own identity, minted per turn beside `threadId`. A thread spans a
   * conversation; this spans one exchange — the grain the audit rows, the
   * mirrored calls, the beats and the views all join on. Opaque to adapters.
   */
  readonly turnId: TurnId;
  /**
   * Register the one thing that takes the user's words MID-TURN — the second and
   * last piece of inbound control on a turn, beside `signal`.
   *
   * Inbound, so deliberately NOT a `HarnessEvent`: that union is closed and
   * describes what a harness SAYS. A steer is what a harness is TOLD.
   *
   * Registering declares "I can fold a message into the turn I am already
   * running"; the handler then answers whether this particular message LANDED,
   * because a harness that can steer in general still cannot when the thing it
   * drives has just finished. A `false` — or never registering — tells the caller
   * to keep the message for the next turn, which is why nothing here needs a
   * capability protocol. At most one handler: a turn has one thinker.
   */
  readonly onSteer?: (handler: (text: string) => Promise<boolean>) => void;
}

/** Build contract §1.1 */
export interface TurnTools {
  /** Never throws. Guarded, audited, and mirrored before it resolves. */
  call(name: string, args: Json): Promise<ToolResult>;
  /** Currently-equipped tools (post-curation). */
  list(): Promise<ToolListing[]>;
}

/** Build contract §1.1 — three statuses is the whole surface a harness sees. */
export type ToolResult =
  | { status: "ok"; output: Json }
  /** Guard said no / needs a human. */
  | { status: "denied"; reason: string; needs?: DeniedNeeds }
  | { status: "error"; error: { code: string; message: string } };

/** Build contract §1.1 */
export type DeniedNeeds =
  /** A card is waiting for the user. */
  | { kind: "approval"; approvalId: string }
  /** An account must be connected. */
  | { kind: "connect"; toolkit: string }
  /** §12 law: never available off-interaction. */
  | { kind: "unattended-destructive" };

/** Build contract §1.1 */
export interface ToolListing {
  name: string;
  title: string;
  description: string;
  /** The tool's grade as it stands, `ungraded` included: a harness's model is
   *  told "nobody has graded this" rather than handed a `write` we invented for
   *  it. The guard is still the gate — an ungraded call asks at call time — but a
   *  harness that can read the state can say so before it tries. */
  risk: RiskLabel;
  /** JSON Schema for the tool's input. Every in-process harness must hand
   *  schemas to its model, and JSON Schema is the interchange — without it a
   *  harness can SEE a tool and still not call it. */
  inputSchema?: JsonSchema;
  /** The tool's DECLARED result shape — extraction captures it from the host's
   *  own contract; surfaces hand it to the model so data fields are known before
   *  any call. Absent when the host's source declares none (never invented). */
  outputSchema?: JsonSchema;
}

/** Build contract §1.2 */
export interface TurnSkills {
  /** ~30 tokens each; always cheap. */
  list(): Promise<SkillListing[]>;
  /** Full SKILL.md body, on demand. */
  load(name: string): Promise<string>;
}

/** Build contract §1.2 */
export interface SkillListing {
  name: string;
  description: string;
}

/**
 * Build contract §1.3 — the harness's own state, opaque to us. Cleared by the
 * runtime on arbitrary history edits or a harness swap; a prefix truncation
 * uses the harness's native rewind instead (adapter's business).
 */
export interface TurnState {
  /** Opaque to us. */
  get(): string | undefined;
  /** Persisted at turn end. */
  set(value: string): void;
  clear(): void;
}

/**
 * Build contract §1.5 — the CLOSED yield vocabulary. Routing is frozen:
 * `text` → screen + transcript · `status` → screen only ·
 * `error` → screen + audit (not the transcript) · `usage` → audit/metering
 * only · `notice` → screen + transcript as persisted SYSTEM chrome. Tool calls
 * are mirrored by the runtime, never yielded; harnesses never yield view
 * events.
 */
export type HarnessEvent =
  | { type: "text"; delta: string }
  /**
   * Consumer-voice; ephemeral, screen-only — a BEAT.
   *
   * `phase` and `appId` are additive (the union stays closed; widening a member
   * is not a breaking change, adding one is). A harness that says nothing but
   * `label` behaves exactly as it did.
   */
  | { type: "status"; label: string; phase?: BeatPhase; appId?: AppId }
  /** Consumer-voice; no internals. */
  | { type: "error"; message: string; code?: string }
  /** A SYSTEM fact for the transcript — persisted and rendered as chrome,
   *  never the assistant's voice (2026-08-10 ruling). Narrow on purpose: the
   *  step-limit part is the only system fact today; widening the member is
   *  additive, adding a member is not. */
  | { type: "notice"; notice: VendoStepLimitPart }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      model?: string;
    };

/**
 * Where a beat sits in the arc of making something — CLOSED at six members, so a
 * receiver can render an ordered progression rather than a bag of strings.
 *
 * It is coarse on purpose: a phase is what a PERSON would recognise as a stage
 * of the work, never a step in our pipeline. The `label` carries the words; this
 * carries the position. Beats never name a file, a tool slug, a model, a token
 * count, or an id.
 */
export type BeatPhase =
  | "understanding"
  | "planning"
  | "assembling"
  | "building"
  | "checking"
  | "finishing";
