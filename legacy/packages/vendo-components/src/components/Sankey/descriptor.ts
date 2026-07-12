import { z } from "zod";
import { prewired } from "../../descriptor.js";

const nodeSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
});

const linkSchema = z.object({
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  value: z.number().positive(),
});

export const sankeySchema = z
  .object({
    title: z.string().optional(),
    nodes: z.array(nodeSchema).min(2).max(80),
    links: z.array(linkSchema).min(1).max(200),
  })
  .superRefine((props, ctx) => {
    const nodeIds = new Set<string>();
    props.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Node ids must be unique",
          path: ["nodes", index, "id"],
        });
      }
      nodeIds.add(node.id);
    });

    props.links.forEach((link, index) => {
      if (!nodeIds.has(link.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Link source must reference a node id",
          path: ["links", index, "source"],
        });
      }
      if (!nodeIds.has(link.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Link target must reference a node id",
          path: ["links", index, "target"],
        });
      }
    });
  });

export const sankeyDescriptor = prewired(
  "Sankey",
  "A Sankey / flow diagram showing how value moves from source nodes to target nodes. " +
    "Use for 'where does my money go', income-to-spending or savings breakdowns, cash-flow " +
    "views, and flow/funnel questions. `nodes` define stable ids and labels; `links` reference " +
    "node ids and `value` controls each curved band's thickness.",
  sankeySchema,
);
