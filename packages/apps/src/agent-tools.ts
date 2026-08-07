import {
  VENDO_APPS_PIN_TOOL,
  VENDO_APPS_UNPIN_TOOL,
  VENDO_MAKE_TOOL,
  VENDO_TOOL_TITLES,
  VendoError,
  type AppDocument,
  type AppId,
  type Json,
  type RunContext,
  type ScreenAssembler,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { AppDataAccess } from "./app-data.js";
import { deleteAppData, listAppData, putAppData } from "./data-tools.js";
import { runMakeTool } from "./make-tool.js";
import { input, resolveAppRef } from "./tool-args.js";
import type { AppsRuntime } from "./types.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Exported so the apps PACK can declare exactly these tools through the public
 *  `Pack.tools` slot rather than a privileged path into the registry.
 *
 *  Titles are applied in ONE place below, from core's shared table, rather than
 *  authored per entry: `ToolListing.title` falls back to the identifier, so a
 *  tool that forgets its title hands the model `vendo_apps_open` as its human
 *  label — which is how it reached a live refusal message (wave-1 proof E1-5). */
const descriptors = [
  {
    // The agent's streaming-view bridge keys on this exact core-defined name.
    name: VENDO_MAKE_TOOL,
    // Three sentences of law, each paid for by a live failure. The data-honesty
    // one: calling agents were pre-computing figures into the request ("Total
    // Spent: $0.00"), which the engine rejects as hand-typed — the screen binds
    // live host data itself. The retry one: a rejected change is worth one
    // narrower attempt on the same app, and was worth saying because the
    // alternative the model reached for was rebuilding it from scratch.
    description: "Make the user something to look at — a screen, or a full app — from a plain-language request. Say what they want in your own words; Vendo decides whether to assemble a screen or build an app, and it arrives on the user's own page. Pass `app` only to change one specific existing app — its id, or its name exactly as the user said it, which is resolved against their own apps (if two share that name you are told both, so ask which one); leave it out and Vendo decides whether to continue the last one or start something new. A recurring or scheduled task belongs here too: describe the schedule and the action in the request and it is armed as part of the same call; there is no separate automations tool. One app can hold SEVERAL automations, so to add another one to an app it already has, name that app in `app` and describe the new schedule — never refuse a second schedule. Never bake data values you computed or fetched (counts, totals, amounts) into the request — it binds live host data itself and hardcoded figures fail its checks. Never specify fonts, colors, or branding — it inherits the host theme. You get back a one-line receipt to say out loud, never the screen itself; if the receipt says \"failed\", try once more on the same `app` with a narrower request rather than rebuilding it. Pass `slot` only when the request names a particular place on the user's page for it to land — the host publishes those slot ids, so pass one you were told rather than one you invented, and whatever held that place is replaced. `slot` is for something NEW: to move an app that already exists, use the pin tool instead.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        request: { type: "string", minLength: 1 },
        app: { type: "string", minLength: 1 },
        context: { type: "string", minLength: 1 },
        slot: { type: "string", minLength: 1 },
      },
      required: ["request"],
      additionalProperties: false,
    },
    // Structurally rung 1 whichever way it routes: a jailed document render with
    // no server, host-tool execution, or egress. The lifecycle write is only to
    // Vendo's own app store, so consent policy treats it like opening a local
    // view — and Yousef's ruling (2026-07-28) says the same about a change: the
    // ceremony belongs on what a screen DOES (money, messages, deletion), never
    // on the person rearranging their own view. Actions INSIDE the screen are
    // guarded individually at call time. The recorded history is the audit trail.
    risk: "read",
  },
  {
    name: "vendo_apps_rebase_pin",
    description: "Rebase one drifted remixed pin of a Vendo app onto the host's updated component: re-fork the new captured baseline and replay the recorded edit intents in order. Use when an edit result or open() payload reports drifted pins and the user asks to update the remix. If the result has status \"failed\", nothing was changed; it lists which intents replayed and which failed.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        slot: { type: "string", minLength: 1 },
      },
      required: ["appId", "slot"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "vendo_apps_open",
    description: "Open the latest serving surface for a Vendo app. `appId` is the app's id, or its name exactly as the user said it, resolved against their own apps (if two share that name you are told both, so ask which one they mean).",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: {
          type: "string",
          minLength: 1,
          description: "The app's id, or its name as the user says it.",
        },
      },
      required: ["appId"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: VENDO_APPS_PIN_TOOL,
    description: "Put one of the user's own apps into a named slot on the page they are looking at, where it stays until they move it. `app` is the app's id, or its name exactly as the user said it, resolved against their own apps (if two share that name you are told both, so ask which one they mean). `slot` is a slot id the host published for that place on the page — pass one you were told rather than one you invented. Whatever held that slot is replaced, and the reply names it as `evicted` so you can say what moved.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        app: {
          type: "string",
          minLength: 1,
          description: "The app's id, or its name as the user says it.",
        },
        slot: {
          type: "string",
          minLength: 1,
          description: "The slot id the host published for that place on the page.",
        },
      },
      required: ["app", "slot"],
      additionalProperties: false,
    },
    // A `write`, and only a write: one small row saying where an app the user
    // already owns sits on their own page. It is reversible by the tool below,
    // and history is the safety net. What keeps it away from an unattended run
    // is `PRESENCE_ONLY_TOOLS`, not an inflated grade.
    risk: "write",
  },
  {
    name: VENDO_APPS_UNPIN_TOOL,
    description: "Take an app back out of a slot on the user's page. The app itself is untouched — it stays in their apps and can be put back any time. `app` is the app's id or its name as the user said it; `slot` is the slot it is in.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        app: {
          type: "string",
          minLength: 1,
          description: "The app's id, or its name as the user says it.",
        },
        slot: {
          type: "string",
          minLength: 1,
          description: "The slot the app is in.",
        },
      },
      required: ["app", "slot"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "vendo_apps_data_list",
    description: "List records from a declared Vendo app data collection.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        collection: { type: "string", minLength: 1 },
        refs: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
        limit: { type: "integer", minimum: 1 },
        cursor: { type: "string", minLength: 1 },
      },
      required: ["appId", "collection"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "vendo_apps_data_put",
    description: "Create or replace a record in a declared Vendo app data collection.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        collection: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
        data: {},
        refs: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
      },
      required: ["appId", "collection", "id", "data"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "vendo_apps_data_delete",
    description: "Delete a record from a declared Vendo app data collection.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        collection: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
      required: ["appId", "collection", "id"],
      additionalProperties: false,
    },
    risk: "write",
  },
] satisfies ToolDescriptor[];

export const agentToolDescriptors: ToolDescriptor[] = descriptors.map((descriptor) => {
  // Deliberately NOT `?? descriptor.name`: a silent fallback to the identifier is
  // the defect itself. A tool missing from the table stays titleless and
  // `agent-tools.test.ts` fails, which is the loud outcome.
  const title = VENDO_TOOL_TITLES[descriptor.name];
  return title === undefined ? descriptor : { ...descriptor, title };
});

export interface AgentToolsDataDependencies {
  data: AppDataAccess;
  requireOwned(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  /** B1 — claim the slot for an id this door just minted, before either engine
   *  runs. `AppsRuntime.place` cannot: it gates on an app record, and there is
   *  none yet. Filled by the runtime that constructs this registry. */
  claimSlot(appId: AppId, slot: string, ctx: RunContext): Promise<void>;
  /** B1's other end — the terminal record for an id assembly never landed, so a
   *  claimed slot reads as the honest failure card instead of a skeleton that
   *  ages out. The same tombstone a failed build leaves. */
  markUnbuilt(appId: AppId, name: string, reason: string, ctx: RunContext): Promise<void>;
  /** UI-generation blueprint §1 point 2 — the screen agent. Threaded from
   *  `AppsConfig.screen`, which composition fills; see the routing block in the
   *  `vendo_make` handler below. Unfilled, `vendo_make` has nothing to assemble
   *  with and says so. */
  screen?: ScreenAssembler;
  /** §4.5's other half — the escalated `plan.vendo`, read back out of the app's
   *  workspace so the build anchors on it. Threaded from
   *  `AppsConfig.escalatedPlan`; see that slot for why it is composition's. */
  escalatedPlan?: (appId: AppId, ctx: RunContext) => Promise<string | undefined>;
}

/**
 * Build contract §9.4 + the consumer voice law (design §3) — `forbidden` is
 * thrown for exactly one situation, and it is an ANSWERABLE one: the caller
 * provably sees the app and may not change it. The runtime's sentence names the
 * level and the app id ("editor access is required for app_7c2f…") because a
 * host developer reads it in a log; the MODEL relays what it is handed to a
 * person, so what it is handed here is the fork offer the level vocabulary
 * exists to make possible. The code is untouched: machines match on the code,
 * people read the message.
 */
// Deliberately DIRECTS rather than promises: there is no fork tool in this
// registry (make · rebase_pin · open · data_*), so a message saying "I
// will make you one" would have the model claim a capability it does not have.
const FORK_OFFER = "I can’t change the team’s copy of this app. Say so plainly, and offer them"
  + " their own copy instead — forking the app from its card gives them one I can change freely.";

const errorOutcome = (error: unknown): ToolOutcome => {
  if (error instanceof VendoError) {
    return {
      status: "error",
      error: {
        code: error.code,
        message: error.code === "forbidden" ? FORK_OFFER : error.message,
      },
    };
  }
  return {
    status: "error",
    error: { code: "internal", message: error instanceof Error ? error.message : "unknown apps error" },
  };
};

/** 06-apps §§1,5 — unbound Vendo app capabilities; the umbrella binds this registry. */
export const createAgentTools = (
  runtime: AppsRuntime,
  dependencies: AgentToolsDataDependencies,
): ToolRegistry => ({
  async descriptors() {
    return structuredClone(agentToolDescriptors);
  },
  async execute(call, ctx: RunContext): Promise<ToolOutcome> {
    try {
      if (call.tool === VENDO_MAKE_TOOL) {
        return await runMakeTool(runtime, dependencies, call, ctx);
      }
      if (call.tool === "vendo_apps_rebase_pin") {
        const args = input(call.args, ["appId", "slot"]);
        const result = await runtime.pins.rebase({
          appId: args.appId as string,
          slot: args.slot as string,
        }, ctx);
        return { status: "ok", output: result as unknown as Json };
      }
      if (call.tool === "vendo_apps_open") {
        const args = input(call.args, ["appId"]);
        // The same aim as `vendo_make`'s `app`, because this is the door a model
        // holding only a name reaches for FIRST — and it used to answer
        // "no such app" while that app sat in the caller's own list.
        const appId = await resolveAppRef(runtime, args.appId as string, ctx);
        return { status: "ok", output: await runtime.open(appId, ctx) as unknown as Json };
      }
      if (call.tool === VENDO_APPS_PIN_TOOL) {
        const args = input(call.args, ["app", "slot"]);
        const appId = await resolveAppRef(runtime, args.app as string, ctx);
        const slot = args.slot as string;
        const { evicted } = await runtime.place({ app: appId, slot }, ctx);
        return {
          status: "ok",
          output: { app: appId, slot, ...(evicted === undefined ? {} : { evicted }) },
        };
      }
      if (call.tool === VENDO_APPS_UNPIN_TOOL) {
        const args = input(call.args, ["app", "slot"]);
        const appId = await resolveAppRef(runtime, args.app as string, ctx);
        const slot = args.slot as string;
        await runtime.unplace({ app: appId, slot }, ctx);
        return { status: "ok", output: { app: appId, slot } };
      }
      if (call.tool === "vendo_apps_data_list") {
        return await listAppData(dependencies, call, ctx);
      }
      if (call.tool === "vendo_apps_data_put") {
        return await putAppData(dependencies, call, ctx);
      }
      if (call.tool === "vendo_apps_data_delete") {
        return await deleteAppData(dependencies, call, ctx);
      }
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});
