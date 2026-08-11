/**
 * `vendo_apps_data_list` · `_put` · `_delete` — the agent's reach into a
 * declared app data collection, over the same `requireOwned` gate every other
 * door reads.
 *
 * Lifted out of `createAgentTools` unchanged. Every row is owned by the LIVE
 * caller: the subject comes off the run context, never off the tool args, so
 * generated code has no way to name someone else's drawer.
 */
import {
  VendoError,
  type Json,
  type RecordQuery,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
} from "@vendoai/core";
import type { AgentToolsDataDependencies } from "./agent-tools.js";
import { input, optionalLimit, optionalRefs } from "./tool-args.js";

export const listAppData = async (
  dependencies: AgentToolsDataDependencies,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> => {
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
    output: await dependencies.data
      .records(app, args.collection as string, ctx.principal.subject)
      .list(query) as unknown as Json,
  };
};

export const putAppData = async (
  dependencies: AgentToolsDataDependencies,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> => {
  const args = input(call.args, ["appId", "collection", "id"], ["data", "refs"]);
  if (!Object.prototype.hasOwnProperty.call(args, "data") || args.data === undefined) {
    throw new VendoError("validation", "data is required");
  }
  const app = await dependencies.requireOwned(args.appId as string, ctx);
  const refs = optionalRefs(args.refs);
  const record = await dependencies.data
    .records(app, args.collection as string, ctx.principal.subject)
    .put({
      id: args.id as string,
      data: args.data,
      ...(refs === undefined ? {} : { refs }),
    });
  return { status: "ok", output: record as unknown as Json };
};

export const deleteAppData = async (
  dependencies: AgentToolsDataDependencies,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> => {
  const args = input(call.args, ["appId", "collection", "id"]);
  const app = await dependencies.requireOwned(args.appId as string, ctx);
  await dependencies.data
    .records(app, args.collection as string, ctx.principal.subject)
    .delete(args.id as string);
  return { status: "ok", output: { status: "ok" } };
};
