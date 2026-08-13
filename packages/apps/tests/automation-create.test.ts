/**
 * The CREATE half of the ladder's reporting (#881): a create whose plan
 * declares server work must hand what the lane produced — the authored
 * automation envelope, arming issues, failure sentences — to its caller
 * through `onServerWork`. `EditResult` has carried the same facts since
 * Wave 9; the create door dropped them on the floor, so a first-ask
 * automation never raised a card and its pending grants were invisible.
 */
import { engineOverAdapter, VENDO_APP_FORMAT, type RunContext, type ToolRegistry } from "@vendoai/core";
import { type ScreenAssembler } from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { fakeBoxSandbox } from "../src/server/testing/fake-box.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import type { CreateServerWork } from "../src/server/runtime/types.js";

const APP_ID = "app_create_ladder";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() {
    return [{
      name: "host_send_email",
      description: "Send an email.",
      inputSchema: { type: "object", properties: { subject: {}, body: {} } },
      risk: "write",
    }];
  },
  async execute() {
    return { status: "ok", output: { sent: true } };
  },
};

/** The plan the escalating screen agent left behind, handed to `create`
 *  verbatim (§4.5): server-shaped, so the ladder runs what it declared. */
const ESCALATED_PLAN = `<Plan name="Invoice nudges">
  <Group title="Nudges">
    <Leaf component="Text" purpose="One line saying the nudge automation runs daily"/>
  </Group>
  <Server kind="agentic" schedule="every day" why="Each invoice needs a judgment call on how firm the nudge should be."/>
</Plan>`;

/** The automation planner's answer — the ONE model turn on this path. */
const PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  trigger: {
    on: { kind: "schedule", every: "1d" },
    run: { kind: "agentic", prompt: "Decide who deserves a gentle vs firm nudge.", budget: { maxToolCalls: 20 } },
  },
});

const respond = (prompt: string): string =>
  prompt.includes("You are the Vendo automation planner") ? PLAN : "";

/** Never reached: the create below is handed its plan, so nothing assembles. */
const escalatingScreen: ScreenAssembler = {
  assemble: async () => ({ kind: "escalate", why: "server work happens while nobody is watching" }),
};

const createWithLadder = async (
  armAutomation?: () => Promise<{ enabled: boolean; missing: never[] }>,
) => {
  const runtime = createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools,
    catalog: [],
    model: scriptedLanguageModel((call) => respond(
      call.prompt
        .map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""))
        .join("\n"),
    )),
    machine: { sandbox: fakeBoxSandbox() },
    screen: escalatingScreen,
    ...(armAutomation === undefined ? {} : { armAutomation }),
  });
  const work: CreateServerWork[] = [];
  const document = await runtime.create({
    appId: APP_ID,
    prompt: "nudge everyone with an overdue invoice every day",
    plan: ESCALATED_PLAN,
    onServerWork: (outcome) => { work.push(outcome); },
  }, ctx);
  return { document, work };
};

describe("schedule on an app with no automation", () => {
  it("names the door back to vendo_make instead of a dead end", async () => {
    // Field (linkwarden 2026-08-08): the refusal is the one sentence the
    // calling model recovers from mid-turn, so it must carry the exact next
    // move — the make door, this app named, schedule and action in one ask.
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    await seedAppRow(engineOverAdapter(store), {
      format: VENDO_APP_FORMAT,
      id: "app_view_only",
      name: "Links",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "app",
        nodes: [{ id: "app", component: "Stack", source: "prewired", children: [] }],
      },
    }, ctx.principal.subject);
    await expect(runtime.schedule("app_view_only", "*/5 * * * *", ctx))
      .rejects.toThrow(/vendo_make/);
  });
});

describe("create hands the server lane's outcome to its caller (#881)", () => {
  it("delivers the authored automation envelope through onServerWork", async () => {
    const { work } = await createWithLadder(async () => ({ enabled: true, missing: [] }));

    expect(work).toHaveLength(1);
    expect(work[0]?.automation?.mode).toBe("agentic");
    expect(work[0]?.automation?.enabled).toBe(true);
    expect(work[0]?.automation?.trigger.on.kind).toBe("schedule");
  });

  it("reports enabled FALSE with the arming failure riding issues when the seam throws", async () => {
    const { work } = await createWithLadder(async () => {
      throw new Error("broker unreachable");
    });

    expect(work).toHaveLength(1);
    expect(work[0]?.automation?.enabled).toBe(false);
    expect((work[0]?.issues ?? []).join(" ")).toContain("arming it failed");
  });
});
