import { VENDO_TOOL_TITLES, VendoError, type RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { VENDO_VERB_TOOLS, vendoVerbsRegistry } from "../src/vendo-verbs.js";

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "user_alice" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...overrides,
});

const call = (tool: string, args: unknown) => ({ id: "call_1", tool, args: args as never });

const ports = (overrides = {}) => ({
  validate: async () => ({ ok: true as const, findings: [] }),
  searchComponents: async () => [{ component: "Chart", description: "A chart" }],
  schedule: async () => ({ scheduled: true as const, cron: "0 8 * * *" }),
  ...overrides,
});

describe("the vendo verbs are projected as ordinary tools (design §4)", () => {
  it("projects exactly the contracted verb set", async () => {
    const descriptors = await vendoVerbsRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.name).sort()).toEqual([...VENDO_VERB_TOOLS].sort());
  });

  it("labels validate and search_components as reads, and schedule as a write", async () => {
    const descriptors = await vendoVerbsRegistry(ports()).descriptors();
    const risk = new Map(descriptors.map((d) => [d.name, d.risk]));
    expect(risk.get("validate")).toBe("read");
    expect(risk.get("search_components")).toBe("read");
    // Arming a schedule changes what runs later, so it is not a read.
    expect(risk.get("schedule")).toBe("write");
  });

  it("gives every verb a title, so a consent card can name it", async () => {
    const descriptors = await vendoVerbsRegistry(ports()).descriptors();
    expect(descriptors.every((d) => typeof d.title === "string" && d.title.length > 0)).toBe(true);
  });

  it("validate returns the findings verbatim so the model can fix them", async () => {
    const registry = vendoVerbsRegistry(ports({
      validate: async () => ({
        ok: false as const,
        findings: [{ severity: "block", where: "node_2", message: "Unknown component Widget" }],
      }),
    }));

    const outcome = await registry.execute(call("validate", { appId: "app_1", document: "<Plan/>" }), ctx());

    expect(outcome).toEqual({
      status: "ok",
      output: { ok: false, findings: [{ severity: "block", where: "node_2", message: "Unknown component Widget" }] },
    });
  });

  it("validate reports a broken document as findings, NOT as a tool error", async () => {
    // A tool error reads to the model as "the tool is broken"; findings read as
    // "your document is wrong". Only the second one gets fixed.
    const registry = vendoVerbsRegistry(ports({
      validate: async () => ({ ok: false as const, findings: [{ severity: "block", message: "unparseable" }] }),
    }));
    const outcome = await registry.execute(call("validate", { document: "<<<" }), ctx());
    expect(outcome.status).toBe("ok");
  });

  it("search_components returns catalog entries in the shipped vocabulary", async () => {
    const outcome = await vendoVerbsRegistry(ports()).execute(
      call("search_components", { query: "chart" }),
      ctx(),
    );
    expect(outcome).toEqual({ status: "ok", output: { components: [{ component: "Chart", description: "A chart" }] } });
  });

  it("rejects a blank search rather than dumping the whole catalog", async () => {
    const outcome = await vendoVerbsRegistry(ports()).execute(call("search_components", { query: " " }), ctx());
    expect(outcome.status).toBe("error");
  });

  it("schedule passes the cron through and reports what was armed", async () => {
    const outcome = await vendoVerbsRegistry(ports()).execute(
      call("schedule", { appId: "app_1", cron: "0 8 * * *" }),
      ctx(),
    );
    expect(outcome).toEqual({ status: "ok", output: { scheduled: true, cron: "0 8 * * *" } });
  });

  it("treats an EMPTY validate request as a finding, not a pass (finding 15)", async () => {
    // validate({}) answering ok/no-findings told the model its app was fine when
    // nothing had been checked at all — the worst possible lie for a checker.
    const outcome = await vendoVerbsRegistry(ports()).execute(call("validate", {}), ctx());
    expect(outcome.status).toBe("error");
  });

  it("does not leak raw JS error text to the model when a port throws", async () => {
    const registry = vendoVerbsRegistry(ports({
      validate: async () => { throw new TypeError("Cannot read properties of undefined (reading 'nodes')"); },
    }));

    const outcome = await registry.execute(call("validate", { document: "<Plan/>" }), ctx());

    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("Cannot read properties");
    expect(JSON.stringify(outcome)).not.toContain("TypeError");
  });

  it("forwards a VendoError's own code and message — those are written for the model", async () => {
    // The ports raise authored, actionable refusals ("app X has no schedule to
    // change. Ask for the automation itself first…"). Flattening those into
    // "could not complete. Try again" tells the model to retry a call that can
    // never succeed. Masking is for the errors nobody wrote for a reader.
    const registry = vendoVerbsRegistry(ports({
      schedule: async () => {
        throw new VendoError("validation", "app app_1 has no schedule to change. Ask for the automation itself first.");
      },
    }));

    const outcome = await registry.execute(call("schedule", { appId: "app_1", cron: "0 8 * * *" }), ctx());

    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).toContain("Ask for the automation itself first");
    expect(JSON.stringify(outcome)).toContain("validation");
  });

  it("refuses an unknown verb instead of silently succeeding", async () => {
    const outcome = await vendoVerbsRegistry(ports()).execute(call("records_wipe", {}), ctx());
    expect(outcome.status).toBe("error");
  });

  it("turns a port failure into an honest tool error, without leaking the raw message", async () => {
    // This test previously asserted the port's raw text reached the model. The
    // verifier was right that that is a leak: internal error strings teach the
    // model nothing it can act on and put our internals in the transcript.
    const registry = vendoVerbsRegistry(ports({
      schedule: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); },
    }));
    const outcome = await registry.execute(call("schedule", { appId: "app_1", cron: "nonsense" }), ctx());
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(outcome)).toContain("schedule");
  });

  it("keeps every verb available in an unattended run — none of them is destructive", async () => {
    // Automations legitimately validate and schedule; the law withholds only
    // destructive and external work.
    const projected = await vendoVerbsRegistry(ports()).descriptors({ venue: "automation", presence: "away" });
    expect(projected.map((d) => d.name).sort()).toEqual([...VENDO_VERB_TOOLS].sort());
  });
});

describe("§3 consumer voice — the verbs' titles are the shared table's", () => {
  // A live browser proof caught the residual: `search_components` narrated
  // "Search components…" (its identifier prettified) because the CLIENT has no
  // descriptor, while the descriptor itself said "Look up available components".
  // One table, so the two surfaces cannot disagree.
  it("reads each title from core, and none of them is an identifier", async () => {
    const descriptors = await vendoVerbsRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.title)).toEqual([
      VENDO_TOOL_TITLES.validate,
      VENDO_TOOL_TITLES.search_components,
      VENDO_TOOL_TITLES.schedule,
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.title, descriptor.name).toBeTruthy();
      expect(descriptor.title, descriptor.name).not.toContain("_");
    }
  });
});
