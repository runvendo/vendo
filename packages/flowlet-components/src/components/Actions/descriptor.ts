import { z } from "zod";
import { prewired } from "../../descriptor";

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const actionsSchema = z.object({
  actions: z
    .array(
      z.object({
        label: z.string().min(1),
        /** The tool/action name dispatched through the governed action bridge. */
        action: z.string().min(1),
        payload: z.record(z.string(), jsonPrimitive).optional(),
        variant: z.enum(["primary", "secondary", "danger"]).optional(),
      }),
    )
    .min(1)
    .max(4),
});

export const actionsDescriptor = prewired(
  "Actions",
  "A row of action buttons wired to the app's governed action bridge — clicking " +
    "dispatches { action, payload } and dangerous actions pause for user approval " +
    "automatically. Use to make a view actionable (freeze card, pay bill, view all); " +
    "use variant danger for destructive actions. " +
    "Only reference action names you know exist as tools.",
  actionsSchema,
);
