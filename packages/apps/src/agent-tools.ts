import {
  VENDO_MAKE_TOOL,
  VENDO_TOOL_TITLES,
  VENDO_VIEW_STREAM,
  VendoError,
  makeReceiptSchema,
  vendoViewStreamId,
  type AppDocument,
  type AppId,
  type Json,
  type MakeReceipt,
  type RecordQuery,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import type { AppDataAccess } from "./app-data.js";
import type { AppsRuntime } from "./runtime.js";

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
    description: "Make the user something to look at — a screen, or a full app — from a plain-language request. Say what they want in your own words; Vendo decides whether to assemble a screen or build an app, and it arrives on the user's own page. Pass `app` only to change one specific existing app; leave it out and Vendo decides whether to continue the last one or start something new. A recurring or scheduled task belongs here too: describe the schedule and the action in the request and it is armed as part of the same call; there is no separate automations tool. Never bake data values you computed or fetched (counts, totals, amounts) into the request — it binds live host data itself and hardcoded figures fail its checks. Never specify fonts, colors, or branding — it inherits the host theme. You get back a one-line receipt to say out loud, never the screen itself; if the receipt says \"failed\", try once more on the same `app` with a narrower request rather than rebuilding it.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        request: { type: "string", minLength: 1 },
        app: { type: "string", minLength: 1 },
        context: { type: "string", minLength: 1 },
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
    // guarded individually at call time. History and undo are the safety net.
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
    description: "Open the latest serving surface for a Vendo app.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: { appId: { type: "string", minLength: 1 } },
      required: ["appId"],
      additionalProperties: false,
    },
    risk: "read",
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

const input = (
  value: Json,
  required: string[],
  optional: string[] = [],
): Record<string, Json> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "tool input must be an object");
  }
  const record = value as Record<string, Json>;
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new VendoError("validation", `unexpected input property: ${unexpected}`);
  for (const key of required) {
    if (typeof record[key] !== "string" || (record[key] as string).trim() === "") {
      throw new VendoError("validation", `${key} must be a non-empty string`);
    }
  }
  return record;
};

const optionalString = (value: Json | undefined, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new VendoError("validation", `${name} must be a non-empty string`);
  }
  return value;
};

/**
 * Contract §3.1 — the caller's `context` appended to the request, clearly
 * delimited.
 *
 * It exists for outside agents whose conversation we cannot see: over MCP there is
 * no transcript for us to attach, so they pass whatever background helps. On OUR
 * doors the runtime's own transcript stays authoritative and this is supplemental
 * — which is why it is appended rather than merged, and fenced rather than run
 * together with the ask. Free text, never a messages array: every framework's
 * message format differs and a string is universal.
 */
const withContext = (request: string, context: string | undefined): string =>
  context === undefined ? request : `${request}\n\n<context>\n${context}\n</context>`;

/** The tool's whole model-facing answer. Parsed, so the four-field law is enforced
 *  here rather than trusted — a document that leaked into `output` would fail. */
const receipt = (value: MakeReceipt): ToolOutcome => ({
  status: "ok",
  output: makeReceiptSchema.parse(value) as unknown as Json,
});

const optionalRefs = (value: Json | undefined): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "refs must be an object");
  }
  const refs: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "" || typeof item !== "string" || item.trim() === "") {
      throw new VendoError("validation", "refs must have non-empty string keys and values");
    }
    refs[key] = item;
  }
  return refs;
};

const optionalLimit = (value: Json | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new VendoError("validation", "limit must be a positive integer");
  }
  return value;
};

export interface AgentToolsDataDependencies {
  data: AppDataAccess;
  requireOwned(appId: AppId, ctx: RunContext): Promise<AppDocument>;
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
        const args = input(call.args, ["request"], ["app", "context"]);
        const app = optionalString(args.app, "app");
        const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
        const ask = withContext(args.request as string, optionalString(args.context, "context"));
        if (app === undefined) {
          let unsaved: string | undefined;
          const created = await runtime.create({
            prompt: ask,
            onUnsaved: (reason) => { unsaved = reason; },
            ...(stream === undefined ? {} : {
              onView: (part) => stream({ id: vendoViewStreamId(part.appId), part }),
            }),
          }, ctx);
          // View-only (the store refused the write): the screen IS on the user's
          // page, so this is a success with a caveat, not a failure. Reporting it
          // as an error made the agent apologize for a rendered view and rebuild
          // it twice more — three cards, one prompt (live 2026-07-27). The
          // caveat rides `say`, which is the whole point of `say`: one true
          // sentence, and nothing to react to.
          return receipt({
            id: created.id,
            title: created.name,
            status: "ready",
            say: unsaved === undefined
              ? `${created.name} is on your screen.`
              : `${created.name} is on your screen, though I couldn't save it to your apps.`,
          });
        }
        const result = await runtime.edit(app, ask, ctx);
        // Wave 9 — a ladder-authored automation raises its own card. Published
        // HERE, by the side that knows, rather than duck-typed out of this tool's
        // return value at the bridge: the receipt carries words only.
        if (result.automation !== undefined && stream !== undefined) {
          stream({
            id: `vendo-automation-${result.app.id}`,
            part: {
              type: "data-vendo-automation",
              appId: result.app.id,
              name: result.app.name,
              enabled: result.automation.enabled,
              ...(result.automation.trigger === undefined ? {} : { trigger: result.automation.trigger }),
              ...(result.app.description === undefined || result.app.description.length === 0
                ? {}
                : { description: result.app.description }),
              ...((result.automation.pendingGrants ?? []).length === 0
                ? {}
                : { pendingGrants: result.automation.pendingGrants!.length }),
            },
          });
        }
        return receipt({
          id: result.app.id,
          title: result.app.name,
          status: result.failure === undefined ? "ready" : "failed",
          say: result.failure === undefined
            ? `${result.app.name} is updated.`
            : `I couldn't make that change to ${result.app.name}.`,
        });
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
        return { status: "ok", output: await runtime.open(args.appId as string, ctx) as unknown as Json };
      }
      if (call.tool === "vendo_apps_data_list") {
        const args = input(call.args, ["appId", "collection"], ["refs", "limit", "cursor"]);
        const app = await dependencies.requireOwned(args.appId as string, ctx);
        const refs = optionalRefs(args.refs);
        const limit = optionalLimit(args.limit);
        if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.trim() === "")) {
          throw new VendoError("validation", "cursor must be a non-empty string");
        }
        const query: RecordQuery = {
          ...(refs === undefined ? {} : { refs }),
          ...(limit === undefined ? {} : { limit }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
        };
        return {
          status: "ok",
          output: await dependencies.data.records(app, args.collection as string).list(query) as unknown as Json,
        };
      }
      if (call.tool === "vendo_apps_data_put") {
        const args = input(call.args, ["appId", "collection", "id"], ["data", "refs"]);
        if (!Object.prototype.hasOwnProperty.call(args, "data") || args.data === undefined) {
          throw new VendoError("validation", "data is required");
        }
        const app = await dependencies.requireOwned(args.appId as string, ctx);
        const refs = optionalRefs(args.refs);
        const record = await dependencies.data.records(app, args.collection as string).put({
          id: args.id as string,
          data: args.data,
          ...(refs === undefined ? {} : { refs }),
        });
        return { status: "ok", output: record as unknown as Json };
      }
      if (call.tool === "vendo_apps_data_delete") {
        const args = input(call.args, ["appId", "collection", "id"]);
        const app = await dependencies.requireOwned(args.appId as string, ctx);
        await dependencies.data.records(app, args.collection as string).delete(args.id as string);
        return { status: "ok", output: { status: "ok" } };
      }
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});
