/**
 * The harness contract — build contract 2026-07-30 §1, copied verbatim.
 *
 * Types only, so every block may speak them: `defineHarness` and the runtime
 * that builds a `Turn` live in `@vendoai/harnesses` (build contract §2). The
 * dividing line these shapes draw: we own state, tools, checks, guard, and
 * skills; the harness owns thinking — and orchestration is thinking. A harness
 * receives a `Turn` and yields a closed event vocabulary; it never persists,
 * never touches the wire, and never decides whether a call is allowed.
 *
 * §1.5's `HarnessEvent` list is CLOSED for v1 — adding a member is a breaking
 * change for every host renderer.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LanguageModel, UIMessage } from "ai";
import type { Json } from "./ids.js";
import type { JsonSchema } from "./ids.js";
import type { ResolvedModels } from "./model-seats.js";
import type { WorkspaceFs } from "./workspace.js";

/** Build contract §1 */
export interface Harness<Options = unknown> {
  readonly name: string;
  /** Declares the per-turn-overridable knobs. */
  readonly optionsSchema?: StandardSchemaV1;
  /**
   * Boot-time composition check — never a runtime surprise.
   *
   * Amendment 2026-08-02: `toolDoor` joins `sandbox`. A harness whose thinker
   * is not in this process reaches `turn.tools` over the host's own MCP door
   * (10-mcp §3b), and composition is the only place that can mount one. Unlike
   * `sandbox` this is never a boot ERROR — declaring it is how a harness asks
   * composition for a door, and composition always answers.
   */
  readonly requires?: { sandbox?: boolean; toolDoor?: boolean };
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
  /** §4 — `Readonly<Record<Seat, LanguageModel>>`, exactly as the contract writes
   *  it. `ResolvedModels` itself is generic so `@vendoai/store` can speak seats
   *  without an `ai` dependency; a `Turn` is handed to an in-process harness that
   *  passes the seat straight to `streamText`, so here the model type is named. */
  readonly models: ResolvedModels<LanguageModel>;
  /** §1.3 */
  readonly state: TurnState;
  /** Parsed by optionsSchema, incl. per-turn overrides. */
  readonly options: Options;
  readonly signal: AbortSignal;
  /** Present iff the caller proved presence (a click/message/submit). */
  readonly interactive: boolean;
  /**
   * Amendment 2026-07-31: the deployment's assembled system prompt — the product
   * brief, the host's voice, the guard's directions, the knowledge index, the
   * discovery rail. Composition assembles it per turn because it needs the
   * `RunContext` a `Turn` deliberately does not carry, so it cannot be a
   * construction-time dep of the harness value: a host who writes
   * `harness: vendo()` builds that value once, at boot, with no ctx in sight.
   * Carried HERE so every harness — named, defaulted, or a host's own — is told
   * the same thing. Unset only for a runtime driven without composition.
   */
  readonly system?: string;
  /**
   * Amendment 2026-08-01 (wave 2): the conversation's stable identity.
   * Session-owning adapters (a machine pool, a native session ref) need a
   * per-conversation key; deriving one from `messages[0].id` is a hack that
   * history edits can orphan. The runtime already holds the thread id —
   * passing it is simply true. Opaque to adapters.
   */
  readonly threadId: string;
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
  risk: "read" | "write" | "destructive";
  /** Amendment 2026-07-30: JSON Schema for the tool's input. Every in-process
   *  harness must hand schemas to its model, and JSON Schema is the interchange —
   *  without it a harness can SEE a tool and still not call it. The runtime has
   *  populated this since the amendment landed; the field was missing from the
   *  type, so the contract held at runtime and not at compile time. */
  inputSchema?: JsonSchema;
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
 * Build contract §1.5 — the CLOSED yield vocabulary. Routing (frozen, as
 * amended 2026-07-30): `text` → screen + transcript · `status` → screen only ·
 * `error` → screen + audit (not the transcript) · `usage` → audit/metering
 * only. Tool calls are mirrored by the runtime, never yielded; harnesses never
 * yield view events.
 */
export type HarnessEvent =
  | { type: "text"; delta: string }
  /** Consumer-voice; ephemeral, screen-only. */
  | { type: "status"; label: string }
  /** Consumer-voice; no internals. */
  | { type: "error"; message: string; code?: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      model?: string;
    };
