import { z } from "zod";
import { prewired } from "../../descriptor";

const option = z.object({ value: z.string(), label: z.string() });
const base = { name: z.string(), label: z.string(), required: z.boolean().optional(), placeholder: z.string().optional() };

export const formFieldSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), ...base }),
  z.object({ type: z.literal("number"), ...base }),
  z.object({ type: z.literal("textarea"), ...base }),
  z.object({ type: z.literal("select"), ...base, options: z.array(option) }),
  z.object({ type: z.literal("checkbox"), ...base }),
  z.object({ type: z.literal("radio"), ...base, options: z.array(option) }),
  z.object({ type: z.literal("switch"), ...base }),
  z.object({ type: z.literal("toggle"), ...base, options: z.array(option) }),
  z.object({ type: z.literal("slider"), ...base, min: z.number().optional(), max: z.number().optional() }),
  z.object({ type: z.literal("date"), ...base }),
]);

export const formSchema = z.object({
  title: z.string().optional(),
  submitLabel: z.string(),
  fields: z.array(formFieldSchema).min(1),
});

export const formDescriptor = prewired(
  "Form",
  "A form describing input fields (text, number, textarea, select, checkbox, radio, switch, toggle, slider, date). Renders the inputs for display; submission is not wired in this version. Use to lay out data the user would enter.",
  formSchema,
);
