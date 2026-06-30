import { tool } from "ai";
import type { UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { FlowletUIMessage, UINode, UINodeSource } from "@flowlet/core";

/** Writer typed for Flowlet's custom UIMessage shape. */
type FlowletWriter = UIMessageStreamWriter<FlowletUIMessage>;

/**
 * Creates the `render_ui` tool for use in a Flowlet agent's `streamText` call.
 * When executed, the tool builds a `ComponentNode`, writes it as a `data-ui`
 * part to the stream, and returns `"rendered"`.
 *
 * @param writer - The `createUIMessageStream` writer bound to the current run.
 */
export function createRenderTool(writer: FlowletWriter) {
  let counter = 0;

  return tool({
    description:
      "Renders a UI component node in the Flowlet surface. Call this to display a named component from the prewired or host registry with the given props.",
    inputSchema: z.object({
      name: z.string().describe("The component name as registered in the Flowlet component registry."),
      props: z.unknown().optional().describe("Props to pass to the component."),
      id: z.string().optional().describe("Optional explicit node id. Auto-generated if omitted."),
      source: z
        .enum(["prewired", "host"])
        .optional()
        .describe("Component registry source. Defaults to 'prewired'."),
    }),
    execute: async ({ name, props, id, source }) => {
      const nodeId = id ?? `ui-${name}-${++counter}`;
      const node: UINode = {
        id: nodeId,
        kind: "component",
        source: (source ?? "prewired") as UINodeSource,
        name,
        props: props ?? {},
      };
      writer.write({ type: "data-ui", id: node.id, data: node });
      return "rendered";
    },
  });
}
