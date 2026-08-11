/** J1 — CHAT GENERATES AN APP, end to end through the composed umbrella.
 *
 * A single POST /threads turn as ADA: the scripted agent calls the composed
 * `vendo_make` capability tool (added to the registry by the umbrella via
 * `actions.add(apps.agentTools())`); executing it drives the screen agent — the
 * SAME model instance — which saves an `app.tsx` React component; the agent then
 * closes with a text turn.
 *
 * Asserts the whole composition worked: the SSE stream completes, a vendo_apps
 * row owned by ADA lands (raw SQL), the wire lists + opens it as a tree, and —
 * the one-security-rule ownership boundary — BOB does not see ADA's app.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  BOB,
  createStack,
  screenAgentCreateTurns,
  readSse,
  resetFixture,
  textTurn,
  toolCallTurn,
  type Stack,
} from "../src/harness.js";

/** The screen the agent saves: one `app.tsx` component, which the floor's own
 *  gauntlet compiles, type-checks and RENDERS before anything paints — so a
 *  screen that would not run leaves no row at all. The app's title is the default
 *  export's name (`screenName`), a `.tsx` file having no other. */
const CREATE_SCREEN = `import { Disclaimer, Stack, Text } from "@vendo/screen";

export default function AdaGreeting() {
  return (
    <Stack gap={12}>
      <Text text="Hello Ada" variant="heading" />
      <Disclaimer reason="Fixture app." />
    </Stack>
  );
}
`;

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J1: chat generates an app through the real composition", () => {
  it("streams a turn that creates a vendo_apps row owned by ADA, listable + openable, invisible to BOB", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        toolCallTurn("vendo_make", { request: "Build me a greeting card" }, "call_1"),
        // `vendo_make` starts in the screen agent on every deployment now, and
        // it answers this ask itself: it writes the document with its own hands
        // and the render seam's `authored` half is what makes the row. The
        // conductor never runs, so it spends no generation turns.
        ...screenAgentCreateTurns(CREATE_SCREEN),
        textTurn("Created your app.", "t1"),
      ],
    });

    const turn = await readSse(
      await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_j1",
          message: { id: "u1", role: "user", parts: [{ type: "text", text: "Build me a greeting card" }] },
        }),
      }, ADA),
    );

    // The stream ran to completion and the composed tool produced its output.
    expect(turn.raw.includes("[DONE]")).toBe(true);
    expect(turn.raw.includes("Created your app.")).toBe(true);

    // Real side effect: exactly one app, owned by ADA, persisted by the composed store.
    const apps = await stack.sql<{ id: string; subject: string }>("SELECT id, subject FROM vendo_apps");
    expect(apps).toHaveLength(1);
    expect(apps[0]?.subject).toBe(ADA.subject);
    const appId = apps[0]!.id;

    // The composed guard bound the capability tool: the audit trail records it.
    const audit = await stack.sql<{ tool: string }>(
      "SELECT tool FROM vendo_audit WHERE subject = $1 AND kind = 'tool-call'",
      [ADA.subject],
    );
    expect(audit.some((row) => row.tool === "vendo_make")).toBe(true);

    // Wire GET /apps lists it for ADA.
    const adaList = (await (await stack.wireFetch("/apps", {}, ADA)).json()) as Array<{ id: string }>;
    expect(adaList.map((app) => app.id)).toContain(appId);

    // Wire GET /apps/:id/open returns the generated tree payload. A component
    // screen stores no tree — `open` re-runs the stored `app.tsx` in the sealed
    // VM — so this is the screen RENDERING, not a snapshot of one.
    const opened = (await (await stack.wireFetch(`/apps/${appId}/open`, {}, ADA)).json()) as {
      kind: string;
      payload: {
        formatVersion: string;
        root: string;
        nodes: Array<{ id: string; component: string; props?: { text?: string } }>;
      };
    };
    expect(opened.kind).toBe("tree");
    expect(opened.payload.formatVersion).toBe("vendo-genui/v2");
    expect(opened.payload.root).toBe("root");
    // `flattenTree` names a node by its structural path, so the heading inside
    // the root <Stack> is `root.0`.
    expect(opened.payload.nodes.find((node) => node.id === "root.0"))
      .toMatchObject({ component: "Text", props: { text: "Hello Ada" } });

    // One-security-rule ownership: BOB does not see ADA's app.
    const bobList = (await (await stack.wireFetch("/apps", {}, BOB)).json()) as Array<{ id: string }>;
    expect(bobList.map((app) => app.id)).not.toContain(appId);
  });
});
