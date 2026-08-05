/**
 * `vendo()` — the default harness. NOT a second loop: it drives `startTurn` from
 * @vendoai/agent, the same call `createAgent` drives, so every rail in that loop
 * (the step cap, `buildFailedStop`, the history window, the cache breakpoints, the
 * tool-search loadout, the step-limit notice) is shared rather than re-derived.
 * @vendoai/agent's own 134 tests are the specification for it.
 *
 * What the lift changes, and only this:
 * - tools execute through `turn.tools.call()`, which runs the SHIPPED guarded-call
 *   path — so the guard, the audit row, the view channel and the transcript mirror
 *   are not this file's business and cannot be forgotten;
 * - approvals are §1.4's wait-or-fail inside `call()`, so there is no
 *   `needsApproval` hook here and no second consent path;
 * - output is the closed `HarnessEvent` vocabulary instead of wire chunks, so this
 *   file contains no persistence and no wire code;
 * - it hires its own subagents for big jobs. Weight and staffing are the harness's
 *   business — that is the dividing line, and orchestration is thinking.
 */
import { z } from "zod";
import { modelToolDescription, type Harness, type HarnessEvent, type Json, type ToolDescriptor, type Turn } from "@vendoai/core";
import { startTurn, wireErrorMessage, type TurnContext } from "@vendoai/agent/internal";
import { reportHire } from "./runtime.js";
import { jsonSchema, stepCountIs, streamText, tool, type LanguageModel, type ToolSet } from "ai";
import { defineHarness } from "./define.js";

/** How many messages a hired subagent may exchange before it must report back.
 *  Bounded so a runaway helper costs a receipt, not a turn. */
const SUBAGENT_MAX_STEPS = 12;

const HIRE_SUBAGENT = "hire_subagent";

/**
 * The per-turn knobs. `model` is here because a host may forward a model picker to
 * its end users (architecture §3, "Options are declared, then overridable per
 * turn"); everything else defaults.
 */
const optionsSchema = z.object({
  /** Overrides the `default` seat for this turn only. */
  model: z.unknown().optional(),
  maxSteps: z.number().int().positive().optional(),
  historyWindow: z.number().int().positive().optional(),
  contextTokenBudget: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export interface VendoHarnessOptions {
  model?: LanguageModel;
  maxSteps?: number;
  /** The shipped loop's context knobs, per turn. They were declared on the loop
   *  and on `createAgent` but not here, and this file passed `maxSteps` alone —
   *  so a deployment on the default harness (which is every deployment whose
   *  store can serve harness turns) could not reach the history window or the
   *  token budget at all. */
  historyWindow?: number;
  contextTokenBudget?: number;
  maxOutputTokens?: number;
}

/** The knobs a per-turn option may override, and the deployment defaults they
 *  override. One list, so a new knob cannot reach one half and not the other. */
const CONTEXT_KNOBS = ["maxSteps", "historyWindow", "contextTokenBudget", "maxOutputTokens"] as const;

export interface VendoHarnessDeps {
  /**
   * An explicit system prompt, for a host driving this harness outside our
   * composition. Set, it WINS over `turn.system`; unset — the normal case, and
   * what `harness: vendo()` builds — the deployment's assembled prompt arrives on
   * the turn instead. It cannot arrive here: this value is constructed once at
   * boot, and the prompt is venue-gated and carries the guard's directions, so it
   * needs the turn's `RunContext`.
   */
  system?: string | (() => string | undefined | Promise<string | undefined>);
  maxSteps?: number;
  /** The deployment's defaults for the loop's context knobs; a per-turn option of
   *  the same name wins. `maxSteps` stays above for back-compat and reads the
   *  same either way. */
  historyWindow?: number;
  contextTokenBudget?: number;
  maxOutputTokens?: number;
  /**
   * Called once per hired specialist. Defaults to the runtime's own
   * {@link reportHire}, which writes the audit row and the transcript receipt — a
   * hire is staffing the guard never sees (only the specialist's guarded CALLS
   * reach it), so without this it would be invisible. Override only to observe it
   * somewhere else too.
   */
  onHire?: (record: {
    purpose: string;
    skill?: string;
    summary: string;
    usage: { inputTokens: number; outputTokens: number };
  }) => void;
}

/** A tool with no declared input still needs a schema the provider will accept. */
const NO_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

/**
 * Refresh the live toolset from `turn.tools.list()` — the ONE discovery surface
 * (contract §1.1: "currently-equipped tools, post-curation"). Returns the names
 * the model may pick this step.
 *
 * Two things make this the whole discovery rail. The set is re-read rather than
 * captured once, so a tool searched in mid-turn through `find_tools` is offered on
 * the next step; and `tools` is MUTATED in place rather than rebuilt, because
 * `streamText` re-reads the same object each step, so a newly listed tool is
 * genuinely callable without restarting the turn.
 */
async function refreshEquipped(
  turn: Turn<unknown>,
  tools: ToolSet,
  /** Re-read the listing after every call. A `find_tools` call is what changes
   *  the equipped set, and `prepareStep` reads the snapshot synchronously, so the
   *  re-read has to happen while we are still inside the call that changed it. */
  afterCall: () => Promise<void>,
): Promise<string[]> {
  const listings = await turn.tools.list();
  for (const listing of listings) {
    tools[listing.name] ??= tool({
      // Title-first, so the model has a human label to speak (§3): its own
      // refusals and explanations are user-visible surfaces, and `title` is
      // otherwise the one field of the listing this harness never reads.
      description: modelToolDescription(listing),
      inputSchema: jsonSchema((listing.inputSchema ?? NO_INPUT_SCHEMA) as Parameters<typeof jsonSchema>[0]),
      // The whole safety story in one line: the guard, the audit row, the view
      // channel, the transcript mirror and §1.4's approval block all live behind
      // `call()`.
      execute: async (input: unknown) => {
        const result = await turn.tools.call(listing.name, input as Json);
        await afterCall();
        return result;
      },
    });
  }
  return listings.map((listing) => listing.name);
}

interface SubagentReport {
  summary: string;
  /** Every token a hired specialist spent. Unmetered subagents are the bulk of a
   *  build turn's inference, so this is not optional bookkeeping. */
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * A hired subagent: a fresh, blinkered loop with the same hands and the same
 * guard, whose OWN words never leave this function. The resident keeps only the
 * receipt — its private context, not a wire artifact, so the one-assistant law
 * holds without a transcript-only channel (§1.5's routing table has none).
 */
async function runSubagent(
  turn: Turn<unknown>,
  model: LanguageModel,
  input: { instructions: string; skill?: string },
  tools: ToolSet,
): Promise<SubagentReport> {
  let brief = input.instructions;
  if (input.skill !== undefined) {
    // The full SKILL.md body is the job description; loading it is the point of
    // hiring rather than inlining.
    const body = await turn.skills.load(input.skill);
    brief = `${body}\n\n---\n\n${input.instructions}`;
  }
  const result = streamText({
    model,
    system:
      "You are a specialist hired for one job. Do it with the tools you have, then report back in "
      + "at most three sentences. Your reply is read by another agent, not by a person.",
    prompt: brief,
    // No hiring tool: depth is bounded at one, so a helper cannot spawn a tree.
    tools,
    stopWhen: [stepCountIs(SUBAGENT_MAX_STEPS)],
    abortSignal: turn.signal,
  });
  const [text, usage] = await Promise.all([result.text, result.totalUsage]);
  return {
    summary: text.trim() || "The specialist finished without a summary.",
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
}

export function vendo(deps: VendoHarnessDeps = {}): Harness<VendoHarnessOptions> {
  return defineHarness<VendoHarnessOptions>({
    name: "vendo",
    optionsSchema,
    // Machine-less by design: in-process bash over the workspace is enough
    // (architecture §4, "Hands vary").
    async *run(turn) {
      // A caller that hung up before the turn started gets no model call at all.
      if (turn.signal.aborted) return;

      const model = turn.options?.model ?? turn.models.default;
      // Seats are required only where a harness reads them (contract §4,
      // relaxed) — and THIS harness reads `default`, so a turn without it is
      // the caller's composition bug, named loudly rather than limped past.
      if (model === undefined) {
        throw new Error("vendo() thinks with `turn.models.default`, and this turn carries no default seat");
      }
      const context: TurnContext = {};
      for (const knob of CONTEXT_KNOBS) {
        const value = turn.options?.[knob] ?? deps[knob];
        if (value !== undefined) context[knob] = value;
      }
      const system =
        (typeof deps.system === "function" ? await deps.system() : deps.system)
        ?? turn.system
        ?? "";

      // The LIVE surface the model picks from, and the snapshot `prepareStep`
      // reads each step. `turn.tools.list()` is the only source for both: it is
      // the curated, equipped set, and re-reading it is how a tool searched in
      // through `find_tools` becomes callable in the SAME turn. One object, never
      // a copy — `streamText` re-reads it per step, so a copy would freeze the
      // toolset at step one and strand every discovery.
      const residentTools: ToolSet = {};
      let equipped: string[] = [];
      const refresh = async (): Promise<void> => {
        equipped = await refreshEquipped(turn, residentTools, refresh);
      };
      await refresh();
      /** Subagent tokens, drained onto the turn's usage after the stream ends. */
      const hiredUsage: Array<{ inputTokens: number; outputTokens: number }> = [];
      Object.assign(residentTools, {
        [HIRE_SUBAGENT]: tool({
          description:
            "Hire a specialist for one big job (building or editing an app, a long research pass). "
            + "Name a skill to give it the full instructions. It reports back a short summary.",
          inputSchema: z.object({
            instructions: z.string().describe("What the specialist should accomplish."),
            skill: z.string().optional().describe("A skill name from your skill list."),
          }),
          execute: async (input) => {
            try {
              // The specialist gets the same hands as the resident has RIGHT NOW —
              // searched-in tools included — minus the hiring tool, so depth is
              // bounded at one and a helper cannot spawn a tree.
              const { [HIRE_SUBAGENT]: _hiring, ...hands } = residentTools;
              const report = await runSubagent(turn, model, input, hands);
              hiredUsage.push(report.usage);
              (deps.onHire ?? reportHire)({
                purpose: input.instructions,
                ...(input.skill === undefined ? {} : { skill: input.skill }),
                summary: report.summary,
                usage: report.usage,
              });
              return { summary: report.summary };
            } catch (error) {
              // A failed hire is one tool result the resident can react to — never
              // the turn's death.
              console.error("[vendo] harness: subagent failed", {
                error: error instanceof Error ? error.message : String(error),
              });
              return { error: "The specialist could not be reached for that job." };
            }
          },
        }),
      });

      let loop: Awaited<ReturnType<typeof startTurn>>;
      try {
        // THE shipped loop. Every rail lives in it, so this harness cannot drift
        // from `createAgent` on any of them.
        loop = await startTurn({
          model,
          system,
          messages: [...turn.messages],
          tools: residentTools,
          signal: turn.signal,
          // §3.5 — the runtime already minted it and put it on the Turn, so
          // passing it is simply true.
          turnId: turn.turnId,
          // The loadout, in the shipped loop's own vocabulary: `prepareStep`
          // re-reads this each step and restricts what the model may PICK, so a
          // tool the runtime equipped mid-turn is choosable on the next step and a
          // curated-off tool never is. `attach` is a no-op because the runtime —
          // not the harness — owns `find_tools`: that is the dividing line, and it
          // is what gives a third-party harness the same rail for free.
          toolSearch: {
            activeToolNames: () => [...equipped, HIRE_SUBAGENT],
            attach: () => {},
          },
          // The WHOLE context, not just `maxSteps`. Passing one knob is what made
          // every other knob unreachable from `vendo()` — the loop declared them,
          // `createAgent` passed them, and this caller silently dropped them, so
          // the two thinkers disagreed about a host's own configuration.
          ...(Object.keys(context).length === 0 ? {} : { context }),
        });
      } catch (error) {
        yield { type: "error", message: wireErrorMessage(error), code: "model" };
        return;
      }

      try {
        for await (const part of loop.result.fullStream) {
          switch (part.type) {
            case "text-delta":
              yield { type: "text", delta: part.text };
              break;
            case "error":
              // `wireErrorMessage` is the SHIPPED formatter: a Vendo-shaped error
              // keeps its message and code, the Cloud meter's 402 becomes the
              // sentence with figures, reset date and both exits, and anything
              // else stays the fixed generic string. Provider internals never
              // travel; the operator's terminal gets the real error.
              yield { type: "error", message: wireErrorMessage(part.error), code: "model" };
              break;
            case "tool-error":
              // A thrown or malformed tool call is a real failure the user must be
              // told about — swallowing it left the turn looking finished.
              // (`tool-input-error` is a UI-stream chunk, not a fullStream part;
              // the SDK surfaces that class here as `tool-error` too.)
              yield { type: "error", message: wireErrorMessage(part.error), code: "tool" };
              break;
            case "abort":
              // The caller hung up: stop cleanly, say nothing.
              return;
            case "finish": {
              // `model` is left unset: the contract's field is optional, and the
              // resolved model id is not on this part — composition, which chose
              // the seat, is the honest place to attribute it.
              const { inputTokens, outputTokens, inputTokenDetails } = part.totalUsage;
              const hired = hiredUsage.reduce(
                (total, one) => ({
                  inputTokens: total.inputTokens + one.inputTokens,
                  outputTokens: total.outputTokens + one.outputTokens,
                }),
                { inputTokens: 0, outputTokens: 0 },
              );
              yield {
                type: "usage",
                // Subagent tokens are the bulk of a build turn's inference;
                // billing that counted only the resident would under-report by
                // most of the spend.
                inputTokens: (inputTokens ?? 0) + hired.inputTokens,
                outputTokens: (outputTokens ?? 0) + hired.outputTokens,
                ...(inputTokenDetails.cacheReadTokens === undefined
                  ? {}
                  : { cacheReadTokens: inputTokenDetails.cacheReadTokens }),
                ...(inputTokenDetails.cacheWriteTokens === undefined
                  ? {}
                  : { cacheWriteTokens: inputTokenDetails.cacheWriteTokens }),
              };
              break;
            }
            default:
              // Tool call/result chunks are consumed here and dropped: the RUNTIME
              // mirrors them (§1.5), so echoing them would double every call.
              break;
          }
        }
      } catch (error) {
        yield { type: "error", message: wireErrorMessage(error), code: "model" };
        return;
      }

      const stepLimit = await loop.stepLimitPart();
      if (stepLimit !== undefined) {
        // Exhausting the cap is VISIBLE (today's `data-vendo-step-limit` banner).
        // `HarnessEvent` is closed and has no member for it, so it goes out in the
        // assistant's own voice — screen AND transcript, which is what the banner
        // did. The sentence is the loop's, so both callers say the same thing.
        yield { type: "text", delta: `\n\n${stepLimit.message}` };
      }
    },
  });
}
