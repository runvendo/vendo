/**
 * The AWAY entry — core's `AgentRunner` seam (01-core §13), implemented on this
 * package's runtime instead of a second loop.
 *
 * One firing is one non-interactive harness run: `interactive: false`, the
 * engine's own fire-time `RunContext` (venue "automation", presence "away", the
 * firing trigger's id — the guard's away-grant lookup matches on it), the
 * sponsor's durable workspace mounted, and the TASK's guard-bound registry as the
 * whole tool surface. Everything else — approvals as §1.4's wait-or-fail (here:
 * fail, with the card left standing), the audit row, the transcript, the view
 * channel — is the runtime's and the guard's, inherited rather than rebuilt.
 *
 * The report is assembled from the three things the run really leaves behind: the
 * shipped tool bridge's own `onCall`/`gate` rails (the calls and the outcomes the
 * guard returned), the persisted assistant message (the summary, read back
 * through the real read path and narrowed to the model's closing account), and
 * the harness's own `error` event.
 */
import {
  VendoError,
  createTurnSkills,
  hostSkillFiles,
  type AgentRunner,
  type AgentRunReport,
  type FilesAdapter,
  type Guard,
  type Harness,
  type HarnessEvent,
  type Skill,
  type RunContext,
  type SeatModels,
  type ThreadId,
  type ToolCall,
  type ToolOutcome,
  type Turn,
} from "@vendoai/core";
import { wrapWorkspaceForRender } from "@vendoai/apps";
import { createHarnessRuntime, type HarnessRuntimeDeps } from "@vendoai/harnesses";
import { storeFiles, threadMessageStore, threadStore, workspaceStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { assemblePrompt, type SystemPromptHook } from "./prompt.js";

/** What a caller with no budget gets. The automations engine always passes its
 *  own (50), so this only bounds a host driving the seam directly. */
const DEFAULT_MAX_TOOL_CALLS = 20;

export interface AwayRunnerDeps {
  /** The brain, with its knobs already bound. */
  harness: Harness<unknown>;
  store: VendoStore;
  guard: Guard;
  /** Where workspace blobs land; unset → the store's own rows. */
  files?: FilesAdapter;
  /** Projected into the read-only `/host/skills` mount, as in a session. */
  skills?: readonly Skill[];
  /** The host's prompt block. */
  instructions?: string;
  /**
   * The run's system prompt, for a composition that already has one. Handed this
   * package's own assembly (`instructions`, the ctx's situation data, and the
   * guard's directions); a returned string is used verbatim, `undefined` is that
   * default — never a promptless run.
   *
   * It exists because the prompt is VENUE-GATED and carries the guard's
   * directions, so it needs the ctx: the umbrella assembles a chat turn's brief
   * per turn, and an away firing that thought with a different brief than a chat
   * turn would be a second agent wearing the same name.
   */
  system?: SystemPromptHook;
  /** The seats a harness that does NOT bring its own brain reads (`vendo()`). */
  models?: SeatModels<LanguageModel>;
  liveTurn?: HarnessRuntimeDeps["liveTurn"];
}

interface RecordedCall {
  call: ToolCall;
  outcome: ToolOutcome["status"];
}

function fallbackSummary(status: AgentRunReport["status"], calls: readonly RecordedCall[]): string {
  if (status === "error") return "The run could not be completed.";
  if (status === "stopped") return "The run stopped before it was finished.";
  return `The run completed with ${calls.length} tool call${calls.length === 1 ? "" : "s"}.`;
}

/**
 * Watch the harness's own closed vocabulary for a failure, without taking
 * anything away from the runtime.
 *
 * A harness `error` event reaches the SCREEN's error channel and never the
 * transcript (runtime.ts), so it is invisible to a caller that only reads the
 * persisted turn — and "the nightly digest failed" reported as a successful run is
 * the failure this whole seam exists to avoid. A throw is left to propagate: the
 * runtime's own handler already puts its plain sentence in the transcript, so only
 * the STATUS is missing here.
 *
 * Wrapping is safe: the adapter slots a harness reads (`harnessAdapters`) are
 * keyed on the object its own factory closed over, never on the value handed to
 * the runtime.
 */
function watchForFailure(
  harness: Harness<unknown>,
  onFailure: (message?: string) => void,
): Harness<unknown> {
  return {
    ...harness,
    async *run(turn: Turn<unknown>): AsyncGenerator<HarnessEvent, void, void> {
      try {
        for await (const event of harness.run(turn)) {
          if (event.type === "error") onFailure(event.message);
          yield event;
        }
      } catch (error) {
        onFailure();
        throw error;
      }
    },
  };
}

/**
 * How much of the model's account the run record carries. `summary` is rendered
 * VERBATIM in the automations panel's run row, so this is a reading budget — a
 * few sentences someone takes in at a glance — not a storage limit.
 */
const SUMMARY_MAX_CHARS = 400;

/**
 * The label a model puts on its own closing account: "## Summary",
 * "**Summary:**", "Final summary —". The heading marks, the emphasis and the
 * punctuation after it are all part of the LABEL, never of the words it
 * introduces.
 */
const SUMMARY_LABEL = /^[#*\s]*(?:final|closing)?\s*summary[:\-—*\s]*/i;

/** Cut to the budget on a sentence boundary when there is one near it, so a
 *  narrowed summary ends on a finished thought rather than mid-word. */
function capped(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const head = text.slice(0, SUMMARY_MAX_CHARS);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return sentenceEnd > SUMMARY_MAX_CHARS / 2
    ? head.slice(0, sentenceEnd + 1)
    : `${head.trimEnd()}…`;
}

/**
 * The SUMMARY out of what the model said (01-core §13, 07-automations §5 —
 * "agentic: model-written").
 *
 * An away turn's assistant message is the whole working narration: the plan it
 * announced, every note it made on the way, and only then the account of what
 * happened. Reporting all of it made a succeeded run render thousands of
 * characters of "I'll gather all the data simultaneously… **Analysis notes:**"
 * where the panel's run row promises a line.
 *
 * A reply already inside the budget IS the summary and is left exactly as
 * written — narrowing a short answer would drop things it is the only record of.
 * A longer one is narrowed to the model's own closing account: the section it
 * MARKED as a summary if it wrote one, else its closing paragraph. Never a
 * sentence of ours — the model's words, just the right ones.
 */
function conciseSummary(spoken: string): string {
  if (spoken.length <= SUMMARY_MAX_CHARS) return spoken;
  const blocks = spoken.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== "");
  // The LAST label wins: a run that summarised twice ended on the later one.
  let labelled = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (SUMMARY_LABEL.test(blocks[index]!)) {
      labelled = index;
      break;
    }
  }
  const chosen = labelled === -1
    ? blocks.at(-1)
    // A label with nothing after it on its own line introduces the block BELOW it.
    : blocks[labelled]!.replace(SUMMARY_LABEL, "").trim() || blocks[labelled + 1];
  return capped((chosen ?? spoken).trim());
}

/** The assistant's own words for the turn, read back through the real read path. */
function spokenSummary(messages: readonly UIMessage[]): string {
  const reply = [...messages].reverse().find((message) => message.role === "assistant");
  if (reply === undefined) return "";
  return conciseSummary(reply.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim());
}

/**
 * 01-core §13 — one non-interactive harness run per call.
 *
 * `AgentComposition` (what `agentComposition(agent)` returns) satisfies these deps
 * structurally, so a host that already built an `agent()` can hand its composition
 * straight in.
 */
export function awayRunner(deps: AwayRunnerDeps): AgentRunner {
  return async (task, ctx) => {
    const cap = task.budget?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new VendoError("validation", "maxToolCalls must be a positive integer");
    }
    // Everything the engine put on the ctx rides through untouched — the sponsor,
    // the venue, the appId, the firing trigger's id, the asserted memberships.
    // Only presence is asserted, for a caller that came in without it.
    const awayCtx: RunContext = { ...ctx, presence: "away" };
    const principal = awayCtx.principal;

    /** One entry per call the harness attempted, in order, each carrying the last
     *  thing known about it. `error` is the opening value only for a call whose
     *  outcome hook never fires at all. */
    const recorded: RecordedCall[] = [];
    const attempted = (call: ToolCall): RecordedCall => {
      const existing = recorded.find((entry) => entry.call.id === call.id);
      if (existing !== undefined) return existing;
      const entry: RecordedCall = { call, outcome: "error" };
      recorded.push(entry);
      return entry;
    };
    let startedCalls = 0;
    let budgetRefused = false;
    let failed = false;
    /** The harness's own sentence for the failure, when it gave one. */
    let failureMessage: string | undefined;

    await deps.store.ensureSchema();
    const transcript = threadMessageStore<UIMessage>(deps.store);
    const threadId = `thr_${randomUUID()}` as ThreadId;
    await threadStore(deps.store).put(principal, { id: threadId, messages: [] });
    // The SPONSOR's durable workspace, with the same `/host/skills` projection and
    // the same org mounts (§9.7) a session gets — the ctx carries the memberships
    // the engine asserted for this run.
    const workspace = await workspaceStore(deps.store, { files: deps.files ?? storeFiles(deps.store) })
      .open(principal, {
        host: hostSkillFiles(deps.skills ?? []),
        ...(awayCtx.memberships === undefined ? {} : { memberships: awayCtx.memberships }),
      });

    const runtime = createHarnessRuntime({
      // THE TASK's registry, never one of this runner's own choosing: the caller
      // decides an unattended run's tool surface, and it is already guard-bound —
      // so §12's unattended projection is what answers `list()` here.
      tools: task.tools,
      guard: deps.guard,
      skills: createTurnSkills(workspace),
      transcript,
      // `harnessState` is left unset on purpose — the runtime's per-run memory is
      // the whole truth for a fresh thread, so there is nothing to carry and
      // nothing to write.
      // §1.6 — the render seam, on the runtime's generic `wrapWorkspace` slot:
      // an away run's hot-path commit paints too (the part persists, so the
      // sponsor's thread shows the screen the run built). BARE — no floor, no
      // app half — because this standalone runtime composes no apps runtime to
      // fill them; the umbrella's composition does.
      wrapWorkspace: (turnWorkspace, opts) => wrapWorkspaceForRender(turnWorkspace, {
        turnId: opts.turnId,
        emit: opts.emit,
      }),
      bridge: {
        // Every call the harness ATTEMPTS, before the guard sees it. It is only an
        // observer (it never rules a call out), and it is here because a call the
        // preview refuses — `interactive: false` and nobody there to approve — is
        // denied without ever reaching `execute`, so `onCall` below never sees it.
        // Leaving it out of the report would hide the very thing the run record is
        // for: the automation asked, and it is waiting on a person.
        preflight: async (call) => {
          attempted(call).outcome = "pending-approval";
          return undefined;
        },
        // The budget, at the one place every guarded call passes. Spent, further
        // calls are refused BEFORE the registry — nothing runs past the bound.
        gate: () => {
          if (startedCalls >= cap) {
            budgetRefused = true;
            return { status: "error", error: { code: "budget-exhausted", message: "Tool-call budget exhausted" } };
          }
          startedCalls += 1;
          return undefined;
        },
        onCall: (call) => {
          const entry = attempted(call);
          return (outcome) => {
            entry.outcome = outcome.status;
          };
        },
      },
      ...(deps.liveTurn === undefined ? {} : { liveTurn: deps.liveTurn }),
    });

    const directions = await deps.guard.directions(awayCtx);
    const assembled = assemblePrompt({
      ...(deps.instructions === undefined ? {} : { instructions: deps.instructions }),
      ...(awayCtx.context === undefined ? {} : { situation: awayCtx.context }),
      directions,
    });
    const system = deps.system === undefined
      ? assembled
      : (await deps.system(awayCtx, { assembled, directions })) ?? assembled;
    const message: UIMessage = {
      id: `msg_${randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: task.prompt }],
    };

    try {
      const response = await runtime.run({
        harness: watchForFailure(deps.harness, (message) => {
          failed = true;
          failureMessage = message;
        }),
        threadId,
        messages: [message],
        ctx: awayCtx,
        workspace,
        interactive: false,
        system,
        ...(deps.models === undefined ? {} : { models: deps.models }),
        ...(task.abortSignal === undefined ? {} : { signal: task.abortSignal }),
      });
      // Drained, not discarded: the stream's `onFinish` is what persists the turn
      // and writes its audit row, and it only fires on consumption.
      await response.text();
    } catch {
      failed = true;
    }

    const stopped = task.abortSignal?.aborted === true || budgetRefused;
    const status: AgentRunReport["status"] = stopped
      ? "stopped"
      : failed ? "error" : "ok";
    // A summary is worth a lost turn, never a lost run: an unreadable transcript
    // falls back to the counted sentence rather than failing a finished run.
    const spoken = failureMessage
      ?? spokenSummary(await transcript.list(principal, threadId).catch(() => []));
    return {
      status,
      summary: spoken === "" ? fallbackSummary(status, recorded) : spoken,
      toolCalls: recorded,
    };
  };
}
