import { describe, expect, it } from "vitest";
import { jsonPost, scriptedModel, startTestHost, textTurn } from "./harness.js";

const generatedApp = JSON.stringify({
  name: "Relay priority board",
  description: "Open Relay work grouped by urgency.",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["title", "tasks"] },
      { id: "title", component: "Text", source: "prewired", props: { text: "Priority board" } },
      { id: "tasks", component: "Text", source: "prewired", props: { text: "High-priority Relay tasks" } },
    ],
  },
});

describe("Relay generated view", () => {
  it("creates and opens a pinned vendo-genui/v1 tree over the Express wire", async () => {
    const host = await startTestHost(scriptedModel([textTurn(generatedApp)]));
    try {
      const createdResponse = await fetch(`${host.baseUrl}/api/vendo/apps`, jsonPost({ prompt: "Build a Relay priority board" }));
      expect(createdResponse.status).toBe(200);
      const created = await createdResponse.json() as { format: string; id: string; tree: { formatVersion: string } };
      expect(created).toMatchObject({
        format: "vendo/app@1",
        id: expect.stringMatching(/^app_/),
        tree: { formatVersion: "vendo-genui/v1" },
      });

      const openedResponse = await fetch(`${host.baseUrl}/api/vendo/apps/${created.id}/open`);
      expect(openedResponse.status).toBe(200);
      expect(await openedResponse.json()).toMatchObject({
        kind: "tree",
        payload: { formatVersion: "vendo-genui/v1", root: "root" },
      });
    } finally {
      await host.close();
    }
  });
});
