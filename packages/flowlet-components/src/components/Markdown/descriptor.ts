import { z } from "zod";
import { prewired } from "../../descriptor";

export const markdownSchema = z.object({
  content: z.string(),
});

export const markdownDescriptor = prewired(
  "Markdown",
  "A block of Markdown-formatted rich text (headings, lists, links, emphasis). Use for explanatory prose or formatted content.",
  markdownSchema,
);
