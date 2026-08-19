/**
 * A tool written BY HAND, for the same `tools:` slot extraction fills — the
 * capability that has no route to read, and so no `.vendo/tools.json` entry.
 *
 * The zod schema is the one statement: it becomes the descriptor's
 * `inputSchema` (what the model is shown) and the parse that runs before
 * `execute` (what the model is held to), so those two can never disagree.
 * Nothing else is added — the result is a plain {@link ToolDefinition}, so
 * every descriptor field this helper does not ask for is still reachable by
 * spreading it: `{ ...defineTool({ … }), confirmEach: true }`.
 */
import { toJSONSchema } from "zod/v4/core";
// Types only: the runtime above is zod's shared core, so naming the classic v4
// surface costs a host nothing at load.
import type { z } from "zod/v4";
import type { ToolDefinition } from "./capability.js";
import { VendoError } from "./errors.js";
import type { Json } from "./ids.js";
import type { RunContext } from "./run-context.js";
import type { GradedRiskLabel } from "./tools.js";

/**
 * `risk` is required and GRADED: a hand-written tool's author knows what it
 * does, and `ungraded` is the answer only extraction is allowed to give.
 */
export function defineTool<Input extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: Input;
  risk: GradedRiskLabel;
  execute(input: z.infer<Input>, context: RunContext): Promise<Json>;
}): ToolDefinition {
  if (!("_zod" in tool.input)) {
    throw new VendoError(
      "validation",
      `defineTool("${tool.name}") was given a zod 3 schema. Vendo reads zod 4 schemas: import { z } from "zod/v4" if you are on zod 3.25+, or upgrade to zod 4.`,
    );
  }
  // `$schema` off, so a hand-written descriptor is byte-shaped like an
  // extracted one — the same bytes go on the wire and into the descriptor hash.
  const { $schema: _draft, ...inputSchema } = toJSONSchema(tool.input, { io: "input" });
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    risk: tool.risk,
    async execute(input, context) {
      // Async: a schema whose refinement awaits anything throws out of the sync
      // `safeParse` before it can produce a validation error. The wrapper is
      // already async, so the async parse costs a sync schema nothing.
      const parsed = await tool.input.safeParseAsync(input);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new VendoError("validation", `${tool.name} was called with arguments its input schema rejects — ${problems}`);
      }
      return tool.execute(parsed.data, context);
    },
  };
}
