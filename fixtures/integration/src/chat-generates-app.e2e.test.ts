/** J1 — CHAT GENERATES AN APP, end to end through the composed umbrella.
 *
 * A single POST /threads turn as ADA: the scripted agent calls the composed
 * `vendo_apps_create` capability tool (added to the registry by the umbrella via
 * `actions.add(apps.agentTools())`); executing it drives the apps generation
 * engine — the SAME model instance, via doGenerate — which returns a valid
 * vendo-genui/v1 CREATE tree; the agent then closes with a text turn.
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
  generationTurn,
  readSse,
  resetFixture,
  textTurn,
  toolCallTurn,
  type Stack,
} from "./harness.js";

const CREATE_DIALECT = {
  name: "Ada's Greeting",
  description: "A tiny greeting card",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["greeting"] },
      { id: "greeting", component: "Text", source: "prewired", props: { text: "Hello Ada" } },
    ],
  },
};

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J1: chat generates an app through the real composition", () => {
  it("streams a turn that creates a vendo_apps row owned by ADA, listable + openable, invisible to BOB", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        toolCallTurn("vendo_apps_create", { prompt: "Build me a greeting card" }, "call_1"),
        generationTurn(CREATE_DIALECT),
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
    expect(audit.some((row) => row.tool === "vendo_apps_create")).toBe(true);

    // Wire GET /apps lists it for ADA.
    const adaList = (await (await stack.wireFetch("/apps", {}, ADA)).json()) as Array<{ id: string }>;
    expect(adaList.map((app) => app.id)).toContain(appId);

    // Wire GET /apps/:id/open returns the generated tree payload.
    const opened = (await (await stack.wireFetch(`/apps/${appId}/open`, {}, ADA)).json()) as {
      kind: string;
      payload: { formatVersion: string; root: string; nodes: Array<{ id: string; props?: { text?: string } }> };
    };
    expect(opened.kind).toBe("tree");
    expect(opened.payload.formatVersion).toBe("vendo-genui/v1");
    expect(opened.payload.root).toBe("root");
    expect(opened.payload.nodes.find((node) => node.id === "greeting")?.props?.text).toBe("Hello Ada");

    // One-security-rule ownership: BOB does not see ADA's app.
    const bobList = (await (await stack.wireFetch("/apps", {}, BOB)).json()) as Array<{ id: string }>;
    expect(bobList.map((app) => app.id)).not.toContain(appId);
  });
});
