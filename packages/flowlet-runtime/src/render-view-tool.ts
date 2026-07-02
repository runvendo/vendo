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

const dataQuerySchema = z.object({
  path: z.string().describe("JSON Pointer into `data` where this tool's result lives ('' = the whole model)."),
  tool: z.string().describe("Name of the tool whose call produced the data at `path`."),
  input: z.record(z.string(), z.unknown()).optional()
    .describe("The exact input to replay the tool with on refresh."),
});

export function createRenderViewTool(writer: FlowletWriter) {
  // Node ids key saved flowlets (ENG-183), and a tool instance lives for ONE
  // request — a bare counter would make every session's first view "view-1".
  // The random suffix keeps ids unique across instances.
  let counter = 0;
  const mintId = () => `view-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

  return tool({
    description:
      "Renders a composed Flowlet view: a tree of prewired primitives, catalog components, and " +
      "optional novel components you define as code. Use for multi-component layouts, data-bound " +
      "views, or UI the catalog cannot express. Generated component code is ESM. You MAY write " +
      "JSX/TSX — it is compiled automatically (automatic React runtime, TS types stripped), so you " +
      "do NOT need to import React. Example: `export default function MyComp(props) { return <div>{props.label}</div>; }`. " +
      "Plain `React.createElement` also works. It runs in a network-jailed sandbox; to perform an app " +
      "action call `props.flowlet.dispatch({ action, payload })`. " +
      "BRAND: style novel components with the host's injected CSS variables — var(--flowlet-accent), " +
      "var(--flowlet-surface), var(--flowlet-fg), var(--flowlet-fg-muted), var(--flowlet-border), " +
      "var(--flowlet-radius) — never a hardcoded palette, never gradients; typography is inherited " +
      "(do not set font families). Catalog components are pre-themed; prefer them.",
    inputSchema: z.object({
      formatVersion: z.literal("flowlet-genui/v1"),
      root: z.string().describe("Id of the root node."),
      nodes: z.array(genNodeSchema),
      data: z.record(z.string(), z.unknown()).optional()
        .describe("Data model for { $path } prop bindings."),
      components: z.record(z.string(), z.string()).optional()
        .describe("PascalCase name → ESM source for novel components (max 16, 64KB each)."),
      queries: z.array(dataQuerySchema).optional()
        .describe("Provenance of `data` for refreshable views: which policy-governed tool calls produced it. " +
          "Place each tool's result VERBATIM at its `path` in `data` (transform inside generated components, " +
          "not between tool and data). Reopening a saved view re-runs these to fetch fresh data."),
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
        id: mintId(),
        kind: "generated",
        payload: shipped,
      };
      writer.write({ type: "data-ui", id: node.id, data: node });
      return "rendered";
    },
  });
}
