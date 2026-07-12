import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { Judge } from "./types.js";

const judgeDecisionSchema = z.object({
  action: z.enum(["run", "ask", "block"]),
  rationale: z.string(),
});

const SAFETY_PREAMBLE = [
  "You are Vendo Auto, a safety judge for tool calls.",
  "Choose run only when the call is appropriate for the user and context.",
  "Choose ask when user confirmation is warranted, and block when the call must not proceed.",
  "Return a concise rationale grounded in the supplied call, context, directions, and recent activity.",
].join("\n");

export function vendoAutoJudge(config: {
  model: LanguageModel;
  instructions?: string;
}): Judge {
  return {
    async decide(input) {
      const system = [
        SAFETY_PREAMBLE,
        config.instructions,
        input.directions.length > 0
          ? `Company directions:\n${input.directions.map((item) => `- ${item}`).join("\n")}`
          : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");

      const prompt = JSON.stringify({
        tool: {
          name: input.descriptor.name,
          description: input.descriptor.description,
          risk: input.descriptor.risk,
          critical: input.descriptor.critical,
        },
        call: {
          tool: input.call.tool,
          args: input.call.args,
        },
        ctx: {
          venue: input.ctx.venue,
          presence: input.ctx.presence,
          appId: input.ctx.appId,
        },
        recent: input.recent.map((event) => ({
          at: event.at,
          kind: event.kind,
          tool: event.tool,
          outcome: event.outcome,
          decidedBy: event.decidedBy,
        })),
      });

      const result = await generateObject({
        model: config.model,
        schema: judgeDecisionSchema,
        system,
        prompt,
      });
      return result.object;
    },
  };
}
