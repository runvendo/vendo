/**
 * `instant()` — the non-agentic specialist (architecture §6, §2).
 *
 * The same pattern `vendo()` reaches by thinking, compiled into a straight line:
 * one routing call decides what kind of ask this is, and an app ask goes STRAIGHT
 * to the apps pipeline. That is the whole latency story. A resident thinker pays
 * a full-weight model call just to decide it should use a tool, and then a second
 * one to narrate the result; instant() pays one small call and hands the pipeline
 * the prompt, so the plan — which IS the layout — reaches the screen while a
 * resident would still be forming its first sentence.
 *
 * It is a harness, not a shortcut around one. Single model calls survive here as
 * PRIVATE INTERNALS (§2) and nothing else: there is no loop, no delegation, no
 * subagent, no context management. Every host effect goes through
 * `turn.tools.call()`, so the guard, the audit row, the approval card, the view
 * channel and the transcript mirror are the runtime's exactly as they are for
 * every other harness — the specialist buys speed, never a second safety story.
 *
 * What it deliberately does NOT own: the generation pipeline. `vendo_apps_create`
 * / `vendo_apps_edit` are ordinary guarded tools that run the conductor
 * (`packages/apps/src/generation/conductor.ts` — one plan call, parallel fill
 * workers, the checking layer with its two fix rounds). Reaching into the
 * conductor directly would mean a second, unguarded door into app generation, and
 * would put a pipeline body in `packages/harnesses`, which the layering forbids.
 */
import {
  VENDO_APPS_CREATE_TOOL,
  VENDO_APPS_EDIT_TOOL,
  modelToolDescription,
  type Harness,
  type Json,
  type ToolListing,
  type Turn,
} from "@vendoai/core";
import { startTurn, turnModelMessages, wireErrorMessage } from "@vendoai/agent/internal";
import { jsonSchema, streamText, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { defineHarness } from "./define.js";

/** The runtime's discovery meta-tool. Its PRESENCE is the fact that matters
 *  here: it means `turn.tools.list()` is a curated subset, not the world. */
const FIND_TOOLS = "find_tools";

/** The router's one tool. Never user-visible — forcing the answer through a
 *  schema'd tool call keeps it in shape where free text can always drift, and
 *  the branch check after `toolCalls` is what makes the space actually closed. */
const ROUTE_TOOL = "route";

/**
 * Acting steps for a NON-app ask: one to call the tool, one to say what happened.
 *
 * Not one, and not more. Zero narration after a payment is a worse product than a
 * second cheap call; a third step is a thinking loop, and a harness with a
 * thinking loop is `vendo()`, not this. The cap is the specialist's definition.
 */
const ACT_STEPS = 2;

/** A tool with no declared input still needs a schema the provider will accept. */
const NO_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export interface InstantHarnessOptions {
  /** Overrides the `default` seat for the acting step of this turn only. */
  model?: LanguageModel;
}

export interface InstantHarnessDeps {
  /**
   * An explicit system prompt, for a host driving this harness outside our
   * composition. Set, it WINS over `turn.system`; unset — the normal case — the
   * deployment's assembled prompt arrives on the turn. Same seam, same reason as
   * `vendo()`: this value is constructed at boot, where no `RunContext` exists.
   */
  system?: string | (() => string | undefined | Promise<string | undefined>);
}

const optionsSchema = z.object({ model: z.unknown().optional() });

/** What one routing call may answer. Four branches, and no fifth. */
interface Route {
  do: "create" | "edit" | "act" | "cannot";
  prompt?: string;
  appId?: string;
  instruction?: string;
  reasons?: string[];
}

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    do: {
      type: "string",
      enum: ["create", "edit", "act", "cannot"],
      description:
        "create = the person wants a NEW view, screen, dashboard, report or tool built for them. "
        + "edit = they want a change to the app already on their screen. "
        + "act = anything else this product can do with its own tools — moving money, sending "
        + "something, setting up an automation, connecting an account, answering with live data. "
        + "cannot = this product genuinely cannot do it.",
    },
    prompt: { type: "string", description: "create only: the person's request, in their own words." },
    appId: { type: "string", description: "edit only: the id of the app being changed." },
    instruction: { type: "string", description: "edit only: the change, in one sentence." },
    reasons: {
      type: "array",
      items: { type: "string" },
      description:
        "cannot only: one or two plain sentences the person reads. Say what this product cannot "
        + "do, in their words, with no mention of tools, models or internals.",
    },
  },
  required: ["do"],
  additionalProperties: false,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every app id this conversation has already produced, newest last.
 *
 * A thread's app arrives in the transcript as the runtime's mirrored tool result
 * (`writeMirror`), so the id is in the persisted history and nowhere else — the
 * harness is told nothing about apps and must not be. Read off the transcript
 * rather than kept in `turn.state`: state is cleared by a harness swap, and the
 * mid-conversation swap instant()→vendo()→instant() has to keep working.
 */
function appIdsInThread(messages: readonly { parts?: unknown }[]): string[] {
  const ids: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !isRecord(value)) return;
    const appId = value["appId"];
    if (typeof appId === "string" && appId.length > 0 && !ids.includes(appId)) ids.push(appId);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) for (const item of child) visit(item, depth + 1);
      else visit(child, depth + 1);
    }
  };
  for (const message of messages) {
    for (const part of (message.parts ?? []) as Array<Record<string, unknown>>) {
      if (!isRecord(part)) continue;
      const type = String(part["type"] ?? "");
      if (type !== "dynamic-tool" && !type.startsWith("tool-")) continue;
      visit(part["output"], 0);
      visit(part["input"], 0);
    }
  }
  return ids;
}

/** The person's latest words — what the router classifies. */
const latestAsk = (turn: Turn<unknown>): string => {
  for (let index = turn.messages.length - 1; index >= 0; index -= 1) {
    const message = turn.messages[index];
    if (message?.role !== "user") continue;
    const text = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
};

/**
 * Project the equipped tools into an ai-SDK toolset that executes through
 * `turn.tools.call()`. Mutated in place rather than rebuilt, because `streamText`
 * re-reads the same object each step — so a tool discovered through `find_tools`
 * on the acting step is genuinely callable on the reporting one.
 */
async function equip(
  turn: Turn<unknown>,
  tools: ToolSet,
  afterCall: () => Promise<void>,
): Promise<string[]> {
  const listings = await turn.tools.list();
  for (const listing of listings) {
    tools[listing.name] ??= tool({
      description: modelToolDescription(listing),
      inputSchema: jsonSchema((listing.inputSchema ?? NO_INPUT_SCHEMA) as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown) => {
        const result = await turn.tools.call(listing.name, input as Json);
        await afterCall();
        return result;
      },
    });
  }
  return listings.map((listing) => listing.name);
}

/**
 * The one routing call. Forced tool use, so the answer is inside the four
 * branches by construction; `undefined` when the provider gave nothing usable,
 * which the caller reads as "just act" rather than as a failure — a router that
 * cannot decide must never be the reason a person's ask goes nowhere.
 *
 * It runs on the FILL seat: contract §4's cheap/fast tier. Routing is a bounded,
 * schema-pinned classification, which is exactly that tier's job, and the whole
 * reason instant() exists is that the person sees their layout in seconds.
 */
async function routeAsk(
  turn: Turn<unknown>,
  equipped: readonly ToolListing[],
  appIds: readonly string[],
): Promise<Route | undefined> {
  const canBuild = equipped.some((listing) => listing.name === VENDO_APPS_CREATE_TOOL);
  const canEdit = equipped.some((listing) => listing.name === VENDO_APPS_EDIT_TOOL);
  const canSearch = equipped.some((listing) => listing.name === FIND_TOOLS);
  const menu = equipped
    .filter((listing) => !listing.name.startsWith("vendo_apps_") && listing.name !== FIND_TOOLS)
    .map((listing) => `- ${listing.title || listing.name}: ${listing.description}`)
    .join("\n");
  const system = [
    "You sort one request into one of four branches, and nothing else. You never talk to the person.",
    canBuild
      ? "This product CAN build a person a new view, screen, dashboard or small tool on demand."
      : "This product CANNOT build new views or apps. Never answer \"create\".",
    canEdit && appIds.length > 0
      ? `Apps already in this conversation, oldest first: ${appIds.join(", ")}. The one on screen is the last.`
      : "There is no app on screen yet, so \"edit\" is not available.",
    menu.length === 0 ? "This product has no other tools." : `Some of what else this product can do:\n${menu}`,
    canSearch
      ? "That list is a SHORTLIST, not the whole product: more tools — connected email, calendars, "
        + "messaging, the long tail of this product's own API — can be searched for and used. So a "
        + "request the shortlist does not obviously cover is still \"act\". Never answer \"cannot\" "
        + "because you did not see a matching tool."
      : "Prefer \"act\" over \"cannot\": only answer \"cannot\" when nothing above can serve the request.",
  ].join("\n\n");

  try {
    const result = streamText({
      model: turn.models.fill,
      system,
      prompt: latestAsk(turn),
      tools: {
        [ROUTE_TOOL]: {
          description: "Record which branch this request belongs to.",
          inputSchema: jsonSchema(ROUTE_SCHEMA as unknown as Parameters<typeof jsonSchema>[0]),
          // No provider-side strictness to lean on (the ai SDK's tool surface
          // has no such knob) — the branch check below is the enforcement.
        },
      },
      toolChoice: { type: "tool", toolName: ROUTE_TOOL },
      maxRetries: 0,
      abortSignal: turn.signal,
    });
    const calls = await result.toolCalls;
    const input = calls.find((candidate) => candidate.toolName === ROUTE_TOOL)?.input;
    if (!isRecord(input)) return undefined;
    const branch = input["do"];
    if (branch !== "create" && branch !== "edit" && branch !== "act" && branch !== "cannot") return undefined;
    return {
      do: branch,
      ...(typeof input["prompt"] === "string" ? { prompt: input["prompt"] } : {}),
      ...(typeof input["appId"] === "string" ? { appId: input["appId"] } : {}),
      ...(typeof input["instruction"] === "string" ? { instruction: input["instruction"] } : {}),
      ...(Array.isArray(input["reasons"])
        ? { reasons: input["reasons"].filter((reason): reason is string => typeof reason === "string") }
        : {}),
    };
  } catch {
    // A router that could not be reached is not a turn that dies: fall through to
    // the acting path, which is the branch that can still serve most asks.
    return undefined;
  }
}

/** What the assistant says once the pipeline has put the app on the screen. The
 *  view IS the answer, so this is one line, not a narration. */
const BUILT = "Here it is.";
const CHANGED = "Updated.";
const BUILD_FAILED = "I couldn't put that together. Try describing it a different way.";
const EDIT_FAILED = "I couldn't make that change. Try describing it a different way.";
const REFUSED_BY_GUARD =
  "I couldn't do that one — it isn't something I'm allowed to do here.";
const NOTHING_TO_SAY =
  "I couldn't work out what to do with that. Could you say it another way?";

export function instant(deps: InstantHarnessDeps = {}): Harness<InstantHarnessOptions> {
  return defineHarness<InstantHarnessOptions>({
    name: "instant",
    optionsSchema,
    async *run(turn) {
      // A caller that hung up before the turn started gets no model call at all.
      if (turn.signal.aborted) return;

      const equipped = await turn.tools.list();
      const appIds = appIdsInThread(turn.messages);
      const route = await routeAsk(turn, equipped, appIds);
      if (turn.signal.aborted) return;

      const has = (name: string): boolean => equipped.some((listing) => listing.name === name);

      // A router answer naming a tool this deployment never equipped is answered
      // by the world, not by the router: fall through to acting.
      if (route?.do === "create" && has(VENDO_APPS_CREATE_TOOL)) {
        yield { type: "status", label: "Building it…" };
        const result = await turn.tools.call(VENDO_APPS_CREATE_TOOL, {
          prompt: route.prompt?.trim() || latestAsk(turn),
        });
        yield* speakToolResult(result, BUILT, BUILD_FAILED);
        return;
      }

      if (route?.do === "edit" && has(VENDO_APPS_EDIT_TOOL)) {
        // The id must at least have APPEARED in this conversation's tool
        // traffic. A router asked to name an app will name one whether or not
        // it exists — measured live (2026-08-01): after a build failed, the
        // follow-up edit was routed at an invented id and spent a real tool
        // call on nothing. HONEST SCOPE: the harvest reads tool INPUTS as well
        // as outputs, so it stops fresh inventions but not a re-route at an id
        // an earlier failed call already carried. No app in the transcript
        // means there is nothing to edit, and the acting step (which has the
        // create tool too) is the honest recovery.
        const named = route.appId !== undefined && appIds.includes(route.appId) ? route.appId : undefined;
        const appId = named ?? appIds[appIds.length - 1];
        if (appId !== undefined) {
          yield { type: "status", label: "Changing it…" };
          const result = await turn.tools.call(VENDO_APPS_EDIT_TOOL, {
            appId,
            instruction: route.instruction?.trim() || latestAsk(turn),
          });
          yield* speakToolResult(result, CHANGED, EDIT_FAILED);
          return;
        }
      }

      // A refusal is only honest if something LOOKED. `turn.tools.list()` is a
      // curated shortlist whenever the discovery rail is equipped, so a router
      // that answers "cannot" off it is refusing on ignorance — measured live
      // (2026-08-01): "Email me my balance" got "this product cannot send
      // emails" from a deployment with Gmail connected but off the initial
      // loadout. The acting step can search, and the shipped capability-miss
      // rail lives there, so the refusal is made where the looking happens.
      if (route?.do === "cannot" && !has(FIND_TOOLS)) {
        const reasons = (route.reasons ?? []).filter((reason) => reason.trim().length > 0);
        // The sentences are the person's answer verbatim — the conductor's own
        // `<Cannot>` discipline. An empty refusal would be a silent turn.
        yield { type: "text", delta: reasons.length > 0 ? reasons.join(" ") : NOTHING_TO_SAY };
        return;
      }

      yield* act(turn, deps);
    },
  });
}

/**
 * One line about a guarded apps call, in the consumer's voice.
 *
 * Three outcomes, three different things to say, and never nothing. A refusal is
 * not a failure and must never render as one (contract §1.1). A build that
 * failed already put today's `data-vendo-build-failed` banner on screen through
 * the bridge — that IS the failure affordance, the same one `createAgent`
 * raises — so the harness's job is the sentence beside it, not a second generic
 * error chunk. Measured live (2026-08-01): raising the error event instead left
 * the turn with a banner, an "an error occurred" string, and total silence from
 * the assistant.
 */
function* speakToolResult(
  result: { status: string; reason?: string; error?: { message: string } },
  success: string,
  failure: string,
): Generator<{ type: "text"; delta: string }> {
  if (result.status === "ok") {
    yield { type: "text", delta: success };
    return;
  }
  if (result.status === "denied") {
    yield { type: "text", delta: result.reason?.trim() || REFUSED_BY_GUARD };
    return;
  }
  yield { type: "text", delta: buildFailureSentence(result.error?.message) ?? failure };
}

/**
 * The person-readable half of an apps failure, when there is one.
 *
 * `buildFailureReason` (apps/runtime.ts) produces a CLOSED set: the brain's own
 * refusal sentences verbatim ("this host has machines disabled, so…"), the
 * actionable model-unavailable line, `"timed out"`, `"quota exhausted"`, and
 * `"generation failed"`. Only the last is a word that tells a person nothing —
 * everything else is worth saying, and swallowing it is how "every Friday,
 * summarise my spending" came back as a shrug instead of the true reason
 * (measured live, 2026-08-01).
 */
function buildFailureSentence(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const reason = message.replace(/^app build failed:\s*/i, "").trim();
  if (reason.length === 0 || reason === message) return undefined;
  if (/^generation failed\.?$/i.test(reason)) return undefined;
  return reason;
}

/**
 * The non-app branch: the guarded toolset, capped at {@link ACT_STEPS}.
 *
 * It drives the SHIPPED `startTurn` — the same call `createAgent` and `vendo()`
 * drive — so the history window, the cache breakpoints, `buildFailedStop` and the
 * loadout are shared rather than re-derived here. Only the cap is instant()'s own.
 */
async function* act(
  turn: Turn<InstantHarnessOptions>,
  deps: InstantHarnessDeps,
): AsyncGenerator<
  | { type: "text"; delta: string }
  | { type: "error"; message: string; code?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  void,
  void
> {
  const model = turn.options?.model ?? turn.models.default;
  const system =
    (typeof deps.system === "function" ? await deps.system() : deps.system)
    ?? turn.system
    ?? "";

  const tools: ToolSet = {};
  let equipped: string[] = [];
  const refresh = async (): Promise<void> => {
    equipped = await equip(turn, tools, refresh);
  };
  await refresh();

  let loop: Awaited<ReturnType<typeof startTurn>>;
  try {
    loop = await startTurn({
      model,
      system,
      messages: [...turn.messages],
      tools,
      signal: turn.signal,
      toolSearch: { activeToolNames: () => equipped, attach: () => {} },
      context: { maxSteps: ACT_STEPS },
    });
  } catch (error) {
    yield { type: "error", message: wireErrorMessage(error), code: "model" };
    return;
  }

  let said = false;
  let failed = false;
  try {
    for await (const part of loop.result.fullStream) {
      switch (part.type) {
        case "text-delta":
          said = said || part.text.trim().length > 0;
          yield { type: "text", delta: part.text };
          break;
        case "error":
          failed = true;
          yield { type: "error", message: wireErrorMessage(part.error), code: "model" };
          break;
        case "tool-error":
          yield { type: "error", message: wireErrorMessage(part.error), code: "tool" };
          break;
        case "abort":
          return;
        case "finish": {
          const { inputTokens, outputTokens, inputTokenDetails } = part.totalUsage;
          yield {
            type: "usage",
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
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
          // Tool call/result chunks are the RUNTIME's to mirror (§1.5); echoing
          // them here would double every call.
          break;
      }
    }
  } catch (error) {
    yield { type: "error", message: wireErrorMessage(error), code: "model" };
    return;
  }

  // THE CLOSE. A turn that acted and said nothing is a failed turn whatever the
  // status code — measured live (2026-08-01): "what is my checking balance?" spent
  // its first acting step on a wrong account id and its second on the retry that
  // WORKED, then hit the cap, so the person got two tool calls, no sentence, and
  // the answer sat unread in the tool result.
  //
  // The fix is one tool-LESS call, not a bigger cap. Raising the cap buys another
  // chance to act and still no guarantee of an answer; a call with no tools can
  // only speak, so the invariant "instant() never ends a turn silently" holds by
  // construction. Bounded and non-iterative: it happens at most once, never loops.
  if (!said && !failed && !turn.signal.aborted) {
    yield* close(turn, model, system, loop);
  }
}

/** What the closing call is told. It has no tools, so its only move is to answer. */
const CLOSE_INSTRUCTION =
  "Answer the person now, in one or two sentences, using only what the tool results above actually "
  + "returned. If something failed or is missing, say so plainly and say what they can do. Never "
  + "mention tools, ids, or anything about how you work.";

async function* close(
  turn: Turn<InstantHarnessOptions>,
  model: LanguageModel,
  system: string,
  loop: Awaited<ReturnType<typeof startTurn>>,
): AsyncGenerator<{ type: "text"; delta: string }, void, void> {
  try {
    // `turnModelMessages` is the SHIPPED assembler — same history window, same
    // cache breakpoints — so the closing call sees the conversation exactly as the
    // acting call did, plus what the acting call produced.
    const before = await turnModelMessages([...turn.messages], system, undefined);
    const produced = (await loop.result.response).messages;
    const closing = streamText({
      model,
      messages: [...before, ...produced, { role: "user", content: CLOSE_INSTRUCTION }],
      maxRetries: 0,
      abortSignal: turn.signal,
    });
    let spoke = false;
    for await (const delta of closing.textStream) {
      if (delta.trim().length > 0) spoke = true;
      yield { type: "text", delta };
    }
    if (!spoke) yield { type: "text", delta: NOTHING_TO_SAY };
  } catch {
    // Even the close failing must not leave the turn silent.
    yield { type: "text", delta: NOTHING_TO_SAY };
  }
}
