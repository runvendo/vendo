import { z } from "zod";
import { prewired } from "../../descriptor";

export const stepsSchema = z.object({
  steps: z.array(z.object({ title: z.string().optional(), text: z.string() })).min(1),
});

export const stepsDescriptor = prewired(
  "Steps",
  "An ordered list of steps/instructions. Use for how-to sequences or progress through a process.",
  stepsSchema,
);
