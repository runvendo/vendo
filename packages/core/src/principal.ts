import { z } from "zod";

/** 01-core §2 */
export interface Principal {
  kind: "user";
  subject: string;
  display?: string;
  ephemeral?: boolean;
}

/** 01-core §2 */
export const principalSchema = z.object({
  kind: z.literal("user"),
  subject: z.string(),
  display: z.string().optional(),
  ephemeral: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<Principal>;
