import { engineOverAdapter } from "@vendoai/core";
/**
 * The automation door's two REPORTED facts: the audit row it writes, and the
 * armed state it hands back.
 *
 * Both were lost once. The `automation-created` guard row and the authored
 * automation's `enabled` flag were collateral of the conductor refactor
 * (55fb61390) — a commit whose message never mentioned either, with no test on
 * either, so nothing went red. `enabled` came back only because main's
 * automation card requires it; the audit row came back only because a merge
 * happened to put the two versions side by side. Neither should depend on that
 * again: something unattended being armed is exactly the kind of event an audit
 * trail exists for, and the caller renders the armed state as fact.
 *
 * The arming SENTENCES are pinned one layer down, on `armAutomation`: the door
 * answers `armed: false` and drops the findings, so that function is the only
 * live place the words exist.
 */
import {
  VENDO_APP_FORMAT,
  type ApprovalRequest,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { armAutomation } from "../src/server/automation/lane.js";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { fakeAutomations } from "./automations-double.test-util.js";

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

const ASK = "nudge everyone with an overdue invoice every day";

/** The automation planner's answer: a goal, so there is no results collection
 *  and therefore no board rewire to script. The planner is the ONE thing on this
 *  path that still runs on the model. */
const PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  when: { every: "1d" },
  task: { kind: "goal", prompt: "Decide who deserves a gentle vs firm nudge.", budget: { maxToolCalls: 20 } },
});

const respond = (prompt: string): string =>
  prompt.includes("You are the Vendo automation planner") ? PLAN : "";

type Enable = (id: string) => Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;

const authorOne = async (enable?: Enable) => {
  const store = memoryStore();
  const guard = guardFixture();
  const engine = fakeAutomations(enable === undefined ? {} : { enable });
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    automations: engine.seam,
    model: scriptedLanguageModel((call) => respond(
      call.prompt
        .map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""))
        .join("\n"),
    )),
  });
  await seedAppRow(engineOverAdapter(store), seedDoc, ctx.principal.subject);
  const authored = await runtime.automation.author({ appId: APP_ID, instruction: ASK, mode: "goal" }, ctx);
  return { guard, authored, engine };
};

describe("the automation door's audit row", () => {
  it("emits an automation-created lifecycle event when the door arms something unattended", async () => {
    const { guard, authored } = await authorOne();

    // The call really did author an automation — otherwise the assertion below
    // would pass vacuously against a call that authored nothing.
    expect(authored.ok).toBe(true);

    const created = guard.audit.filter((event) =>
      event.kind === "app-lifecycle"
      && (event.detail as { operation?: unknown } | undefined)?.operation === "automation-created");
    expect(created).toHaveLength(1);
    expect(created[0]?.principal.subject).toBe(ctx.principal.subject);
    expect(created[0]?.detail).toMatchObject({
      operation: "automation-created",
      taskKind: "goal",
      triggerKind: "schedule",
    });
  });

  it("leaves the app naming the record, and the record naming no app", async () => {
    const { authored, engine } = await authorOne();

    expect(authored.ok).toBe(true);
    if (!authored.ok) return;
    expect(authored.document.automations).toEqual([authored.record.id]);
    expect(Object.keys(engine.records.get(authored.record.id) ?? {})).not.toContain("appId");
  });
});

describe("the automation door's armed state", () => {
  it("reports armed TRUE when the engine armed it", async () => {
    const { authored } = await authorOne(async () => ({ enabled: true, missing: [] }));

    expect(authored).toMatchObject({ ok: true, armed: true });
  });

  it("reports armed FALSE when enable leaves it disarmed", async () => {
    const { authored } = await authorOne(async () => ({ enabled: false, missing: [] }));

    expect(authored).toMatchObject({ ok: true, armed: false });
  });

  it("reports armed FALSE when enable throws", async () => {
    const { authored } = await authorOne(async () => {
      throw new Error("broker unreachable");
    });

    expect(authored).toMatchObject({ ok: true, armed: false });
  });
});

describe("an automation the engine never armed says why", () => {
  // One sitting silently disarmed is an automation the person believes is
  // running, so a seam that answers without arming and a seam that throws are
  // the SAME miss — both come back as a sentence naming the surface that fixes
  // it.
  const seamWith = (enable: Enable): ReturnType<typeof fakeAutomations>["seam"] =>
    fakeAutomations({ enable }).seam;

  it("names the automations engine when enable leaves it disabled", async () => {
    const armed = await armAutomation(seamWith(async () => ({ enabled: false, missing: [] })), "atm_x", ctx);

    expect(armed.enabled).toBe(false);
    expect(armed.issues.join(" ")).toContain("left it disabled");
    expect(armed.issues.join(" ")).toContain("automations.enable");
  });

  it("names it the same way when arming throws", async () => {
    const armed = await armAutomation(seamWith(async () => {
      throw new Error("broker unreachable");
    }), "atm_x", ctx);

    expect(armed.enabled).toBe(false);
    expect(armed.issues.join(" ")).toContain("arming it failed");
    expect(armed.issues.join(" ")).toContain("broker unreachable");
  });
});
