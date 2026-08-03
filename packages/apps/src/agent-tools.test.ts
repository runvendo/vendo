import {
  TOOL_NAME_PATTERN,
  VENDO_APP_FORMAT,
  VENDO_TOOL_TITLES,
  toolDescriptorSchema,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { agentToolDescriptors } from "./agent-tools.js";
import { createApps } from "./index.js";
import {
  bindTools,
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
} from "./testing/index.js";
import { seedGrantRows, storeAccessFixture } from "./testing/app-access-fixture.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_tools" },
  venue: "chat",
  presence: "present",
  sessionId: "session_tools",
};

const hostTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const generated = '<App name="Tool-built dashboard"><Text text="Ready"/><Disclaimer reason="Fixture app."/></App>';

describe("apps agent tools", () => {
  it("exposes exactly provider-safe draft-2020-12 descriptors with closed object inputs", async () => {
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });

    const descriptors = await runtime.agentTools().descriptors();

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "vendo_apps_create",
      "vendo_apps_edit",
      "vendo_apps_rebase_pin",
      "vendo_apps_open",
      "vendo_apps_data_list",
      "vendo_apps_data_put",
      "vendo_apps_data_delete",
    ]);
    for (const descriptor of descriptors) {
      expect(TOOL_NAME_PATTERN.test(descriptor.name)).toBe(true);
      expect(toolDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(descriptor.inputSchema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(() => JSON.stringify(descriptor.inputSchema)).not.toThrow();
    }
    // Creating OR editing a document is a rung-1-only, jailed UI operation: it
    // cannot reach host tools, a server machine, or the network. Yousef's ruling
    // (2026-07-28): an app edit does not need approval — rearranging your own
    // view is not an act on the world, and history/undo are the safety net.
    expect(descriptors.map((descriptor) => descriptor.risk)).toEqual([
      "read", "read", "write", "read", "read", "write", "write",
    ]);
    expect(descriptors.find(({ name }) => name === "vendo_apps_edit")?.description).toMatch(/retry.*same app/i);
  });

  /**
   * Yousef's ruling (2026-07-28), verbatim: "no an app edit does not need
   * approval." So there is no contextual projection to make — the static
   * descriptor stands for every app call, malformed args and foreign ids alike
   * (ownership is enforced by the runtime, not by a consent prompt).
   */
  it("asks no approval for app self-mutation: no risk projection, on any shape of call", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    await seedAppRow(store, { ...created, id: "app_foreign" }, "user_other");

    for (const [id, args] of [
      ["call_null_edit", null],
      ["call_array_edit", []],
      ["call_primitive_edit", "invalid"],
      ["call_real_edit", { appId: created.id, instruction: "Make the heading blue" }],
      ["call_foreign_edit", { appId: "app_foreign", instruction: "Make the heading blue" }],
    ] as const) {
      await expect(runtime.agentToolRisk({ id, tool: "vendo_apps_edit", args }, ctx))
        .resolves.toBeUndefined();
    }
    // Creating one is the same act, and equally unprompted.
    await expect(runtime.agentToolRisk({
      id: "call_create",
      tool: "vendo_apps_create",
      args: { prompt: "Build a dashboard" },
    }, ctx)).resolves.toBeUndefined();

    // The ceremony still belongs on what an app DOES: writing and deleting the
    // app's own stored rows stay write-class on their own descriptors, untouched.
    const descriptors = await runtime.agentTools().descriptors();
    expect(descriptors.find(({ name }) => name === "vendo_apps_data_put")?.risk).toBe("write");
    expect(descriptors.find(({ name }) => name === "vendo_apps_data_delete")?.risk).toBe("write");
  });

  it("surfaces a structured retryable edit failure instead of implying the app changed", async () => {
    // An <Old> the printed app does not hold: the brain quoted text that is
    // missing, which is an error and never a guess.
    const broken = '<Edit><Old><Text text="missing card"/></Old><New><Text text="Renamed"/></New></Edit>';
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated, broken),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_edit_failure",
      tool: "vendo_apps_edit",
      args: { appId: created.id, instruction: "Change a missing card" },
    }, ctx);

    expect(outcome).toMatchObject({
      status: "ok",
      output: {
        app: created,
        failure: {
          code: "edit-rejected",
          retryable: true,
          message: expect.stringMatching(/same app/i),
        },
        issues: expect.arrayContaining([expect.stringContaining("missing")]),
      },
    });
  });

  it("creates and opens an app through the guard-bound fixture", async () => {
    const store = memoryStore();
    const guard = guardFixture();
    const runtime = createApps({
      store,
      guard,
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const bound = bindTools(guard, runtime.agentTools());

    const created = await bound.execute({
      id: "call_create",
      tool: "vendo_apps_create",
      args: { prompt: "Build a dashboard" },
    }, ctx);
    expect(created).toMatchObject({
      status: "ok",
      output: { id: expect.stringMatching(/^app_/), name: "Tool-built dashboard" },
    });
    if (created.status !== "ok" || typeof created.output !== "object" || created.output === null) {
      throw new Error("Expected a created app");
    }
    const appId = (created.output as { id: string }).id;
    expect(await runtime.get(appId, ctx)).not.toBeNull();

    await expect(bound.execute({
      id: "call_open",
      tool: "vendo_apps_open",
      args: { appId },
    }, ctx)).resolves.toMatchObject({ status: "ok", output: { kind: "tree" } });
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toHaveLength(2);
  });

  it("keeps the raw registry unbound while the umbrella wrapper blocks and audits", async () => {
    const store = memoryStore();
    const guard = guardFixture({ rules: { vendo_apps_create: "block" } });
    const runtime = createApps({
      store,
      guard,
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const call = {
      id: "call_unbound_create",
      tool: "vendo_apps_create",
      args: { prompt: "Build directly" },
    };

    await expect(runtime.agentTools().execute(call, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(await runtime.list(ctx)).toHaveLength(1);
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toEqual([]);

    await expect(bindTools(guard, runtime.agentTools()).execute({ ...call, id: "call_bound_create" }, ctx))
      .resolves.toEqual({ status: "blocked", reason: "Programmed block for vendo_apps_create" });
    expect(await runtime.list(ctx)).toHaveLength(1);
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toHaveLength(1);
  });

  it("contains runtime and input errors while preserving VendoError codes", async () => {
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const registry = runtime.agentTools();

    await expect(registry.execute({
      id: "call_missing",
      tool: "vendo_apps_open",
      args: { appId: "app_missing" },
    }, ctx)).resolves.toEqual({
      status: "error",
      error: { code: "not-found", message: "app not found: app_missing" },
    });
    await expect(registry.execute({
      id: "call_bad_input",
      tool: "vendo_apps_create",
      args: { prompt: "ok", extra: true },
    }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
    // The rebase tool routes through runtime.pins.rebase with the same
    // ownership scoping and contained VendoError codes as every other tool.
    await expect(registry.execute({
      id: "call_rebase_missing",
      tool: "vendo_apps_rebase_pin",
      args: { appId: "app_missing", slot: "net-worth-card" },
    }, ctx)).resolves.toEqual({
      status: "error",
      error: { code: "not-found", message: "app not found: app_missing" },
    });
    await expect(registry.execute({
      id: "call_rebase_bad_input",
      tool: "vendo_apps_rebase_pin",
      args: { appId: "app_missing" },
    }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
  });

  it("ownership-checks and round-trips declared data collections", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const created = await runtime.create({ prompt: "Data tools" }, ctx);
    await seedAppRow(store, {
      ...created,
      storage: { notes: { about: "Invoice notes", refs: { invoice_id: "host.invoice" } } },
    }, ctx.principal.subject);
    const registry = runtime.agentTools();

    await expect(registry.execute({
      id: "call_data_put",
      tool: "vendo_apps_data_put",
      args: {
        appId: created.id,
        collection: "notes",
        id: "note_1",
        data: { body: "hello" },
        refs: { invoice_id: "inv_1" },
      },
    }, ctx)).resolves.toMatchObject({ status: "ok", output: { id: "note_1" } });
    await expect(registry.execute({
      id: "call_data_list",
      tool: "vendo_apps_data_list",
      args: { appId: created.id, collection: "notes", refs: { invoice_id: "inv_1" } },
    }, ctx)).resolves.toMatchObject({
      status: "ok",
      output: { records: [{ id: "note_1", data: { body: "hello" } }] },
    });
    await expect(registry.execute({
      id: "call_data_delete",
      tool: "vendo_apps_data_delete",
      args: { appId: created.id, collection: "notes", id: "note_1" },
    }, ctx)).resolves.toEqual({ status: "ok", output: { status: "ok" } });

    await expect(registry.execute({
      id: "call_intruder_data_list",
      tool: "vendo_apps_data_list",
      args: { appId: created.id, collection: "notes" },
    }, {
      ...ctx,
      principal: { kind: "user", subject: "user_intruder" },
    })).resolves.toEqual({
      status: "error",
      error: { code: "not-found", message: `app not found: ${created.id}` },
    });
  });
});

describe("§9.4 — a refused EDIT hands the model the fork offer, not the raw code", () => {
  // The tool result was `{code:"forbidden", message:"editor access is required
  // for app_7c2f…"}` — an app id and a level name, which the model then relays
  // to a person. §9.4 invented `forbidden` for exactly this case BECAUSE it is
  // answerable: the caller provably sees the app, so "you can't" comes with
  // "…but here's what I can do".
  const setup = async (): Promise<{ tools: ToolRegistry; appId: string }> => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      appAccess: storeAccessFixture(store),
    });
    // Held by the org, with this caller a VIEWER — the one shape `forbidden`
    // is ever thrown for.
    await seedAppRow(store, { format: VENDO_APP_FORMAT, id: "app_teamdash", name: "Team dashboard" }, "acme");
    await seedGrantRows(store, "app_teamdash", { [`user:${ctx.principal.subject}`]: "viewer" });
    return { tools: runtime.agentTools(), appId: "app_teamdash" };
  };

  it("says what it can do instead, and names neither the app id nor the level", async () => {
    const { tools, appId } = await setup();
    const outcome = await tools.execute({
      id: "call_denied",
      tool: "vendo_apps_edit",
      args: { appId, instruction: "add last quarter" },
    }, { ...ctx, memberships: [{ org: "acme" }] });

    expect(outcome.status).toBe("error");
    const error = (outcome as { error: { code: string; message: string } }).error;
    // The CODE is machine-facing and stays exactly as the contract froze it.
    expect(error.code).toBe("forbidden");
    // The MESSAGE is what reaches a person through the model.
    expect(error.message).not.toContain(appId);
    expect(error.message).not.toMatch(/editor|access is required/i);
    expect(error.message).toMatch(/can’t change the team’s copy/i);
    expect(error.message).toMatch(/own copy/i);
  });

  it("leaves every other refusal exactly as it was", async () => {
    const { tools } = await setup();
    const outcome = await tools.execute({
      id: "call_missing",
      tool: "vendo_apps_edit",
      args: { appId: "app_absent", instruction: "anything" },
    }, ctx);
    expect(outcome).toEqual({
      status: "error",
      error: { code: "not-found", message: "app not found: app_absent" },
    });
  });
});

describe("§3 consumer voice — every apps tool carries a title", () => {
  // Wave-1 live proof E1-5: `title: descriptor.title ?? descriptor.name` means a
  // titleless tool hands the model its own identifier AS its human label, and
  // the model then says `vendo_apps_edit` to a person. Four of Vendo's twelve
  // projected tools had titles; these were the ones that did not.
  it("titles each descriptor from the shared table, in the consumer voice", () => {
    for (const descriptor of agentToolDescriptors) {
      expect(descriptor.title, descriptor.name).toBe(VENDO_TOOL_TITLES[descriptor.name]);
      expect(descriptor.title, descriptor.name).toBeTruthy();
      // The title is what a person reads; it must not be the identifier again.
      expect(descriptor.title, descriptor.name).not.toMatch(/vendo|_/i);
    }
  });
});
