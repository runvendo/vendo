/**
 * The automation RECORD's law — the shapes four authoring doors and two
 * packages share. Everything here is pure: no store, no engine, no clock, so a
 * cron nobody can run is refused at DECLARATION and a redeploy's effect on what
 * is already armed is decided by a diff anyone can read.
 */
import { describe, expect, it } from "vitest";
import { VendoError } from "../src/errors.js";
import {
  AUTOMATIONS_DOCS_URL,
  automationHash,
  automationRecordSchema,
  declaredAutomationId,
  reconcileAutomations,
  toTriggerSource,
  type AutomationRecord,
  type AutomationTask,
  type DeclaredAutomation,
} from "../src/index.js";

const at = "2026-08-17T09:00:00.000Z";
const owner = { kind: "user" as const, subject: "user_alice" };
const task: AutomationTask = { kind: "goal", prompt: "Summarise last week's invoices" };

function errorOf(run: () => unknown): VendoError {
  try {
    run();
  } catch (error) {
    return error as VendoError;
  }
  throw new Error("expected a throw");
}

describe("toTriggerSource", () => {
  it("normalizes each of the five authoring shapes", () => {
    expect(toTriggerSource("0 9 * * 1")).toEqual({ kind: "schedule", cron: "0 9 * * 1" });
    expect(toTriggerSource({ every: "15m" })).toEqual({ kind: "schedule", every: "15m" });
    expect(toTriggerSource({ at })).toEqual({ kind: "schedule", at });
    expect(toTriggerSource({ event: "payment.failed" })).toEqual({ kind: "host-event", event: "payment.failed" });
    expect(toTriggerSource({ webhook: "stripe" })).toEqual({ kind: "external", connector: "stripe" });
  });

  it("answers English with a cron the author can paste, and with the docs", () => {
    const error = errorOf(() => toTriggerSource("every monday"));
    expect(error).toBeInstanceOf(VendoError);
    expect(error.code).toBe("validation");
    expect(error.message).toContain('"0 9 * * 1"');
    expect(error.message).toContain(AUTOMATIONS_DOCS_URL);
    // …on the host the docs actually answer on. Every other in-repo docs link is
    // built on this origin; `vendo.run/docs/**` returns 404, so the link a
    // refusal hands its author has to be checked, not just present.
    expect(AUTOMATIONS_DOCS_URL.startsWith("https://docs.vendo.run/")).toBe(true);
  });

  it("refuses a cron that is short a field or out of range", () => {
    expect(() => toTriggerSource("0 9 * *")).toThrow(VendoError);
    expect(() => toTriggerSource("99 * * * *")).toThrow(VendoError);
  });

  it("refuses an interval that is not <n><s|m|h|d> with n > 0, and an at that is not an instant", () => {
    expect(() => toTriggerSource({ every: "1x" })).toThrow(VendoError);
    expect(() => toTriggerSource({ every: "0d" })).toThrow(VendoError);
    expect(() => toTriggerSource({ at: "next tuesday" })).toThrow(VendoError);
  });

  it("refuses an object naming NO trigger, rather than inventing a connectorless webhook", () => {
    // ABSENT is not EMPTY. The webhook arm is the fall-through, so an object with
    // none of the five keys used to walk straight into it and answer
    // `{ kind: "external", connector: undefined }` — an automation nothing can
    // ever trigger, reported to its owner as armed. The callers that hit this are
    // the admin routes, which take an untyped object off a wire.
    for (const when of [{}, { webhook: "" }, { connector: "stripe" }, { cron: "0 9 * * 1" }]) {
      const error = errorOf(() => toTriggerSource(when as Parameters<typeof toTriggerSource>[0]));
      expect(error, JSON.stringify(when)).toBeInstanceOf(VendoError);
      expect(error.code).toBe("validation");
    }
    // And the fall-through never yields a source without a connector.
    expect(toTriggerSource({ webhook: "stripe" })).toEqual({ kind: "external", connector: "stripe" });
  });
});

describe("automationHash", () => {
  const content = {
    when: toTriggerSource("0 9 * * 1"),
    task,
    agent: "ops",
    timezone: "America/New_York",
  };

  it("is stable across key insertion order — one content, one hash", () => {
    expect(automationHash({
      timezone: content.timezone,
      agent: content.agent,
      task: content.task,
      when: content.when,
    })).toBe(automationHash(content));
  });

  it("changes when the when, the task, the agent, or the timezone changes", () => {
    const base = automationHash(content);
    expect(automationHash({ ...content, when: toTriggerSource("0 10 * * 1") })).not.toBe(base);
    expect(automationHash({ ...content, task: { kind: "goal", prompt: "Summarise last month" } })).not.toBe(base);
    expect(automationHash({ ...content, agent: "research" })).not.toBe(base);
    expect(automationHash({ ...content, timezone: "UTC" })).not.toBe(base);
    expect(automationHash({ when: content.when, task: content.task })).not.toBe(base);
  });

  it("reads the four content fields and nothing else — a whole RECORD hashes as its content", () => {
    // reconcileAutomations hands it stored records: if `armed`, `updatedAt` or
    // the id participated, every redeploy would look like an edit.
    const record = { ...content, id: "atm_weekly", armed: false, createdAt: at, updatedAt: at };
    expect(automationHash(record)).toBe(automationHash(content));
  });
});

describe("declaredAutomationId", () => {
  const when = toTriggerSource("0 9 * * 1");

  it("slugs an explicit id, the same way every time", () => {
    expect(declaredAutomationId({ id: "Weekly Digest!", when: "0 9 * * 1", task }, when)).toBe("atm_weekly-digest");
  });

  it("derives an unnamed declaration's identity from what it DOES, so identical declarations collide by design", () => {
    const first = declaredAutomationId({ when: "0 9 * * 1", task }, when);
    expect(first).toBe(`atm_${automationHash({ when, task }).slice(0, 12)}`);
    expect(declaredAutomationId({ when: "0 9 * * 1", task: { ...task } }, when)).toBe(first);
    const edited = toTriggerSource("0 10 * * 1");
    expect(declaredAutomationId({ when: "0 10 * * 1", task }, edited)).not.toBe(first);
  });
});

describe("reconcileAutomations", () => {
  const declared: DeclaredAutomation = { when: "0 9 * * 1", task };
  const id = declaredAutomationId(declared, toTriggerSource("0 9 * * 1"));

  const stored = (overrides: Partial<AutomationRecord> = {}): AutomationRecord => ({
    id,
    owner,
    when: toTriggerSource("0 9 * * 1"),
    task,
    armed: true,
    authoredBy: "code",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });

  it("creates a declaration the store has never seen", () => {
    expect(reconcileAutomations([declared], [], owner, "code")).toEqual({
      create: [{ id, owner, when: declared.when, task, authoredBy: "code" }],
      disarm: [],
    });
  });

  it("does nothing at all to an unchanged armed declaration — a redeploy is a no-op", () => {
    const named: DeclaredAutomation = { id: "weekly", when: "0 9 * * 1", task, timezone: "UTC" };
    const namedId = declaredAutomationId(named, toTriggerSource("0 9 * * 1"));
    const before = [
      stored(),
      stored({ id: namedId, timezone: "UTC" }),
    ];
    expect(reconcileAutomations([declared, named], before, owner, "code")).toEqual({ create: [], disarm: [] });
  });

  it("creates the new identity of an edited declaration and disarms the one it supersedes", () => {
    const editedCron = reconcileAutomations([{ when: "0 10 * * 1", task }], [stored()], owner, "code");
    expect(editedCron.create).toHaveLength(1);
    expect(editedCron.create[0]!.id).not.toBe(id);
    expect(editedCron.disarm).toEqual([id]);

    const editedTask = reconcileAutomations(
      [{ when: "0 9 * * 1", task: { kind: "goal", prompt: "Summarise last month" } }],
      [stored()],
      owner,
      "code",
    );
    expect(editedTask.create[0]!.id).not.toBe(id);
    expect(editedTask.disarm).toEqual([id]);
  });

  it("disarms what the code no longer declares — consent was the code, and the run history survives", () => {
    expect(reconcileAutomations([], [stored()], owner, "code")).toEqual({ create: [], disarm: [id] });
  });

  it("leaves a record a PERSON disarmed entirely alone — the kill switch survives every redeploy", () => {
    const killed = stored({ armed: false, disarmedBy: "user" });
    // Re-declaring it does not re-arm it, and dropping it does not disarm it twice.
    expect(reconcileAutomations([declared], [killed], owner, "code")).toEqual({ create: [], disarm: [] });
    expect(reconcileAutomations([], [killed], owner, "code")).toEqual({ create: [], disarm: [] });
  });

  it("never touches a chat-authored record — a code reconcile cannot see one", () => {
    const chat = stored({ authoredBy: "chat" });
    expect(reconcileAutomations([], [chat], owner, "code").disarm).toEqual([]);
    // Invisible means invisible: the identical declaration is a CREATE, not a match.
    expect(reconcileAutomations([declared], [chat], owner, "code").create).toHaveLength(1);
  });

  it("never touches another subject's record", () => {
    const theirs = stored({ owner: { kind: "user", subject: "user_bob" } });
    expect(reconcileAutomations([], [theirs], owner, "code")).toEqual({ create: [], disarm: [] });
  });
});

describe("automationRecordSchema", () => {
  const record: AutomationRecord = {
    id: "atm_weekly",
    owner,
    when: { kind: "external", connector: "gmail", event: "new_bill_email" },
    task: { kind: "steps", steps: [{ id: "pay", tool: "host_transferMoney" }] },
    agent: "ops",
    armed: false,
    authoredBy: "manifest",
    timezone: "America/New_York",
    grantSetId: "gset_1",
    webhookSecret: "c2VjcmV0",
    disarmedBy: "user",
    createdAt: at,
    updatedAt: at,
  };

  it("round-trips a full record", () => {
    expect(automationRecordSchema.parse(record)).toEqual(record);
  });

  it("rejects an authoredBy nobody authors by", () => {
    expect(automationRecordSchema.safeParse({ ...record, authoredBy: "robot" }).success).toBe(false);
  });
});
