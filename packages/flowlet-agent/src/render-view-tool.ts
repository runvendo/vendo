/**
 * `render_view` — the Tier 2.5 composed-view tool. Where `render_ui` emits ONE
 * component node, `render_view` emits a whole GeneratedPayload: a tree meshing
 * prewired primitives, catalog components, and novel generated component code,
 * rendered in the egress-jailed stage. Validated server-side BEFORE streaming
 * so the model gets a correctable error instead of the user getting a broken node.
 */
import { tool } from "ai";
import type { UIMessageStreamWriter } from "ai";
import { z } from "zod";
import {
  validateGeneratedPayload,
  type FlowletUIMessage,
  type UINode,
} from "@flowlet/core";
import { compileComponentSource } from "./compile-component";

type FlowletWriter = UIMessageStreamWriter<FlowletUIMessage>;

const genNodeSchema = z.object({
  id: z.string().describe("Unique node id within this payload."),
  component: z.string().describe("Component name: a prewired primitive (Stack/Row/Grid/Text/Skeleton), a registered catalog component, or a key of `components`."),
  source: z.enum(["prewired", "host", "generated"]).optional()
    .describe("'prewired' (default) for primitives + catalog, 'generated' for a component defined in `components`."),
  props: z.record(z.string(), z.unknown()).optional()
    .describe("Props. A value of { $path: \"/json/pointer\" } binds to `data`."),
  children: z.array(z.string()).optional().describe("Child node ids."),
});

export function createRenderViewTool(writer: FlowletWriter) {
  let counter = 0;

  return tool({
    description:
      "Renders a composed Flowlet view: a tree of prewired primitives, catalog components, and " +
      "optional novel components you define as code. Use for multi-component layouts, data-bound " +
      "views, or UI the catalog cannot express. Generated component code is ESM. You MAY write " +
      "JSX/TSX — it is compiled automatically (automatic React runtime, TS types stripped), so you " +
      "do NOT need to import React. Example: `export default function MyComp(props) { return <div>{props.label}</div>; }`. " +
      "Plain `React.createElement` also works. It runs in a network-jailed sandbox; to perform an app " +
      "action call `props.flowlet.dispatch({ action, payload })`.",
    inputSchema: z.object({
      formatVersion: z.literal("flowlet-genui/v1"),
      root: z.string().describe("Id of the root node."),
      nodes: z.array(genNodeSchema),
      data: z.record(z.string(), z.unknown()).optional()
        .describe("Data model for { $path } prop bindings."),
      components: z.record(z.string(), z.string()).optional()
        .describe("PascalCase name → ESM source for novel components (max 16, 64KB each)."),
    }),
    execute: async (payload) => {
      const validation = validateGeneratedPayload(payload);
      if (!validation.ok) {
        return `render_view error (${validation.error.code}): ${validation.error.message}`;
      }
      // Validation ran on the ORIGINAL authored payload (name/cap checks apply
      // to what the model emitted). Compile each component's JSX/TS to plain ESM
      // before shipping — the sandbox has no transpiler.
      let shipped = validation.payload;
      if (validation.payload.components) {
        const compiled: Record<string, string> = {};
        for (const [name, src] of Object.entries(validation.payload.components)) {
          try {
            compiled[name] = compileComponentSource(src);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return `render_view error (compile): component "${name}": ${msg}`;
          }
        }
        shipped = { ...validation.payload, components: compiled };
      }
      const node: UINode = {
        id: `view-${++counter}`,
        kind: "generated",
        payload: shipped,
      };
      writer.write({ type: "data-ui", id: node.id, data: node });
      return "rendered";
    },
  });
}
