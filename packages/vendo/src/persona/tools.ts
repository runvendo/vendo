import {
  VendoError,
  type Json,
  type RunContext,
  type StoreAdapter,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { personaFactKindSchema } from "./types.js";
import { loadPersona, rememberFact } from "./store.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const FACT_KINDS = [...personaFactKindSchema.options];

const descriptors: ToolDescriptor[] = [
  {
    name: "vendo_persona_load",
    description:
      "Load the current user's persona: a short model of how they work, the formats and tools they prefer, their recurring intents, and durable facts they have stated. Call this at the start of a turn and let it shape how you answer. Returns null when the user has no persona yet.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    // Reads the caller's own record, so it runs silently under every policy.
    risk: "read",
  },
  {
    name: "vendo_persona_remember",
    description:
      "Record one durable fact about the current user for future sessions. Use only for stable preferences or recurring patterns (how they like output formatted, the domains and tools they keep returning to, standing instructions, how much they want to be asked before a write), never one-off details from this turn.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        kind: { type: "string", enum: FACT_KINDS },
        text: { type: "string", minLength: 1 },
        evidence: { type: "string", minLength: 1 },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    },
    // Writes the user's own self-data, not a host resource. Auto-runs in the
    // default composition; a host with a strict write policy can gate it by name.
    risk: "write",
  },
];

const asObject = (value: Json): Record<string, Json> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "tool input must be an object");
  }
  return value as Record<string, Json>;
};

const errorOutcome = (error: unknown): ToolOutcome => ({
  status: "error",
  error:
    error instanceof VendoError
      ? { code: error.code, message: error.message }
      : { code: "internal", message: error instanceof Error ? error.message : "unknown persona error" },
});

/** The persona capability tools, mirroring apps' `createAgentTools`: an unbound
 *  ToolRegistry the umbrella folds into `actions` and guard binds. Handlers key
 *  every read and write on `ctx.principal.subject`, so a caller can only ever
 *  touch its own persona. */
export const createPersonaTools = (store: StoreAdapter): ToolRegistry => ({
  async descriptors() {
    return structuredClone(descriptors);
  },
  async execute(call, ctx: RunContext): Promise<ToolOutcome> {
    try {
      const subject = ctx.principal.subject;

      if (call.tool === "vendo_persona_load") {
        asObject(call.args);
        const persona = await loadPersona(store, subject);
        return { status: "ok", output: persona as unknown as Json };
      }

      if (call.tool === "vendo_persona_remember") {
        const args = asObject(call.args);
        const kind = personaFactKindSchema.safeParse(args.kind);
        if (!kind.success) {
          throw new VendoError("validation", `kind must be one of: ${FACT_KINDS.join(", ")}`);
        }
        if (typeof args.text !== "string" || args.text.trim() === "") {
          throw new VendoError("validation", "text must be a non-empty string");
        }
        if (
          args.evidence !== undefined &&
          (typeof args.evidence !== "string" || args.evidence.trim() === "")
        ) {
          throw new VendoError("validation", "evidence must be a non-empty string when provided");
        }
        const persona = await rememberFact(store, subject, {
          kind: kind.data,
          text: args.text.trim(),
          ...(args.evidence === undefined ? {} : { evidence: (args.evidence as string).trim() }),
        });
        return {
          status: "ok",
          output: { remembered: true, facts: persona.facts.length } as unknown as Json,
        };
      }

      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});
