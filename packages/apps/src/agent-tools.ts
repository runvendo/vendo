import {
  VENDO_APPS_CREATE_TOOL,
  VENDO_VIEW_STREAM,
  VendoError,
  vendoViewStreamId,
  type AppDocument,
  type AppId,
  type Json,
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

const descriptors: ToolDescriptor[] = [
  {
    // The agent's streaming-view bridge keys on this exact core-defined name.
    name: VENDO_APPS_CREATE_TOOL,
    description: "Create a Vendo app from a natural-language prompt.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: { prompt: { type: "string", minLength: 1 } },
      required: ["prompt"],
      additionalProperties: false,
    },
    // Creation is structurally rung 1: a jailed document render with no server,
    // host-tool execution, or egress. The lifecycle write is only to Vendo's
    // own app store, so consent policy treats it like opening a local view.
    risk: "read",
  },
  {
    name: "vendo_apps_edit",
    description: "Edit an existing Vendo app with one natural-language instruction. If the result has failure.retryable=true, retry vendo_apps_edit on the same appId with a narrower instruction; do not rebuild it with vendo_apps_create.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1 },
      },
      required: ["appId", "instruction"],
      additionalProperties: false,
    },
    risk: "write",
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
];

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
  requireOwned(appId: AppId, subject: string): Promise<AppDocument>;
}

const errorOutcome = (error: unknown): ToolOutcome => ({
  status: "error",
  error: error instanceof VendoError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : "unknown apps error" },
});

/** 06-apps §§1,5 — unbound Vendo app capabilities; the umbrella binds this registry. */
export const createAgentTools = (
  runtime: AppsRuntime,
  dependencies: AgentToolsDataDependencies,
): ToolRegistry => ({
  async descriptors() {
    return structuredClone(descriptors);
  },
  async execute(call, ctx: RunContext): Promise<ToolOutcome> {
    try {
      if (call.tool === "vendo_apps_create") {
        const args = input(call.args, ["prompt"]);
        const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
        const app = await runtime.create({
          prompt: args.prompt as string,
          ...(stream === undefined ? {} : {
            onView: (part) => stream({ id: vendoViewStreamId(part.appId), part }),
          }),
        }, ctx);
        return { status: "ok", output: app as unknown as Json };
      }
      if (call.tool === "vendo_apps_edit") {
        const args = input(call.args, ["appId", "instruction"]);
        const result = await runtime.edit(args.appId as string, args.instruction as string, ctx);
        return {
          status: "ok",
          output: {
            app: result.app,
            ...(result.issues === undefined ? {} : { issues: result.issues }),
            ...(result.failure === undefined ? {} : { failure: result.failure }),
            ...(result.driftedPins === undefined ? {} : { driftedPins: result.driftedPins }),
            // Wave 9 — a ladder-authored automation (mode, trigger, pending
            // standing-grant approvals) so the agent can narrate what was set
            // up and which approvals are waiting.
            ...(result.automation === undefined ? {} : { automation: result.automation }),
          } as unknown as Json,
        };
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
        const app = await dependencies.requireOwned(args.appId as string, ctx.principal.subject);
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
        const app = await dependencies.requireOwned(args.appId as string, ctx.principal.subject);
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
        const app = await dependencies.requireOwned(args.appId as string, ctx.principal.subject);
        await dependencies.data.records(app, args.collection as string).delete(args.id as string);
        return { status: "ok", output: { status: "ok" } };
      }
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});
