import {
  VENDO_APPS_PIN_TOOL,
  VENDO_APPS_UNPIN_TOOL,
  VENDO_AUTOMATE_TOOL,
  VENDO_MAKE_TOOL,
  VENDO_SLOTS_LIST_TOOL,
  VENDO_TOOL_TITLES,
  isVendoError,
  type AppId,
  type Json,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
  type ScreenAssembler,
} from "../../contract/index.js";
import type { AppDataAccess } from "../persistence/app-data.js";
import { runAutomateTool } from "./automate-tool.js";
import { deleteAppData, listAppData, putAppData } from "./data-tools.js";
import { runMakeTool } from "./make-tool.js";
import { input, resolveAppRef } from "./tool-args.js";
import type { AppsRuntime, AutomationsSeam } from "../runtime/types.js";

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
    description: "Make the user something to look at — a screen, or a full app — from a plain-language request. Say what they want in your own words; Vendo decides whether to assemble a screen or build an app, and it arrives on the user's own page. Pass `app` only to change one specific existing app — its id, or its name exactly as the user said it, which is resolved against their own apps (if two share that name you are told both, so ask which one); leave it out and Vendo decides whether to continue the last one or start something new. When the SAME request also asks for something to happen on a schedule (\"build me the board and refresh it every Monday\"), say both halves here and the schedule is armed alongside the app; a schedule with nothing to build belongs in vendo_automate instead. One app can hold SEVERAL automations, so to add another one to an app it already has, name that app in `app` and describe the new schedule — never refuse a second schedule. Never bake data values you computed or fetched (counts, totals, amounts) into the request — it binds live host data itself and hardcoded figures fail its checks. Never specify fonts, colors, or branding — it inherits the host theme. You get back a one-line receipt to say out loud, never the screen itself; if the receipt says \"failed\", try once more on the same `app` with a narrower request rather than rebuilding it, and if it says \"partial\" the screen is on their page but the server-side part of it is not — say the line and offer to try that part again, never rebuild it. Pass `slot` only when the request names a particular place on the user's page for it to land — the host publishes those slot ids, so pass one you were told rather than one you invented, and whatever held that place is replaced. `slot` is for something NEW: to move an app that already exists, use the pin tool instead.",
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
    name: VENDO_AUTOMATE_TOOL,
    description: "Arm something to run on its own, on a schedule or on an event — \"pay my rent on the 1st\", \"every morning check the overnight orders and flag anything odd\". `task` is the whole job in plain language, written for someone who will read only that sentence and the tools they hold: the user is not there when it runs. `when` is either a 5-field cron string (UTC unless you pass `timezone`) or one of {\"every\":\"1d\"}, {\"at\":\"<ISO date-time>\"}, {\"event\":\"<host event name>\"}, {\"webhook\":\"<connector>\"} — plain English like \"every monday\" is refused, so write the cron. The automation runs as the user, with only what they have allowed; the reply says whether it is armed, when it next runs, and how many permissions are still outstanding. Use this when there is nothing to build. If the same request ALSO asks for a screen or an app, use vendo_make and describe both halves there — it arms the schedule as part of that call, and calling both would arm it twice.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        when: {
          description: "A 5-field cron string, or one of {every}, {at}, {event}, {webhook}.",
          oneOf: [
            { type: "string", minLength: 1 },
            {
              type: "object",
              properties: {
                every: { type: "string", minLength: 1 },
                at: { type: "string", minLength: 1 },
                event: { type: "string", minLength: 1 },
                webhook: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
          ],
        },
        task: {
          type: "string",
          minLength: 1,
          description: "What to do on every firing, in plain language.",
        },
        agent: {
          type: "string",
          minLength: 1,
          description: "The named agent to run it. Omit for the deployment's own agent.",
        },
        timezone: { type: "string", minLength: 1 },
      },
      required: ["when", "task"],
      additionalProperties: false,
    },
    // Arming future unattended behaviour is a write (build contract §8's lane-D
    // ratification), and only a write: the automation itself is guarded call by
    // call at fire time, against what its owner has actually allowed.
    risk: "write",
  },
  {
    name: "vendo_apps_reseed",
    description: "Update a Vendo app that was created from a host component so it uses the host's current version of that component. WARNING, tell the user first: this REPLACES the component with the fresh copy, so any changes they made to it are lost. Use only when the app reports seed drift and the user has said they want the update.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
      },
      required: ["appId"],
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
    name: VENDO_SLOTS_LIST_TOOL,
    // The answer to the one question the two `slot` arguments below cannot ask
    // for themselves. A model with no way to see the real slot ids guesses one,
    // and a guessed id is a placement aimed at a spot no page renders: the row
    // is written, nothing ever shows it, and the user is told their view landed.
    description: "List the places on the user's page where a generated view can go. Each entry has an `id`, a `label` the user would recognize, and a `description` of what that place is for. Pass an `id` from this list to `vendo_make`'s `slot` or to `vendo_apps_pin`'s `slot`, and never invent one: an id that is not here belongs to no page, so nothing would ever appear there. An empty list means the page the user is on offers no place to put a view, so make the view without a slot.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {},
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
  /** `AppsConfig.automations` — what `vendo_automate` arms through, and what
   *  `vendo_make`'s compound ask reaches the same create operation by. Unfilled,
   *  both say so rather than pretending something runs. */
  automations?: AutomationsSeam;
}

/**
 * Build contract §9.4 + the consumer voice law (design §3) — `forbidden` is
 * thrown for exactly one situation, and it is an ANSWERABLE one: the caller
 * provably sees the app and may not change it. The runtime's sentence names the
 * level and the app id ("editor access is required for app_7c2f…") because a host
 * developer reads it in a log; the MODEL relays what it is handed to a person, so
 * what it is handed here is the same situation in facts. The code is untouched:
 * machines match on the code, people read the message.
 *
 * FACTS, not a script. This used to be a first-person sentence with stage
 * directions ("I can't change the team's copy… say so plainly, and offer them…"),
 * which put our words in the model's mouth and told it how to talk instead of what
 * had happened. The three facts are: the change did not happen, why it cannot, and
 * that a copy of their own is the way through — including who can make one, so a
 * model reading this cannot promise a fork it has no tool for (this registry is
 * make · automate · reseed · open · pin · data_*).
 */
const FORBIDDEN_FACTS = "The change was not made: this is the team's copy of the app and this user has "
  + "read-only access to it. A copy of their own would be theirs to change — they fork it from the app's "
  + "card themselves, and there is no fork tool here.";

const errorOutcome = (error: unknown): ToolOutcome => {
  if (isVendoError(error)) {
    return {
      status: "error",
      error: {
        code: error.code,
        message: error.code === "forbidden" ? FORBIDDEN_FACTS : error.message,
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
      if (call.tool === VENDO_AUTOMATE_TOOL) {
        return await runAutomateTool(dependencies.automations, call, ctx);
      }
      if (call.tool === "vendo_apps_reseed") {
        const args = input(call.args, ["appId"]);
        const result = await runtime.seed.reseed({ appId: args.appId as string }, ctx);
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
      if (call.tool === VENDO_SLOTS_LIST_TOOL) {
        const slots = await runtime.slots.list(ctx);
        return {
          status: "ok",
          output: slots.map(({ id, label, description }) =>
            ({ id, label, ...(description === undefined ? {} : { description }) })),
        };
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
