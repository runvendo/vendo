import { z } from "zod";
import { prewired } from "../../descriptor.js";

export const codeBlockSchema = z.object({
  code: z.string(),
  language: z.string().optional(),
});

export const codeBlockDescriptor = prewired(
  "CodeBlock",
  "A syntax-highlighted block of source code with an optional language. Use to show code snippets or commands.",
  codeBlockSchema,
);
