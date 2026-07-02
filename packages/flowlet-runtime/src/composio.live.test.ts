/**
 * Live smoke test for the real Composio network path.
 *
 * SKIPPED by default. Only runs when BOTH environment variables are present:
 *   - COMPOSIO_API_KEY   (Composio dashboard key)
 *   - ANTHROPIC_API_KEY  (required for the full live-agent path; gated here for parity)
 *
 * To run:
 *   COMPOSIO_API_KEY=... ANTHROPIC_API_KEY=... pnpm -F @flowlet/runtime test
 *
 * Does NOT execute any tool — only fetches the tool manifest (read-only).
 */

import { describe, it, expect } from "vitest";
import { createComposioClient, ingestComposioTools } from "./composio";

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const keysPresent =
  typeof COMPOSIO_API_KEY === "string" &&
  COMPOSIO_API_KEY.length > 0 &&
  typeof ANTHROPIC_API_KEY === "string" &&
  ANTHROPIC_API_KEY.length > 0;

describe.skipIf(!keysPresent)("Composio live smoke test (real network)", () => {
  it(
    "fetches at least one GitHub tool and tags each descriptor with source: composio",
    async () => {
      const apiKey = COMPOSIO_API_KEY!;
      const userId = process.env.COMPOSIO_TEST_USER_ID ?? "flowlet-smoke-test";

      const client = createComposioClient({ apiKey, toolkits: ["github"] });

      const { toolset, descriptors } = await ingestComposioTools({
        principal: { userId },
        config: { apiKey, toolkits: ["github"] },
        client,
      });

      expect(Object.keys(toolset).length).toBeGreaterThanOrEqual(1);
      expect(descriptors.length).toBeGreaterThanOrEqual(1);
      for (const d of descriptors) {
        expect(d.source).toBe("composio");
      }
    },
    30_000,
  );
});
