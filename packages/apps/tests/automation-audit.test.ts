/**
 * The automation ladder's two REPORTED facts: the audit row it writes, and the
 * armed state it hands back.
 *
 * Both were lost once. The `automation-created` guard row and
 * `EditResult.automation.enabled` were collateral of the conductor refactor
 * (55fb61390) — a commit whose message never mentioned either, with no test on
 * either, so nothing went red. `enabled` came back only because main's
 * automation card requires it; the audit row came back only because a merge
 * happened to put the two versions side by side. Neither should depend on that
 * again: an unattended trigger being authored is exactly the kind of event an
 * audit trail exists for, and the thread's card renders the armed state as
 * fact.
 */
import { VENDO_APP_FORMAT, type AppDocument, type RunContext, type ScreenAssembler, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/index.js";
import { guardFixture } from "../src/testing/guard-fixture.js";
import { memoryStore } from "../src/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/testing/scripted-model.js";
import { seedAppRow } from "../src/testing/seed-app-row.js";

const APP_ID = "app_audit_ladder";

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

const seedDoc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: APP_ID,
  name: "Invoice board",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "app",
    nodes: [{ id: "app", component: "Stack", source: "prewired", children: [] }],
  },
};

/** The plan the escalating screen agent left behind: the ask is server-shaped,
 *  so the plan declares one, and the ladder runs exactly what it declared. */
const ESCALATED_PLAN = `<Plan name="Invoice board">
  <Group title="Nudges">
    <Leaf component="Text" purpose="One line saying the nudge automation runs daily"/>
  </Group>
  <Server kind="agentic" schedule="every day" why="Each invoice needs a judgment call on how firm the nudge should be."/>
</Plan>`;

/** The one builder's answer to an ask no arrangement of components can serve:
 *  it asks for the builder, and the plan above is what it left behind. */
const escalatingScreen: ScreenAssembler = {
  assemble: async () => ({ kind: "escalate", why: "nudging every day happens while nobody is watching" }),
};

/** The automation planner's answer: agentic, so there is no results collection
 *  and therefore no board rewire to script. The planner is the ONE thing on this
 *  path that still runs on the model. */
const PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  trigger: {
    on: { kind: "schedule", every: "1d" },
    run: { kind: "agentic", prompt: "Decide who deserves a gentle vs firm nudge.", budget: { maxToolCalls: 20 } },
  },
});

const respond = (prompt: string): string =>
  prompt.includes("You are the Vendo automation planner") ? PLAN : "";

const setup = (armAutomation?: () => Promise<{ enabled: boolean; missing: never[] }>) => {
  const store = memoryStore();
  const guard = guardFixture();
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    model: scriptedLanguageModel((call) => respond(
      call.prompt
        .map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""))
        .join("\n"),
    )),
    screen: escalatingScreen,
    escalatedPlan: async () => ESCALATED_PLAN,
    ...(armAutomation === undefined ? {} : { armAutomation }),
  });
  return { store, guard, runtime };
};

const rideTheLadder = async (
  armAutomation?: () => Promise<{ enabled: boolean; missing: never[] }>,
) => {
  const { store, guard, runtime } = setup(armAutomation);
  await seedAppRow(store, seedDoc, ctx.principal.subject);
  const edited = await runtime.edit(APP_ID, "nudge everyone with an overdue invoice every day", ctx);
  return { guard, edited };
};

describe("the automation ladder's audit row", () => {
  it("emits an automation-created lifecycle event when an edit authors an unattended trigger", async () => {
    const { guard, edited } = await rideTheLadder();

    // The edit really did ride the ladder — otherwise the assertion below would
    // pass vacuously against an edit that never authored an automation.
    expect(edited.failure).toBeUndefined();
    expect(edited.automation?.mode).toBe("agentic");

    const created = guard.audit.filter((event) =>
      event.kind === "app-lifecycle"
      && (event.detail as { operation?: unknown } | undefined)?.operation === "automation-created");
    expect(created).toHaveLength(1);
    expect(created[0]?.principal.subject).toBe(ctx.principal.subject);
    expect(created[0]?.detail).toMatchObject({
      operation: "automation-created",
      mode: "agentic",
      triggerKind: "schedule",
    });
  });
});

describe("the automation ladder's armed state", () => {
  it("reports enabled TRUE when the host's arming seam armed the trigger", async () => {
    const { edited } = await rideTheLadder(async () => ({ enabled: true, missing: [] }));

    expect(edited.automation?.enabled).toBe(true);
  });

  it("reports enabled FALSE when the arming seam leaves the trigger disarmed", async () => {
    const { edited } = await rideTheLadder(async () => ({ enabled: false, missing: [] }));

    expect(edited.automation?.mode).toBe("agentic");
    expect(edited.automation?.enabled).toBe(false);
    // And it says why, rather than leaving a dead trigger to be discovered.
    expect((edited.issues ?? []).join(" ")).toContain("left it disabled");
  });

  it("reports enabled FALSE when the arming seam throws", async () => {
    const { edited } = await rideTheLadder(async () => {
      throw new Error("broker unreachable");
    });

    expect(edited.automation?.mode).toBe("agentic");
    expect(edited.automation?.enabled).toBe(false);
    expect((edited.issues ?? []).join(" ")).toContain("arming it failed");
  });
});
