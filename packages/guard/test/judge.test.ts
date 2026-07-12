import type { AuditEvent } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard, vendoAutoJudge } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import {
  asLanguageModel,
  hangingJudgeModel,
  scriptedJudgeModel,
  throwingJudgeModel,
} from "./fixtures/scripted-judge-model.js";
import { alice, auditEvent, call, context, FixtureTools } from "./fixtures/tools.js";

afterEach(() => {
  vi.useRealTimers();
});

function details(event: AuditEvent): Record<string, unknown> {
  return (event.detail ?? {}) as Record<string, unknown>;
}

describe("Vendo Auto judge", () => {
  it("surfaces run, ask, and block and preserves rationale in eventual audit events", async () => {
    const store = createMemoryStore();
    const model = scriptedJudgeModel(
      { action: "run", rationale: "routine read" },
      { action: "ask", rationale: "confirm this write" },
      { action: "block", rationale: "destruction forbidden" },
    );
    const guard = createGuard({
      store,
      policy: { directions: ["Never delete customer data."] },
      judge: vendoAutoJudge({ model: asLanguageModel(model), instructions: "Be conservative." }),
    });
    await guard.report(
      auditEvent({
        id: "aud_prior",
        at: "2026-01-01T00:00:00.000Z",
        tool: "host_read",
        outcome: "ok",
        decidedBy: "default",
      }),
    );
    const bound = guard.bind(new FixtureTools());

    await expect(bound.execute(call("host_read", {}, "judge_run"), context())).resolves.toMatchObject({
      status: "ok",
    });
    await expect(bound.execute(call("host_write", {}, "judge_ask"), context())).resolves.toMatchObject({
      status: "pending-approval",
    });
    await expect(
      bound.execute(call("host_destructive", {}, "judge_block"), context()),
    ).resolves.toEqual({ status: "blocked", reason: "destruction forbidden" });

    const { events } = await guard.audit.query({ principal: alice, limit: 50 });
    expect(events.some((event) => event.decidedBy === "judge" && details(event).rationale === "routine read")).toBe(true);
    expect(events.some((event) => event.decidedBy === "judge" && details(event).rationale === "confirm this write")).toBe(true);
    expect(events.some((event) => event.decidedBy === "judge" && details(event).rationale === "destruction forbidden")).toBe(true);

    const prompt = JSON.stringify(model.doGenerateCalls);
    expect(prompt).toContain("Never delete customer data.");
    expect(prompt).toContain("Be conservative.");
    expect(prompt).toContain("host_read");
    expect(prompt).toContain("tool-call");
    expect(prompt).toContain("default");
  });

  it("fails closed when the model throws", async () => {
    const model = throwingJudgeModel("provider offline");
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({ model: asLanguageModel(model) }),
    });
    const decision = await guard.check(call("host_read"), new FixtureTools().available[0]!, context());
    expect(decision).toMatchObject({ action: "ask", decidedBy: "judge" });
    const { events } = await guard.audit.query({ principal: alice });
    expect(events.some((event) => String(details(event).rationale).includes("provider offline"))).toBe(true);
  });

  it("fails closed after the 15 second timeout without waiting in wall-clock time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const model = hangingJudgeModel();
    const tools = new FixtureTools();
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({ model: asLanguageModel(model) }),
    });
    const pending = guard.check(call("host_read"), tools.available[0]!, context());
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(pending).resolves.toMatchObject({ action: "ask", decidedBy: "judge" });
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
