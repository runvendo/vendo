import { z } from "zod";
import type { VendoErrorCode } from "./errors.js";
import type { ThreadId, TurnId } from "./ids.js";
import { toolCallSchema, type ToolCall, type ToolOutcome } from "./tools.js";

/**
 * The metering figures a turn reports.
 *
 * Field for field the `UsageTotals` a harness already hands the runtime
 * (`@vendoai/harnesses`), restated here because core may not depend on
 * harnesses and a turn's answer is core's shape. Identical on purpose: either
 * side's value is the other's, with no adapter between them.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

/** What every turn that RAN reports, whatever ended it. `text` is the
 *  assistant's own words — the one channel a person reads (§1.5) — and
 *  `toolCalls` pairs each call with how it ended, the same pair
 *  `AgentRunReport` carries so one reader serves both. */
interface TurnRun {
  text: string;
  threadId: ThreadId;
  turnId: TurnId;
  toolCalls: Array<{ call: ToolCall; outcome: ToolOutcome["status"] }>;
  usage: TurnUsage;
}

/** One thing a person has to answer before the turn can go on. `id` is what a
 *  {@link Decisions} map is keyed by, so an answer can never be applied to the
 *  wrong interruption. */
export type Interruption =
  | { id: string; type: "approval"; toolCall: ToolCall }
  /** Wire-defined now, EMITTED post-v1: `ask_user` ends the turn in v1 and the
   *  answer arrives as the next message, so nothing mints this arm yet. It is
   *  frozen here anyway because `@vendoai/ui` and the resume route both parse
   *  this union, and a shape added later is a shape two shipped readers reject. */
  | { id: string; type: "input"; questions: Question[] };

/** One question inside an `input` interruption. Same vocabulary as the
 *  `ask_user` door (a question, and optionally the fixed choices it accepts);
 *  free text when `choices` is absent. */
export interface Question {
  id: string;
  text: string;
  choices?: string[];
}

/** How a caller answers ONE interruption: a verdict for an approval, the
 *  answers for a set of questions. */
export type Decision = "approve" | "deny" | { answers: Record<string, string | string[]> };

/** Every interruption's answer, keyed by {@link Interruption.id}. */
export type Decisions = Record<string, Decision>;

/** The per-resume knobs, the same two a session already takes: the request's
 *  own headers to forward, and the guard/tools context. */
export interface ResumeOptions {
  headers?: Record<string, string> | Headers;
  context?: Record<string, unknown>;
}

/** The wire half. `Interruption`, `Question` and `Decision` all cross a wire —
 *  `@vendoai/ui` renders them and `POST /turns/:id/resume` accepts them — so
 *  each one has a schema, per core's rule that a shape crossing a wire or a
 *  store is parsed, never trusted. */
export const questionSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  choices: z.array(z.string()).optional(),
}).passthrough() satisfies z.ZodType<Question>;

export const interruptionSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("approval"), toolCall: toolCallSchema }).passthrough(),
  z.object({ id: z.string(), type: z.literal("input"), questions: z.array(questionSchema) }).passthrough(),
]) satisfies z.ZodType<Interruption>;

export const decisionSchema = z.union([
  z.literal("approve"),
  z.literal("deny"),
  z.object({ answers: z.record(z.union([z.string(), z.array(z.string())])) }).passthrough(),
]) satisfies z.ZodType<Decision>;

export const decisionsSchema = z.record(decisionSchema) satisfies z.ZodType<Decisions>;

/**
 * What ONE turn answered.
 *
 * Four ends and no fifth: it finished (`ok`), it needs a person before it can
 * go on (`interrupted`), something outside it called time (`stopped`), or it
 * broke (`error`). A caller reads `status` once and every field it then
 * touches is there — which is the whole reason this is a discriminated union
 * and not one wide record of optionals.
 *
 * `TTurn` exists because `resume()` hands back the AGENTS-level `Turn`, and
 * core is the layer everything else depends on, so it cannot name one.
 * `@vendoai/agents` binds it (`TurnResult<T, Turn<T>>`). There is ONE
 * definition of this union and this is it — nothing re-declares it.
 *
 * Deliberately NOT schema-ised: the interrupted arm carries a live closure, and
 * a function is not a wire value. The pieces that DO cross the wire — the
 * interruptions and the decisions answering them — have their schemas above.
 */
export type TurnResult<T = void, TTurn = unknown> =
  | (TurnRun & { status: "ok"; output: T })
  | (TurnRun & {
    status: "interrupted";
    interruptions: Interruption[];
    /** Answer them and carry on. The turn resumes byte-for-byte from where it
     *  parked — a denied call is a refusal the model reads, never a rerun. */
    resume(decisions: Decisions, options?: ResumeOptions): TTurn;
  })
  | (TurnRun & { status: "stopped"; reason: "aborted" | "maxToolCalls" })
  | {
    status: "error";
    /** Empty, always: a turn that broke never spoke, and putting an internal
     *  failure in the assistant's voice is exactly what §1.5 forbids. */
    text: "";
    threadId: ThreadId;
    turnId: TurnId;
    error: { code: VendoErrorCode; message: string };
  };
