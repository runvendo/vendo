import { z } from "zod";
import { prewired } from "../../descriptor";

export const tabsSchema = z.object({
  tabs: z.array(z.object({ label: z.string(), content: z.string() })).min(1),
});

export const tabsDescriptor = prewired(
  "Tabs",
  "A tabbed panel; each tab has a label and text content. Use to organize alternative views in one surface.",
  tabsSchema,
);
