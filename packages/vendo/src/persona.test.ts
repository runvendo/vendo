import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AuditEvent, Json, Persona, RunContext, ToolCall, ToolOutcome } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  MAX_PERSONA_FACTS,
  PERSONA_COLLECTION,
  createPersonaTools,
  distillPersona,
  emptyPersona,
  loadPersona,
  mergeFacts,
  rememberFact,
  savePersona,
  type PersonaFact,
} from "./persona/index.js";

const ctxFor = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: "session_test",
});

const call = (tool: string, args: Json = {}): ToolCall => ({ id: "call_test", tool, args });

const fact = (over: Partial<PersonaFact> = {}): PersonaFact => ({
  kind: "preference",
  text: "t",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const okOutput = (outcome: ToolOutcome): Json => {
  expect(outcome.status).toBe("ok");
  return (outcome as { status: "ok"; output: Json }).output;
};

const auditToolCall = (subject: string, tool: string, i: number) => {
  const event: AuditEvent = {
    id: `aud_${subject}_${tool}_${i}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    kind: "tool-call",
    principal: { kind: "user", subject },
    venue: "chat",
    presence: "present",
    tool,
    outcome: "ok",
  };
  return { id: event.id, data: event as unknown as Json, refs: { subject } };
};

const thread = (subject: string, id: string, texts: string[]) => ({
  id,
  data: {
    subject,
    messages: texts.map((text, i) => ({ id: `m_${i}`, role: "user", parts: [{ type: "text", text }] })),
  } as unknown as Json,
  refs: { subject },
});

describe("persona store", () => {
  it("round-trips a saved persona", async () => {
    const store = memoryStoreAdapter();
    await savePersona(store, { ...emptyPersona("user_1"), summary: "works in tables" });
    const loaded = await loadPersona(store, "user_1");
    expect(loaded?.summary).toBe("works in tables");
    expect(loaded?.subject).toBe("user_1");
  });

  it("returns null when no persona exists", async () => {
    const store = memoryStoreAdapter();
    expect(await loadPersona(store, "user_absent")).toBeNull();
  });

  it("tolerates a malformed row as null rather than throwing", async () => {
    const store = memoryStoreAdapter();
    await store.records(PERSONA_COLLECTION).put({ id: "user_1", data: { unexpected: true }, refs: { subject: "user_1" } });
    expect(await loadPersona(store, "user_1")).toBeNull();
  });

  it("refuses reserved subjects on read and write", async () => {
    const store = memoryStoreAdapter();
    await expect(loadPersona(store, "vendo:webhook:stripe")).rejects.toThrow();
    await expect(rememberFact(store, "vendo:webhook:stripe", { kind: "preference", text: "x" })).rejects.toThrow();
  });
});

describe("mergeFacts", () => {
  it("dedupes by kind and normalized text, newest wins", () => {
    const older = fact({ text: "Prefers Tables", updatedAt: "2026-01-01T00:00:00.000Z", evidence: "old" });
    const newer = fact({ text: "prefers tables", updatedAt: "2026-02-01T00:00:00.000Z", evidence: "new" });
    const merged = mergeFacts([older], [newer]);
    expect(merged).toHaveLength(1);
    expect(merged[0].evidence).toBe("new");
  });

  it("keeps different kinds with the same text apart", () => {
    const merged = mergeFacts([], [fact({ kind: "format", text: "same" }), fact({ kind: "domain", text: "same" })]);
    expect(merged).toHaveLength(2);
  });

  it("caps at MAX_PERSONA_FACTS, keeping the most recent", () => {
    const many = Array.from({ length: MAX_PERSONA_FACTS + 10 }, (_, i) =>
      fact({ text: `f_${i}`, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }),
    );
    const merged = mergeFacts([], many);
    expect(merged).toHaveLength(MAX_PERSONA_FACTS);
    expect(merged.some((entry) => entry.text === `f_${MAX_PERSONA_FACTS + 9}`)).toBe(true);
    expect(merged.some((entry) => entry.text === "f_0")).toBe(false);
  });
});

describe("persona tools", () => {
  it("loads null, then the persona after a remember", async () => {
    const tools = createPersonaTools(memoryStoreAdapter());
    const ctx = ctxFor("user_1");

    expect(okOutput(await tools.execute(call("vendo_persona_load"), ctx))).toBeNull();

    const wrote = await tools.execute(call("vendo_persona_remember", { kind: "preference", text: "Prefers brief answers" }), ctx);
    expect(wrote.status).toBe("ok");

    const loaded = okOutput(await tools.execute(call("vendo_persona_load"), ctx)) as Persona;
    expect(loaded.facts).toHaveLength(1);
    expect(loaded.facts[0].text).toBe("Prefers brief answers");
  });

  it("isolates personas by subject (invariant)", async () => {
    const store = memoryStoreAdapter();
    const tools = createPersonaTools(store);
    await tools.execute(call("vendo_persona_remember", { kind: "domain", text: "alice-only fact" }), ctxFor("alice"));
    expect(okOutput(await tools.execute(call("vendo_persona_load"), ctxFor("bob")))).toBeNull();
  });

  it("rejects an invalid fact kind", async () => {
    const tools = createPersonaTools(memoryStoreAdapter());
    const out = await tools.execute(call("vendo_persona_remember", { kind: "nonsense", text: "x" }), ctxFor("user_1"));
    expect(out.status).toBe("error");
  });

  it("rejects empty text", async () => {
    const tools = createPersonaTools(memoryStoreAdapter());
    const out = await tools.execute(call("vendo_persona_remember", { kind: "preference", text: "   " }), ctxFor("user_1"));
    expect(out.status).toBe("error");
  });

  it("declares read and write risk honestly", async () => {
    const descriptors = await createPersonaTools(memoryStoreAdapter()).descriptors();
    expect(descriptors.find((entry) => entry.name === "vendo_persona_load")?.risk).toBe("read");
    expect(descriptors.find((entry) => entry.name === "vendo_persona_remember")?.risk).toBe("write");
  });
});

describe("distillPersona", () => {
  it("distills top tools and format cues into a persona", async () => {
    const store = memoryStoreAdapter();
    const subject = "user_distill";
    for (let i = 0; i < 5; i += 1) await store.records("vendo_audit").put(auditToolCall(subject, "host_invoices_list", i));
    for (let i = 0; i < 2; i += 1) await store.records("vendo_audit").put(auditToolCall(subject, "host_customers_get", i));
    await store.records("vendo_threads").put(
      thread(subject, "thr_1", [
        "show me overdue invoices as a table",
        "give me that table again",
        "export the table to csv",
        "the table should include amounts",
      ]),
    );

    const persona = await distillPersona(store, subject);
    const kinds = persona.facts.map((entry) => entry.kind);
    expect(kinds).toContain("workflow");
    expect(kinds).toContain("format");
    expect(persona.facts.find((entry) => entry.kind === "workflow")?.text).toContain("host_invoices_list");
    expect(persona.summary.toLowerCase()).toContain("table");
    expect(persona.distilledFrom).toEqual({ threads: 1, auditEvents: 7 });
  });

  it("preserves a remembered fact across a distill pass", async () => {
    const store = memoryStoreAdapter();
    const subject = "user_merge";
    await rememberFact(store, subject, { kind: "preference", text: "Prefers brief answers" });
    await store.records("vendo_audit").put(auditToolCall(subject, "host_orders_list", 0));
    await store.records("vendo_audit").put(auditToolCall(subject, "host_orders_list", 1));
    const persona = await distillPersona(store, subject);
    expect(persona.facts.some((entry) => entry.text === "Prefers brief answers")).toBe(true);
    expect(persona.facts.some((entry) => entry.kind === "workflow")).toBe(true);
  });

  it("refuses to distill a reserved subject", async () => {
    await expect(distillPersona(memoryStoreAdapter(), "vendo:webhook:stripe")).rejects.toThrow();
  });
});
