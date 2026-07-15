import { describe, expect, it } from "vitest";
import {
  runModelSchema,
  stepSchema,
  triggerSchema,
  triggerSourceSchema,
} from "./triggers.js";

/** 01-core §11 trigger shapes. Focuses on the schedule refine (exactly one of
 * cron/every/at) and the discriminated-union boundaries. */
describe("triggerSourceSchema", () => {
  it("accepts each of the three schedule spellings, one at a time", () => {
    expect(triggerSourceSchema.safeParse({ kind: "schedule", cron: "0 9 * * *" }).success).toBe(true);
    expect(triggerSourceSchema.safeParse({ kind: "schedule", every: "1h" }).success).toBe(true);
    expect(
      triggerSourceSchema.safeParse({ kind: "schedule", at: "2026-07-12T09:00:00.000Z" }).success,
    ).toBe(true);
  });

  it("rejects a schedule with zero, or with more than one, of cron/every/at", () => {
    expect(triggerSourceSchema.safeParse({ kind: "schedule" }).success).toBe(false);
    expect(
      triggerSourceSchema.safeParse({ kind: "schedule", cron: "0 9 * * *", every: "1h" }).success,
    ).toBe(false);
    expect(
      triggerSourceSchema.safeParse({
        kind: "schedule",
        cron: "0 9 * * *",
        at: "2026-07-12T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("accepts host-event and external kinds and preserves unknown keys (passthrough)", () => {
    expect(triggerSourceSchema.parse({ kind: "host-event", event: "invoice.paid", extra: 1 })).toMatchObject({
      extra: 1,
    });
    expect(
      triggerSourceSchema.parse({ kind: "external", connector: "composio", event: "gmail.new", config: { q: "x" } }),
    ).toMatchObject({ connector: "composio", config: { q: "x" } });
  });

  it("rejects host-event without an event and external without a connector", () => {
    expect(triggerSourceSchema.safeParse({ kind: "host-event" }).success).toBe(false);
    expect(triggerSourceSchema.safeParse({ kind: "external", event: "x" }).success).toBe(false);
    expect(triggerSourceSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });
});

describe("stepSchema and runModelSchema", () => {
  it("accepts a minimal step and a fully-specified step", () => {
    expect(stepSchema.safeParse({ id: "s1", tool: "host_x" }).success).toBe(true);
    expect(
      stepSchema.safeParse({
        id: "s1",
        tool: "host_x",
        args: { limit: "10" },
        if: "$.ok",
        forEach: "$.rows",
      }).success,
    ).toBe(true);
  });

  it("rejects a step whose args are not string-valued", () => {
    expect(stepSchema.safeParse({ id: "s1", tool: "host_x", args: { limit: 10 } }).success).toBe(false);
  });

  it("discriminates agentic vs steps run models", () => {
    expect(runModelSchema.safeParse({ kind: "agentic", prompt: "do the thing" }).success).toBe(true);
    expect(
      runModelSchema.safeParse({ kind: "agentic", prompt: "p", budget: { maxToolCalls: 3 } }).success,
    ).toBe(true);
    expect(runModelSchema.safeParse({ kind: "steps", steps: [{ id: "s1", tool: "t" }] }).success).toBe(true);
    expect(runModelSchema.safeParse({ kind: "agentic" }).success).toBe(false);
    expect(runModelSchema.safeParse({ kind: "steps" }).success).toBe(false);
  });
});

describe("triggerSchema", () => {
  it("composes a source and a run model", () => {
    expect(
      triggerSchema.safeParse({
        on: { kind: "host-event", event: "invoice.paid" },
        run: { kind: "agentic", prompt: "chase it" },
      }).success,
    ).toBe(true);
  });

  it("rejects a trigger whose source is invalid", () => {
    expect(
      triggerSchema.safeParse({
        on: { kind: "schedule" },
        run: { kind: "agentic", prompt: "x" },
      }).success,
    ).toBe(false);
  });
});
