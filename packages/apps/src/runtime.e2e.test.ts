import {
  VENDO_APP_FORMAT,
  descriptorHash,
  type AppDocument,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { createApps } from "./index.js";
import {
  basicLanguageModel,
  bindTools,
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

/**
 * E2E of ownership/interchange authority (06-apps §7, 01-core §10), the state
 * singleton (06-apps §6), and the tool-proxy capability axis (06-apps §4.4),
 * exercised through the public createApps surface. Real neighbors are the in-repo
 * core seam implementations (the layer apps may compose with); persisted side
 * effects are asserted through the store seam (vendo_apps + vendo_state rows).
 */

const ctx = (subject: string, presence: RunContext["presence"] = "present"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence,
  sessionId: `session_${subject}`,
});

const encoder = new TextEncoder();
const json = async (response: Response): Promise<unknown> => response.json() as Promise<unknown>;

const treeApp = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: name } }],
  },
});

const inertTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

describe("interchange authority (e2e)", () => {
  it("mints a fresh id for a doctored artifact claiming a victim's app id (no takeover)", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: inertTools, catalog: [] });

    // The victim owns app_victim.
    const victim = treeApp("app_victim", "Victim App");
    await seedAppRow(store, victim, "user_victim", true);

    // An attacker imports an artifact whose embedded id claims the victim's app.
    const doctored = treeApp("app_victim", "Attacker Payload");
    const imported = await runtime.importApp(doctored, ctx("user_attacker"));

    // The claimed id is never trusted: a fresh id is minted and the copy belongs to the attacker.
    expect(imported.id).not.toBe("app_victim");
    expect(imported.id).toMatch(/^app_/);
    expect(imported.name).toBe("Attacker Payload");

    // The victim's row is byte-for-byte intact and still owned by the victim.
    const victimRow = await store.records("vendo_apps").get("app_victim");
    expect((victimRow?.data as { subject: string }).subject).toBe("user_victim");
    expect((victimRow?.data as { doc: AppDocument }).doc).toEqual(victim);
    expect(await runtime.get("app_victim", ctx("user_victim"))).toEqual(victim);

    // The attacker cannot reach the victim's app at all (cross-subject → not found).
    expect(await runtime.get("app_victim", ctx("user_attacker"))).toBeNull();
  });

  it("mints a fresh id for a doctored .vendoapp archive claiming a victim's app id", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: inertTools, catalog: [] });
    await seedAppRow(store, treeApp("app_target", "Target"), "user_target", true);

    // A hand-built archive whose app.json even carries the victim id inside the document body.
    const archive = zipSync({
      "app.json": encoder.encode(JSON.stringify({ ...treeApp("app_target", "Smuggled"), id: "app_target" })),
    });
    const imported = await runtime.importApp(archive, ctx("user_attacker"));

    expect(imported.id).not.toBe("app_target");
    expect(await runtime.get("app_target", ctx("user_attacker"))).toBeNull();
    expect((await runtime.get("app_target", ctx("user_target")))?.name).toBe("Target");
  });
});

describe("state singleton isolation (e2e)", () => {
  const openHttp = async (
    runtime: ReturnType<typeof createApps>,
    store: ReturnType<typeof memoryStore>,
    sandbox: ReturnType<typeof fakeSandbox>,
    subject: string,
  ): Promise<{ appId: string; token: string }> => {
    const app = treeApp(`app_${subject}`, subject);
    await seedAppRow(store, { ...app, ui: "http" }, subject);
    const before = sandbox.machines.size;
    await runtime.open(app.id, ctx(subject));
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(before + 1));
    const machine = [...sandbox.machines.values()].at(-1)!;
    return { appId: app.id, token: machine.env.VENDO_RUN_TOKEN as string };
  };

  it("keeps per-user-per-app state fully isolated through the $state proxy hook", async () => {
    const store = memoryStore();
    const sandbox = fakeSandbox();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: inertTools,
      sandbox,
      proxyUrl: "https://proxy.test",
      catalog: [],
      model: basicLanguageModel(),
    });

    const ada = await openHttp(runtime, store, sandbox, "user_ada");
    const grace = await openHttp(runtime, store, sandbox, "user_grace");

    const put = (token: string, body: unknown) => runtime.proxy.handler(new Request("https://proxy.test/state", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const get = (token: string) => runtime.proxy.handler(new Request("https://proxy.test/state", {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect((await put(ada.token, { owner: "ada" })).status).toBe(200);
    expect((await put(grace.token, { owner: "grace" })).status).toBe(200);

    // Each principal's $state singleton is its own row, keyed (appId, subject).
    expect(await json(await get(ada.token))).toEqual({ owner: "ada" });
    expect(await json(await get(grace.token))).toEqual({ owner: "grace" });
    expect(await store.records("vendo_state").get(`${ada.appId}:user_ada`)).toMatchObject({ data: { owner: "ada" } });
    expect(await store.records("vendo_state").get(`${grace.appId}:user_grace`)).toMatchObject({ data: { owner: "grace" } });

    // A foreign subject's row on the SAME app id never leaks back to the owner's read.
    await store.records("vendo_state").put({
      id: `${ada.appId}:user_intruder`,
      data: { owner: "intruder" },
      refs: { subject: "user_intruder", app_id: ada.appId },
    });
    expect(await json(await get(ada.token))).toEqual({ owner: "ada" });
  });
});

describe("tool proxy authority (e2e)", () => {
  it("scopes the run token to away presence and reaches only the guard-bound registry", async () => {
    const descriptors: ToolDescriptor[] = [
      { name: "host_read", description: "Read", inputSchema: { type: "object" }, risk: "read" },
      { name: "host_park", description: "Needs approval", inputSchema: { type: "object" }, risk: "write" },
      { name: "host_forbidden", description: "Blocked", inputSchema: { type: "object" }, risk: "destructive" },
    ];
    const rawTools: ToolRegistry = {
      async descriptors() { return descriptors; },
      async execute(call, runCtx) { return { status: "ok", output: { tool: call.tool, presence: runCtx.presence, appId: runCtx.appId } }; },
    };
    const guard = guardFixture({ rules: { host_park: "ask", host_forbidden: "block" } });
    const store = memoryStore();
    const sandbox = fakeSandbox();
    const runtime = createApps({
      store,
      guard,
      tools: bindTools(guard, rawTools),
      sandbox,
      proxyUrl: "https://proxy.test",
      catalog: [],
      model: basicLanguageModel(),
    });
    const app = await runtime.create({ prompt: "Away worker" }, ctx("user_ada"));
    await seedAppRow(store, { ...app, ui: "http" }, "user_ada");

    // 05 §6: an away run is authorized only by a present-captured, app-bound grant
    // (`appId` matches the running app). Seed exactly that for host_read so the away
    // call is legitimately authorized — the frozen rule, not the "ungranted away read
    // runs" the fixture's away-park gap previously let this test assert. This is the
    // authorized call whose away RunContext we observe flowing through the proxy.
    guard.grants.push({
      id: "grt_away_read",
      subject: "user_ada",
      tool: "host_read",
      descriptorHash: descriptorHash(descriptors[0]!),
      scope: { kind: "tool" },
      duration: "standing",
      appId: app.id,
      source: "automation",
      grantedAt: new Date().toISOString(),
    });

    // Open the app while the user is AWAY — the minted run token must carry presence.
    await runtime.open(app.id, ctx("user_ada", "away"));
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(1));
    const token = [...sandbox.machines.values()].at(-1)?.env.VENDO_RUN_TOKEN as string;

    const toolCall = (tool: string) => runtime.proxy.handler(new Request(`https://proxy.test/tools/${tool}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    }));

    // The app-bound grant authorizes the away read; the RunContext reflects the away
    // token scope + app id (05 §6 — a present-captured app-bound grant runs away).
    expect(await json(await toolCall("host_read"))).toEqual({
      status: "ok",
      output: { tool: "host_read", presence: "away", appId: app.id },
    });

    // Ungranted away write parks → pending-approval fail-soft outcome (never an exception).
    expect(await json(await toolCall("host_park"))).toMatchObject({ status: "pending-approval", approvalId: expect.any(String) });

    // A guard block surfaces as a blocked outcome, not authority.
    expect(await json(await toolCall("host_forbidden"))).toEqual({ status: "blocked", reason: expect.any(String) });

    // The machine cannot invent tools: an unknown name resolves against the bound registry only.
    expect(await json(await toolCall("host_unknown"))).toMatchObject({ status: "error", error: { code: "not-found" } });
  });
});
