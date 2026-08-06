import { describe, expect, it } from "vitest";
import { jsonPost, scriptedModel, startTestHost, textTurn, toolCallTurn } from "./harness.js";

const generatedApp = [
  '<App name="Relay priority board"><Stack>',
  '<Text text="Priority board"/><Text text="High-priority Relay tasks"/>',
  "</Stack></App>",
].join("");

describe("Relay generated view", () => {
  it("creates and opens a vendo-genui/v2 tree over the Express wire", async () => {
    // `POST /apps` runs the ONE engine — the screen agent — so the script is that
    // agent's own turns: save the whole document, then speak. There is no second
    // dialect and no second builder behind this route.
    const host = await startTestHost(scriptedModel([
      toolCallTurn("save_app", { content: generatedApp }, "call_save_app"),
      textTurn("saved"),
    ]));
    try {
      const createdResponse = await fetch(`${host.baseUrl}/api/vendo/apps`, jsonPost({ prompt: "Build a Relay priority board" }));
      expect(createdResponse.status).toBe(200);
      const created = await createdResponse.json() as { format: string; id: string; tree: { formatVersion: string } };
      expect(created).toMatchObject({
        format: "vendo/app@1",
        id: expect.stringMatching(/^app_/),
        tree: { formatVersion: "vendo-genui/v2" },
      });

      const openedResponse = await fetch(`${host.baseUrl}/api/vendo/apps/${created.id}/open`);
      expect(openedResponse.status).toBe(200);
      expect(await openedResponse.json()).toMatchObject({
        kind: "tree",
        payload: { formatVersion: "vendo-genui/v2", root: "root" },
      });
    } finally {
      await host.close();
    }
  });
});
