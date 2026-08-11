import { describe, expect, it } from "vitest";
import { jsonPost, scriptedModel, startTestHost, textTurn, toolCallTurn } from "./harness.js";

/** The screen as the one engine now writes it: an `app.tsx` React component the
 *  gauntlet compiles, type-checks and actually renders. The component's own name
 *  is the app's title (`screenName`, apps' checking/component-screen.ts). */
const generatedApp = `import { Stack, Text } from "@vendo/screen";

export default function RelayPriorityBoard() {
  return (
    <Stack>
      <Text text="Priority board" />
      <Text text="High-priority Relay tasks" />
    </Stack>
  );
}
`;

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
      // A component screen's DOCUMENT carries no tree — the screen IS its source,
      // and a tree only exists once the engine has run it, which is what `open`
      // below returns. So the create answer pins the artifact and the title: the
      // name is the component's own, split on camel case (`RelayPriorityBoard` →
      // "Relay priority board"), never the prompt's wording.
      const created = await createdResponse.json() as { format: string; id: string; name: string; ui: string; source: Record<string, { text: string }> };
      expect(created).toMatchObject({
        format: "vendo/app@1",
        id: expect.stringMatching(/^app_/),
        name: "Relay priority board",
        ui: "tree",
      });
      expect(Object.keys(created.source)).toEqual(["app.tsx"]);
      expect(created.source["app.tsx"]?.text).toBe(generatedApp);

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
