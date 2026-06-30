import { z } from "zod";
import { prewired } from "../../descriptor";

export const calloutSchema = z.object({
  variant: z.enum(["info", "success", "warning", "danger"]),
  title: z.string().optional(),
  text: z.string(),
});

export const calloutDescriptor = prewired(
  "Callout",
  "A highlighted message box in an info, success, warning, or danger style. Use to draw attention to a status, tip, or alert.",
  calloutSchema,
);
