import { describe, expect, it } from "vitest";
import { TOOL_NAME_PATTERN, toolDescriptorSchema } from "@vendoai/core";
import { composioConnector } from "./composio.js";

const apiKey = process.env.COMPOSIO_API_KEY;

// Live connector smoke — descriptor listing only (execution needs a connected
// account and has real side effects). CI runs the deterministic stub suite;
// this runs once wherever COMPOSIO_API_KEY is provided.
describe.skipIf(!apiKey)("composioConnector live (COMPOSIO_API_KEY-gated)", () => {
  it("lists real gmail descriptors through the frozen descriptor shape", async () => {
    const connector = composioConnector({ apiKey: apiKey!, apps: ["gmail"] });
    const descriptors = await connector.descriptors();
    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      expect(toolDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(descriptor.name).toMatch(TOOL_NAME_PATTERN);
      expect(descriptor.risk).toBe("write"); // no reliable Composio risk annotation → conservative default
    }
  }, 60_000);
});
