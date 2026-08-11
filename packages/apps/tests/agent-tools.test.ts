import { engineOverAdapter } from "@vendoai/core";
import {
  TOOL_NAME_PATTERN,
  VENDO_APP_FORMAT,
  VENDO_TOOL_TITLES,
  toolDescriptorSchema,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type ScreenAssembler,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { agentToolDescriptors } from "../src/server/doors/agent-tools.js";
import { createApps, type AppsRuntime, type PlacementEntry } from "../src/server/index.js";
import { authoringAssembler, scriptedAssembler } from "../src/server/testing/authoring-assembler.js";
import { fakeBoxSandbox } from "../src/server/testing/fake-box.js";
import { bindTools, guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel, scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { seedGrantRows, storeAccessFixture } from "./app-access-fixture.js";

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
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });

    const descriptors = await runtime.agentTools().descriptors();

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "vendo_make",
      "vendo_apps_reseed",
      "vendo_apps_open",
      "vendo_apps_pin",
      "vendo_apps_unpin",
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
    // Making a document is a rung-1-only, jailed UI operation whichever way it
    // routes: it cannot reach host tools, a server machine, or the network.
    // Yousef's ruling (2026-07-28): an app edit does not need approval —
    // rearranging your own view is not an act on the world, and the history is
    // the safety net.
    expect(descriptors.map((descriptor) => descriptor.risk)).toEqual([
      "read", "write", "read", "write", "write", "read", "write", "write",
    ]);
    // The one-narrower-retry instruction survived the merge onto `vendo_make`:
    // without it the model's answer to a rejected change was to rebuild the app
    // from scratch.
    const make = descriptors.find(({ name }) => name === "vendo_make");
    expect(make?.description).toMatch(/try once more on the same/i);
    expect(make?.description).toMatch(/narrower/i);
    // And the routing rule the merge exists for: `app` is how a caller aims at
    // one existing app, never a "new or change?" decision it has to make first.
    expect(make?.description).toMatch(/Pass `app` only to change one specific existing app/);
    // An app holds a LIST of automations, and the planner has landed a second
    // one beside the first since #818. The description never said so, so the
    // model answered "I can't set two separate schedules on the same app" from
    // prior belief — without ever calling the tool that would have done it.
    expect(make?.description).toMatch(/hold SEVERAL automations/i);
    // Both doors that aim at an existing app say the same thing about the aim:
    // the id, or the name the person said. A model that only knows the name
    // reached for open() first and gave up there.
    expect(make?.description).toMatch(/its id, or its name/i);
    const open = descriptors.find(({ name }) => name === "vendo_apps_open");
    expect(open?.description).toMatch(/name/i);
  });

  /**
   * Yousef's ruling (2026-07-28), verbatim: "no an app edit does not need
   * approval." So there is no contextual projection to make — the static
   * descriptor stands for every app call, malformed args and foreign ids alike
   * (ownership is enforced by the runtime, not by a consent prompt).
   */
  it("asks no approval for app self-mutation: no risk projection, on any shape of call", async () => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    await seedAppRow(engineOverAdapter(store), { ...created, id: "app_foreign" }, "user_other");

    for (const [id, args] of [
      ["call_null_edit", null],
      ["call_array_edit", []],
      ["call_primitive_edit", "invalid"],
      ["call_real_edit", { app: created.id, request: "Make the heading blue" }],
      ["call_foreign_edit", { app: "app_foreign", request: "Make the heading blue" }],
    ] as const) {
      await expect(runtime.agentToolRisk({ id, tool: "vendo_make", args }, ctx))
        .resolves.toBeUndefined();
    }
    // Creating one is the same act through the same door, and equally unprompted.
    await expect(runtime.agentToolRisk({
      id: "call_create",
      tool: "vendo_make",
      args: { request: "Build a dashboard" },
    }, ctx)).resolves.toBeUndefined();

    // The ceremony still belongs on what an app DOES: writing and deleting the
    // app's own stored rows stay write-class on their own descriptors, untouched.
    const descriptors = await runtime.agentTools().descriptors();
    expect(descriptors.find(({ name }) => name === "vendo_apps_data_put")?.risk).toBe("write");
    expect(descriptors.find(({ name }) => name === "vendo_apps_data_delete")?.risk).toBe("write");
  });

  it("answers a rejected change with an honest failed receipt, never implying the app changed", async () => {
    // The change asks for something the assembler cannot make out of components
    // and cannot escalate either, so it comes back `unavailable`: nothing was
    // written, and the app stands exactly as it was.
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: scriptedAssembler(() => runtime, (_request, current) => (current === null
        ? generated
        : { kind: "unavailable", why: "there is no card by that name on this app" })),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_edit_failure",
      tool: "vendo_make",
      args: { app: created.id, request: "Change a missing card" },
    }, ctx);

    // An OK outcome — a rejected change is an answer, not a broken tool — whose
    // receipt says "failed" in words the agent can utter. The structured detail
    // (issues, the retry code) stays server-side: what the model needs is one
    // true sentence and the id to retry against.
    expect(outcome).toEqual({
      status: "ok",
      output: {
        id: created.id,
        title: created.name,
        status: "failed",
        say: expect.stringMatching(/couldn't make that change/i),
      },
    });
  });

  it("aims `app` by NAME as well as by id, so a fresh thread can reach the app the user named", async () => {
    // A fresh-thread agent hears "add a weekly one to the transactions app" and
    // holds no id: `vendo_apps_open` takes an id, and nothing lists or searches.
    // The whole ask died there. The `app` slot already carries the aim, so it
    // takes the name the person says out loud too.
    const store = memoryStore();
    const updated = '<App name="Tool-built dashboard"><Text text="Updated"/><Disclaimer reason="Fixture app."/></App>';
    let runtime: AppsRuntime;
    runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: scriptedAssembler(() => runtime, (_request, current) => (current === null ? generated : updated)),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    expect(created.name).toBe("Tool-built dashboard");

    const outcome = await runtime.agentTools().execute({
      id: "call_edit_by_name",
      tool: "vendo_make",
      // Said the way a person says it — including the case they used.
      args: { app: "tool-BUILT dashboard", request: "Say Updated instead" },
    }, ctx);

    expect(outcome).toMatchObject({
      status: "ok",
      output: { id: created.id, title: created.name, status: "ready" },
    });
  });

  it("asks which one when a name matches two apps, and changes neither", async () => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    const first = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    const second = await runtime.create({ prompt: "Build another dashboard" }, ctx);
    expect(first.id).not.toBe(second.id);

    const outcome = await runtime.agentTools().execute({
      id: "call_edit_ambiguous",
      tool: "vendo_make",
      args: { app: "Tool-built dashboard", request: "Say Updated instead" },
    }, ctx);

    // Never a guess: the answer names the candidates so the model can ask.
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.message).toContain("Tool-built dashboard");
    expect(outcome.error.message).toContain(first.id);
    expect(outcome.error.message).toContain(second.id);
  });

  it("OPENS by name too — the door a model reaches for first when it holds no id", async () => {
    // The walk: asked for "my transactions app", the model's first move was
    // `vendo_apps_open`, which took a raw id. It burned its attempts there and
    // concluded the app did not exist, while an exact name match sat in the
    // caller's own list. Both doors take the same aim or neither does.
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    await expect(runtime.agentTools().execute({
      id: "call_open_by_name",
      tool: "vendo_apps_open",
      args: { appId: "tool-BUILT dashboard" },
    }, ctx)).resolves.toMatchObject({ status: "ok", output: { kind: "tree" } });
    expect(created.name).toBe("Tool-built dashboard");
  });

  it("asks which one when the name it was asked to open matches two apps", async () => {
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    const first = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    const second = await runtime.create({ prompt: "Build another dashboard" }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_open_ambiguous",
      tool: "vendo_apps_open",
      args: { appId: "Tool-built dashboard" },
    }, ctx);

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.message).toContain(first.id);
    expect(outcome.error.message).toContain(second.id);
  });

  it("leaves an id that resolves to nothing exactly as it was: the runtime's own answer", async () => {
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });

    const outcome = await runtime.agentTools().execute({
      id: "call_edit_missing",
      tool: "vendo_make",
      args: { app: "app_not_here", request: "Say Updated instead" },
    }, ctx);

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.code).toBe("not-found");
  });

  it("creates and opens an app through the guard-bound fixture", async () => {
    const store = memoryStore();
    const guard = guardFixture();
    const runtime: AppsRuntime = createApps({
      store,
      guard,
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    const bound = bindTools(guard, runtime.agentTools());

    const created = await bound.execute({
      id: "call_create",
      tool: "vendo_make",
      args: { request: "Build a dashboard" },
    }, ctx);
    expect(created).toMatchObject({
      status: "ok",
      output: {
        id: expect.stringMatching(/^app_/),
        title: "Tool-built dashboard",
        status: "ready",
        say: expect.stringMatching(/on your screen/i),
      },
    });
    if (created.status !== "ok" || typeof created.output !== "object" || created.output === null) {
      throw new Error("Expected a created app");
    }
    // Contract §3.1, and the whole reason the receipt exists: the document does
    // NOT travel. A model handed a tree will eventually describe the tree, so
    // pixels go server → slot and the agent only ever gets words.
    expect(Object.keys(created.output as Record<string, unknown>).sort())
      .toEqual(["id", "say", "status", "title"]);
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
    const guard = guardFixture({ rules: { vendo_make: "block" } });
    const runtime: AppsRuntime = createApps({
      store,
      guard,
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    const call = {
      id: "call_unbound_create",
      tool: "vendo_make",
      args: { request: "Build directly" },
    };

    await expect(runtime.agentTools().execute(call, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(await runtime.list(ctx)).toHaveLength(1);
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toEqual([]);

    await expect(bindTools(guard, runtime.agentTools()).execute({ ...call, id: "call_bound_create" }, ctx))
      .resolves.toEqual({ status: "blocked", reason: "Programmed block for vendo_make" });
    expect(await runtime.list(ctx)).toHaveLength(1);
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toHaveLength(1);
  });

  it("contains runtime and input errors while preserving VendoError codes", async () => {
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
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
      tool: "vendo_make",
      args: { request: "ok", extra: true },
    }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
    // The re-seed tool routes through runtime.seed.reseed with the same
    // ownership scoping and contained VendoError codes as every other tool.
    await expect(registry.execute({
      id: "call_reseed_missing",
      tool: "vendo_apps_reseed",
      args: { appId: "app_missing" },
    }, ctx)).resolves.toEqual({
      status: "error",
      error: { code: "not-found", message: "app not found: app_missing" },
    });
    await expect(registry.execute({
      id: "call_reseed_bad_input",
      tool: "vendo_apps_reseed",
      args: {},
    }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
  });

  it("ownership-checks and round-trips declared data collections", async () => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    const created = await runtime.create({ prompt: "Data tools" }, ctx);
    await seedAppRow(engineOverAdapter(store), {
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

describe("§9.4 — a refused EDIT hands the model the FACTS, not the raw code", () => {
  // The tool result was `{code:"forbidden", message:"editor access is required
  // for app_7c2f…"}` — an app id and a level name, which the model then relays
  // to a person. §9.4 invented `forbidden` for exactly this case BECAUSE it is
  // answerable: the caller provably sees the app, so "it did not happen" comes
  // with why, and with the way through.
  const setup = async (): Promise<{ tools: ToolRegistry; appId: string }> => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
      appAccess: storeAccessFixture(store),
    });
    // Held by the org, with this caller a VIEWER — the one shape `forbidden`
    // is ever thrown for.
    await seedAppRow(engineOverAdapter(store), { format: VENDO_APP_FORMAT, id: "app_teamdash", name: "Team dashboard" }, "acme");
    await seedGrantRows(store, "app_teamdash", { [`user:${ctx.principal.subject}`]: "viewer" });
    return { tools: runtime.agentTools(), appId: "app_teamdash" };
  };

  it("states the three facts, and names neither the app id nor the level", async () => {
    const { tools, appId } = await setup();
    const outcome = await tools.execute({
      id: "call_denied",
      tool: "vendo_make",
      args: { app: appId, request: "add last quarter" },
    }, { ...ctx, memberships: [{ org: "acme" }] });

    expect(outcome.status).toBe("error");
    const error = (outcome as { error: { code: string; message: string } }).error;
    // The CODE is machine-facing and stays exactly as the contract froze it.
    expect(error.code).toBe("forbidden");
    // The MESSAGE is what reaches a person through the model, and it is FACTS
    // rather than a script: the first-person sentence with stage directions ("I
    // can't change the team's copy… say so plainly, and offer them…") put our
    // words in the model's mouth. The three facts, all three asserted, because
    // dropping any one of them is what makes a model invent the rest.
    expect(error.message).not.toContain(appId);
    expect(error.message).not.toMatch(/editor|access is required/i);
    expect(error.message).toMatch(/The change was not made/);
    expect(error.message).toMatch(/team's copy of the app and this user has read-only access/i);
    expect(error.message).toMatch(/A copy of their own would be theirs to change/i);
    // Including the fact that stops a model promising a fork it has no tool for.
    expect(error.message).toMatch(/there is no fork tool here/i);
  });

  it("leaves every other refusal exactly as it was", async () => {
    const { tools } = await setup();
    const outcome = await tools.execute({
      id: "call_missing",
      tool: "vendo_make",
      args: { app: "app_absent", request: "anything" },
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

describe("vendo_make — the slot a new app lands in", () => {
  /** The front door with one answer or another behind the seam. `self` is the
   *  same compose-time knot `packages/vendo` ties: the assembler writes through
   *  the runtime that composing returns. */
  const assemblingWith = (screen: (self: () => AppsRuntime) => ScreenAssembler): AppsRuntime => {
    const runtime: AppsRuntime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: screen(() => runtime),
    });
    return runtime;
  };

  /** The ASSEMBLY engine — the one that serves most asks. `authoringAssembler`
   *  compiles with core's own compiler and lands the row through
   *  `runtime.authored`, which is the shipped write path, not a stub. */
  const assembling = (): AppsRuntime =>
    assemblingWith((self) => authoringAssembler(self, generated));

  /** The BUILDER engine — assembly escalates and this deployment has somewhere
   *  to build. Same front door, same minted id, a different engine behind it,
   *  which is exactly why the placement is asserted on both. */
  const escalating = (): AppsRuntime => createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools: hostTools,
    catalog: [],
    model: basicLanguageModel(),
    machine: { sandbox: fakeBoxSandbox(), buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 },
    screen: { async assemble() { return { kind: "escalate", why: "this needs real code" }; } },
  });

  it("takes request, app, context and slot — request required, nothing else allowed", async () => {
    const descriptors = await assembling().agentTools().descriptors();
    const schema = descriptors.find(({ name }) => name === "vendo_make")!.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(Object.keys(schema.properties).sort()).toEqual(["app", "context", "request", "slot"]);
    expect(schema.required).toEqual(["request"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("lands an ASSEMBLED screen in the slot the caller aimed at", async () => {
    // The SEAM, not a stub on either side: the tool writes through the real
    // assembly path, and the assertion reads back through the runtime's real
    // placements path. Nothing here knows how a placement row is stored.
    const runtime = assembling();

    const outcome = await runtime.agentTools().execute({
      id: "call_make_slot",
      tool: "vendo_make",
      args: { request: "my spending this month", slot: "dashboard.hero" },
    }, ctx);

    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string; status: string } }).output;
    expect(receipt.status).toBe("ready");
    expect(await runtime.placements({}, ctx)).toEqual([
      expect.objectContaining({ slot: "dashboard.hero", app: receipt.id, status: "ready" }),
    ]);
  });

  it("claims the slot at MINT, so the slot shows the build while assembly is still running", async () => {
    // B1 on the FAST engine. The row used to go down only after assembly
    // RETURNED, so a slot the person was already looking at stayed empty for the
    // whole of the make and the skeleton it exists to show never appeared. The
    // reading is taken from inside the assembler, mid-flight, through the
    // runtime's own placements path.
    let inFlight: PlacementEntry[] = [];
    const runtime = assemblingWith((self) => ({
      async assemble(request, runCtx) {
        inFlight = await self().placements({}, runCtx);
        return authoringAssembler(self, generated).assemble(request, runCtx);
      },
    }));

    const outcome = await runtime.agentTools().execute({
      id: "call_make_slot_inflight",
      tool: "vendo_make",
      args: { request: "my spending this month", slot: "dashboard.hero" },
    }, ctx);

    const receipt = (outcome as { output: { id: string } }).output;
    expect(inFlight).toEqual([
      { slot: "dashboard.hero", app: receipt.id, title: "", status: "building" },
    ]);
    // The same row, unmoved, is what goes READY when assembly lands.
    expect(await runtime.placements({}, ctx)).toEqual([
      expect.objectContaining({ slot: "dashboard.hero", app: receipt.id, status: "ready" }),
    ]);
  });

  it("leaves the honest failure IN the slot when assembly fails terminally", async () => {
    // B1's other half. A make that died in assembly wrote no row at all, so the
    // slot showed nothing and the failure lived only in the conversation.
    const runtime = assemblingWith(() => ({
      async assemble() { return { kind: "unavailable", why: "the screen agent is down" }; },
    }));

    const outcome = await runtime.agentTools().execute({
      id: "call_make_slot_failed",
      tool: "vendo_make",
      args: { request: "my spending this month", slot: "dashboard.hero" },
    }, ctx);

    const receipt = (outcome as { output: { id: string; status: string; title: string } }).output;
    expect(receipt.status).toBe("failed");
    // FAILED now, read back through the real placements path — not a skeleton
    // that only ages into a failure once the build window elapses.
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "dashboard.hero", app: receipt.id, title: receipt.title, status: "failed" },
    ]);
    // The terminal record is a tombstone, exactly as a failed build's is: it
    // answers the slot and never joins the user's apps.
    expect(await runtime.list(ctx)).toEqual([]);
    // Dismiss = unplace, and it leaves nothing behind.
    await runtime.unplace({ app: receipt.id, slot: "dashboard.hero" }, ctx);
    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("lands an ESCALATED build in it too — one front door, two engines, one row", async () => {
    // The engine the ask is routed to is Vendo's decision, never the caller's.
    // If only one of the two left a row, `slot` would be a coin toss the caller
    // cannot see — and it would have shipped green, because each engine has its
    // own tests.
    const runtime = escalating();

    const outcome = await runtime.agentTools().execute({
      id: "call_make_slot_built",
      tool: "vendo_make",
      args: { request: "match my invoices to payments", slot: "dashboard.hero" },
    }, ctx);

    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string; status: string } }).output;
    expect(receipt.status).toBe("ready");
    expect(await runtime.placements({}, ctx)).toEqual([
      expect.objectContaining({ slot: "dashboard.hero", app: receipt.id }),
    ]);
  });

  it("leaves no placement at all when no slot was named", async () => {
    const runtime = assembling();

    await runtime.agentTools().execute({
      id: "call_make_no_slot",
      tool: "vendo_make",
      args: { request: "my spending this month" },
    }, ctx);

    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("refuses a slot on a CHANGE, and names the tool that does move an app", async () => {
    // Silently ignoring it would be worse, and silently PLACING it would evict
    // whatever holds that slot off the back of an edit nobody aimed there.
    const runtime = assembling();
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_edit_slot",
      tool: "vendo_make",
      args: { app: created.id, request: "Make the heading blue", slot: "dashboard.hero" },
    }, ctx);

    expect(outcome).toEqual({
      status: "error",
      error: {
        code: "validation",
        message: expect.stringContaining("vendo_apps_pin") as unknown as string,
      },
    });
  });

  it("refuses an empty slot string", async () => {
    const outcome = await assembling().agentTools().execute({
      id: "call_make_blank_slot",
      tool: "vendo_make",
      args: { request: "my spending", slot: "  " },
    }, ctx);

    expect(outcome).toEqual({
      status: "error",
      error: { code: "validation", message: "slot must be a non-empty string" },
    });
  });
});

describe("vendo_apps_pin / vendo_apps_unpin — putting an app on the page", () => {
  // These two tools only ever move an app that already exists, so the assembler
  // is here only to make one: there is ONE engine, and `create` starts at
  // assembly for every caller.
  const makeRuntime = (): AppsRuntime => {
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    return runtime;
  };

  it("takes exactly app and slot, both required", async () => {
    const descriptors = await makeRuntime().agentTools().descriptors();

    for (const name of ["vendo_apps_pin", "vendo_apps_unpin"]) {
      const schema = descriptors.find((descriptor) => descriptor.name === name)!.inputSchema as {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(Object.keys(schema.properties).sort(), name).toEqual(["app", "slot"]);
      expect(schema.required.slice().sort(), name).toEqual(["app", "slot"]);
      expect(schema.additionalProperties, name).toBe(false);
    }
  });

  it("pins an existing app into a slot, and the placement reads back", async () => {
    const runtime = makeRuntime();
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_pin",
      tool: "vendo_apps_pin",
      args: { app: created.id, slot: "dashboard.hero" },
    }, ctx);

    expect(outcome).toEqual({ status: "ok", output: { app: created.id, slot: "dashboard.hero" } });
    expect(await runtime.placements({}, ctx)).toEqual([
      expect.objectContaining({ slot: "dashboard.hero", app: created.id }),
    ]);
  });

  it("names what it replaced, so the model can say so", async () => {
    const runtime = makeRuntime();
    const first = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    const second = await runtime.create({ prompt: "Build a second dashboard" }, ctx);
    await runtime.agentTools().execute({
      id: "call_pin_first",
      tool: "vendo_apps_pin",
      args: { app: first.id, slot: "dashboard.hero" },
    }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_pin_second",
      tool: "vendo_apps_pin",
      args: { app: second.id, slot: "dashboard.hero" },
    }, ctx);

    expect(outcome).toEqual({
      status: "ok",
      output: { app: second.id, slot: "dashboard.hero", evicted: first.id },
    });
    expect(await runtime.placements({}, ctx)).toEqual([
      expect.objectContaining({ slot: "dashboard.hero", app: second.id }),
    ]);
  });

  it("aims by the NAME the user said, not only by id", async () => {
    const runtime = makeRuntime();
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_pin_by_name",
      tool: "vendo_apps_pin",
      args: { app: created.name, slot: "dashboard.hero" },
    }, ctx);

    expect(outcome).toEqual({ status: "ok", output: { app: created.id, slot: "dashboard.hero" } });
  });

  it("unpins, leaving the app itself alone", async () => {
    const runtime = makeRuntime();
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    await runtime.agentTools().execute({
      id: "call_pin_before_unpin",
      tool: "vendo_apps_pin",
      args: { app: created.id, slot: "dashboard.hero" },
    }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_unpin",
      tool: "vendo_apps_unpin",
      args: { app: created.id, slot: "dashboard.hero" },
    }, ctx);

    expect(outcome).toEqual({ status: "ok", output: { app: created.id, slot: "dashboard.hero" } });
    expect(await runtime.placements({}, ctx)).toEqual([]);
    // The app is still the user's; only its place on the page is gone.
    expect((await runtime.list(ctx)).map((app) => app.id)).toContain(created.id);
  });

  it("refuses a missing slot", async () => {
    const runtime = makeRuntime();
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    expect(await runtime.agentTools().execute({
      id: "call_pin_no_slot",
      tool: "vendo_apps_pin",
      args: { app: created.id },
    }, ctx)).toEqual({
      status: "error",
      error: { code: "validation", message: "slot must be a non-empty string" },
    });
  });
});
