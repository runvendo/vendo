import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import type { AuditEvent, ToolRegistry } from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import { defineHarness, harnessAdapters } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent, e2b, postgres, provideCloudAdapters, withDefaultTemplate } from "../src/agent.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-test-${stores++}` });

const inert = () =>
  defineHarness({
    name: "inert",
    async *run() {},
  });

const boxy = () =>
  defineHarness({
    name: "boxy",
    requires: { sandbox: true },
    async *run() {},
  });

const fakeSandbox = (): SandboxAdapter & { created: unknown[] } => {
  const created: unknown[] = [];
  const machine = {
    id: "box_1",
    request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    url: async () => "http://box",
    snapshot: async () => "fake:snap",
    stop: async () => {},
    destroy: async () => {},
  } as Omit<SandboxMachine, "files"> as SandboxMachine;
  return {
    created,
    async create(spec) {
      created.push(spec);
      return machine;
    },
    resume: async () => machine,
    destroy: async () => {},
  };
};

const fakeGuard = (): VendoGuard & { reports: AuditEvent[]; bound: ToolRegistry[] } => {
  const reports: AuditEvent[] = [];
  const bound: ToolRegistry[] = [];
  return {
    reports,
    bound,
    check: async () => ({ action: "run", decidedBy: "default" }),
    report: async (event) => {
      reports.push(event);
    },
    directions: async () => [],
    onApprovalDecision: () => () => {},
    onApprovalRequested: () => () => {},
    bind(tools) {
      bound.push(tools);
      return tools;
    },
    approvals: { pending: async () => [], decide: async () => {}, revoke: async () => {} } as Omit<VendoGuard["approvals"], "parkedCallTtlMs"> as VendoGuard["approvals"],
    freeze: async () => {},
    unfreeze: async () => {},
    frozen: async () => false,
    grants: { list: async () => [], revoke: async () => {} },
    audit: { query: async () => ({ events: [] }), export: async function* () {} },
    status: () => ({ posture: "unconfigured" }),
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
  provideCloudAdapters({ store: undefined, sandbox: undefined });
});

describe("agent() boot", () => {
  it("requires a name and a harness", () => {
    expect(() => agent({ name: " ", harness: inert(), store: memoryStore() })).toThrow(/name/);
    // @ts-expect-error — the missing harness is the point
    expect(() => agent({ name: "support", store: memoryStore() })).toThrow(/harness/);
  });

  it("an explicit guard wins and receives the merged registry to bind", () => {
    const guard = fakeGuard();
    agent({ name: "support", harness: inert(), store: memoryStore(), guard });
    expect(guard.bound).toHaveLength(1);
  });

  it("two tools claiming one name is a boot error", () => {
    const same = { name: "x", inputSchema: { type: "object" as const }, execute: () => ({}) };
    expect(() =>
      agent({ name: "support", harness: inert(), store: memoryStore(), tools: [tool(same), tool(same)] }),
    ).toThrow(/claim the name/);
  });
});

describe("the sandbox ladder", () => {
  it("an explicit adapter always wins and is injected on the harness", () => {
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    const harness = boxy();
    const sandbox = fakeSandbox();
    agent({ name: "support", harness, store: memoryStore(), guard: fakeGuard(), sandbox });
    expect(harnessAdapters(harness).sandbox).toBeDefined();
  });

  it("E2B_API_KEY fills the slot when nothing was passed", () => {
    vi.stubEnv("VENDO_API_KEY", "");
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    const harness = boxy();
    agent({ name: "support", harness, store: memoryStore(), guard: fakeGuard() });
    expect(harnessAdapters(harness).sandbox).toBeDefined();
  });

  it("a VENDO_API_KEY reaches the Cloud rung — unwired, that is a clear error", () => {
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    expect(() => agent({ name: "support", harness: boxy(), store: memoryStore(), guard: fakeGuard() }))
      .toThrow(/Cloud sandbox rung/);
  });

  it("the Cloud rung resolves through the provided interface", () => {
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    const sandbox = fakeSandbox();
    provideCloudAdapters({ sandbox: () => sandbox });
    const harness = boxy();
    agent({ name: "support", harness, store: memoryStore(), guard: fakeGuard() });
    expect(harnessAdapters(harness).sandbox).toBeDefined();
  });

  it("no rung answering is a boot error with every way out named", () => {
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "");
    expect(() => agent({ name: "support", harness: boxy(), store: memoryStore(), guard: fakeGuard() }))
      .toThrow(/e2b|E2B_API_KEY|VENDO_API_KEY/);
  });

  it("a harness that thinks in-process never resolves a sandbox", () => {
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "");
    expect(() => agent({ name: "support", harness: inert(), store: memoryStore(), guard: fakeGuard() }))
      .not.toThrow();
  });
});

describe("the store ladder", () => {
  it("a VENDO_API_KEY with no Cloud store rung wired is a clear error, not a silent fallback", () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    expect(() => agent({ name: "support", harness: inert(), guard: fakeGuard() }))
      .toThrow(/Cloud store rung/);
  });

  it("the Cloud rung is an interface that returns a store", () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    const store = memoryStore();
    provideCloudAdapters({ store: () => store });
    expect(() => agent({ name: "support", harness: inert(), guard: fakeGuard() })).not.toThrow();
  });
});

describe("egress at box boot", () => {
  it("writes ONE audit row per box boot with the effective skin", async () => {
    const guard = fakeGuard();
    const harness = boxy();
    const sandbox = fakeSandbox();
    agent({
      name: "support",
      harness,
      store: memoryStore(),
      guard,
      sandbox,
      egress: ["api.stripe.com"],
    });
    const injected = harnessAdapters(harness).sandbox as SandboxAdapter;
    await injected.create({ env: {}, allowedDomains: ["api.anthropic.com"] });
    expect(guard.reports).toHaveLength(1);
    expect(guard.reports[0]?.detail).toEqual({ egress: ["api.anthropic.com", "api.stripe.com"] });
    expect(guard.reports[0]?.principal.subject).toBe("vendo:agent:support");
    expect(sandbox.created[0]).toMatchObject({ allowedDomains: ["api.anthropic.com", "api.stripe.com"] });
  });

  it("'all' boots the box unrestricted and says so in the row", async () => {
    const guard = fakeGuard();
    const harness = boxy();
    const sandbox = fakeSandbox();
    agent({ name: "support", harness, store: memoryStore(), guard, sandbox, egress: "all" });
    const injected = harnessAdapters(harness).sandbox as SandboxAdapter;
    await injected.create({ env: {}, allowedDomains: ["api.anthropic.com"] });
    expect(guard.reports[0]?.detail).toEqual({ egress: "all" });
    expect(sandbox.created[0]).not.toHaveProperty("allowedDomains");
  });
});

describe("store and sandbox factories", () => {
  it("a template default seeds the box only when the harness names none", async () => {
    const inner = fakeSandbox();
    const adapter = withDefaultTemplate(inner, "support-box");
    await adapter.create({ env: {} });
    await adapter.create({ env: {}, template: "explicit" });
    expect(inner.created).toEqual([
      { env: {}, template: "support-box" },
      { env: {}, template: "explicit" },
    ]);
  });

  it("e2b() returns an adapter (template composed in when given)", () => {
    expect(e2b({ apiKey: "e2b_test" }).create).toBeTypeOf("function");
    expect(e2b({ apiKey: "e2b_test", template: "support-box" }).create).toBeTypeOf("function");
  });

  it("postgres() refuses a missing url the way the store does", () => {
    expect(() => postgres("")).toThrow();
  });
});
