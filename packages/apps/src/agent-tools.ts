import {
  VendoError,
  type Json,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { AppsRuntime } from "./runtime.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const descriptors: ToolDescriptor[] = [
  {
    name: "vendo_apps_create",
    description: "Create a Vendo app from a natural-language prompt.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: { prompt: { type: "string", minLength: 1 } },
      required: ["prompt"],
      additionalProperties: false,
    },
    risk: "write",
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
];

const input = (
  value: Json,
  required: string[],
): Record<string, Json> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "tool input must be an object");
  }
  const record = value as Record<string, Json>;
  const allowed = new Set(required);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new VendoError("validation", `unexpected input property: ${unexpected}`);
  for (const key of required) {
    if (typeof record[key] !== "string" || (record[key] as string).trim() === "") {
      throw new VendoError("validation", `${key} must be a non-empty string`);
    }
  }
  return record;
};

const errorOutcome = (error: unknown): ToolOutcome => ({
  status: "error",
  error: error instanceof VendoError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : "unknown apps error" },
});

/** 06-apps §§1,5 — unbound Vendo app capabilities; the umbrella binds this registry. */
export const createAgentTools = (runtime: AppsRuntime): ToolRegistry => ({
  async descriptors() {
    return structuredClone(descriptors);
  },
  async execute(call, ctx: RunContext): Promise<ToolOutcome> {
    try {
      if (call.tool === "vendo_apps_create") {
        const args = input(call.args, ["prompt"]);
        const app = await runtime.create({ prompt: args.prompt as string }, ctx);
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
          } as unknown as Json,
        };
      }
      if (call.tool === "vendo_apps_open") {
        const args = input(call.args, ["appId"]);
        return { status: "ok", output: await runtime.open(args.appId as string, ctx) as unknown as Json };
      }
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});
