import { engineOverAdapter } from "@vendoai/core";
import {
  VENDO_APP_FORMAT,
  VendoError,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
  type ScreenAssembler,
  type VendoTheme,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createAppHistory } from "../src/server/persistence/history.js";
import { createApps } from "../src/server/index.js";
import { fakeBoxSandbox, type FakeBoxAgent } from "../src/server/testing/fake-box.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

/**
 * execution-v2 Wave 4 — layer 3 (machine-everything), on the fake-box
 * substrate. Covers the door an app that IS served is reached through: the
 * clean refusals (open, ping, fork), the proxy URL, the theming handoff query
 * param, wake-on-open, the keepalive ping, and edits riding the box path.
 *
 * The 2→3 flip that used to MANUFACTURE a served app is not here: the flip
 * needs `runServerWork`'s `served`, the plan's flag, and no door sets it today,
 * so an app can no longer BECOME served. The world therefore starts where the
 * flip used to end — a stored served row.
 */

const ctx = (subject = "user_ada"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const appRow = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_served",
  name: "Invoice board",
  ui: "tree",
  ...overrides,
});

const PROXY_PATH = (appId: string): string => `/api/vendo/apps/${appId}/serve/`;

const setup = (options: {
  agent?: FakeBoxAgent;
  theme?: VendoTheme;
  /** Compose WITHOUT the wire's authenticated served door (an unmounted wire). */
  proxy?: boolean;
} = {}) => {
  const store = memoryStore();
  const guard = guardFixture();
  const sandbox = fakeBoxSandbox(options.agent === undefined ? {} : { agent: options.agent });
  const screen: ScreenAssembler = {
    assemble: async () => ({ kind: "escalate", why: "this needs real code, not an arrangement of components" }),
  };
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    // Nothing on these paths generates: the screen agent escalates, and the box
    // is what builds. The model is here because a runtime without one refuses to
    // edit at all.
    model: basicLanguageModel(),
    screen,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    machine: { sandbox, buildEnv: () => ({ PORT: "8080" }), implicitDomains: ["host.vendo.test"], boxEditPollMs: 5 },
    // The wire fills this with its own base path; the runtime never invents it.
    // EVERY served app is answered with it now, the owner's own included.
    ...(options.proxy === false ? {} : { servedProxyPath: PROXY_PATH }),
  });
  return { store, guard, sandbox, runtime };
};

/** A world holding a stored SERVED app: `ui: "http"`, no tree, and a snapshot
 *  of a box that already serves the kanban page beside its /fn endpoints —
 *  exactly the row the 2→3 flip used to leave behind. The machine is asleep,
 *  which is how that flip ended. */
const served = async (options: Parameters<typeof setup>[0] = {}) => {
  const world = setup(options);
  await world.sandbox.create({ env: { PORT: "8080" } });
  // Through `machines`, not `create`: the seam's `create` answers a
  // `SandboxMachine`, and seeding writes the fake's own box state.
  const box = world.sandbox.machines.at(-1)!;
  box.state.pages.set("/", "<!doctype html><title>Invoice kanban</title><h1>Kanban</h1>");
  box.state.fns.set("listInvoices", () => ({ invoices: [] }));
  const snapshotRef = await box.snapshot();
  await box.stop();
  await seedAppRow(engineOverAdapter(world.store), appRow({
    ui: "http",
    machine: { snapshotRef, provisionedAt: "2026-08-01T00:00:00.000Z" },
  }), "user_ada");
  return world;
};

describe("a served app needs a machine, and a door to serve it through", () => {
  // The pre-emptive typed refusal on create and edit is GONE with the regex
  // judge that guessed a layer-3 ask from the instruction text
  // (`instructionRequiresServedApp`). A lane this host does not have is now
  // stated to the brain as fact before it plans, and the ask comes back as an
  // honest <Cannot> the person reads — covered by build-failure.test.ts.

  /** This used to be the served flag's refusal. The flag is gone, and the
      condition it was standing in front of is the real one: a served document
      with no machine has no surface anywhere. */
  it("refuses open() on a served app that has no machine, saying its surface is gone", async () => {
    const { store, runtime } = setup();
    await seedAppRow(engineOverAdapter(store), appRow({ ui: "http" }), "user_ada");

    const error = await runtime.open("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("validation");
    expect((error as VendoError).message).toContain("has no machine");
  });

  /** The backstop for a served row that arrives from somewhere else — an
      import, or a deployment that dropped its wire after building the app. The
      lane gate stops one from ever being BUILT here (lanes.test.ts); if one
      exists anyway, the answer is a refusal naming the fix, never the sandbox
      provider's unchecked URL. */
  it("refuses a served app it has no authenticated door for, and names the wire", async () => {
    const { sandbox, runtime } = await served({ proxy: false });
    const machinesBefore = sandbox.machines.length;

    const error = await runtime.open("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("not-implemented");
    expect((error as VendoError).message).toContain("mount the Vendo wire");
    // No provider URL leaked out of the refusal, and no machine was spent.
    expect((error as VendoError).message).not.toContain("fake-box.test");
    expect(sandbox.machines.length).toBe(machinesBefore);
  });
});

describe("serving through the door + the keepalive ride", () => {
  it("open() hands back this deployment's proxy URL, never the box's public ingress", async () => {
    const { sandbox, runtime } = await served();
    // The served app is stored asleep (a snapshot). open() wakes nothing: the
    // URL it hands out is the proxy, and the proxy wakes the machine on the
    // first forwarded request — after it has re-checked access. An owner opening
    // their own app therefore costs no machine either.
    const machinesBefore = sandbox.machines.length;

    const surface = await runtime.open("app_served", ctx());

    expect(surface.kind).toBe("http");
    if (surface.kind !== "http") throw new Error("unreachable");
    expect(surface.url).toBe("/api/vendo/apps/app_served/serve/");
    expect(surface.url).not.toMatch(/fake-box\.test/);
    expect(sandbox.machines.length).toBe(machinesBefore);

    // The door that URL names is the one that wakes the box and serves the page.
    const page = await runtime.serve("app_served", { method: "GET", path: "/" }, ctx());
    expect(page.status).toBe(200);
    expect(new TextDecoder().decode(page.body)).toContain("Kanban");
    expect(sandbox.machines.length).toBeGreaterThan(machinesBefore);
  });

  it("hands the host theme to the served app as a query param it MAY consume", async () => {
    const theme: VendoTheme = {
      colors: {
        background: "#ffffff", surface: "#f7f7f8", text: "#111111", muted: "#666666",
        accent: "#3457dc", accentText: "#ffffff", danger: "#b3261e", border: "#e3e3e6",
      },
      typography: { fontFamily: "Inter, sans-serif", baseSize: "16px" },
      radius: { small: "6px", medium: "10px", large: "16px" },
      density: "comfortable",
      motion: "full",
    };
    const { runtime } = await served({ theme });

    const surface = await runtime.open("app_served", ctx());

    if (surface.kind !== "http") throw new Error("expected an http surface");
    // The proxy forwards the query string into the box, so the brand handoff
    // survives the trip through a checked door.
    const url = new URL(surface.url, "http://host.test");
    expect(url.pathname).toBe("/api/vendo/apps/app_served/serve/");
    const handed = url.searchParams.get("vendoTheme");
    expect(handed).not.toBeNull();
    expect(JSON.parse(handed as string)).toEqual(theme);
  });

  it("ping on an awake machine reports awake without waking anything new (the keepalive ride)", async () => {
    // Wave 7 H2 — the embed surface's activity ping: one cheap HEAD through
    // the idle-tracked machine wrapper, which is the activity signal that
    // re-arms the idle timer (and rides any provider TTL extension).
    const { sandbox, runtime } = await served();
    // open() hands out the proxy URL and wakes nothing; the machine comes awake
    // on the first request through that door, which is what this ping follows.
    await runtime.serve("app_served", { method: "GET", path: "/" }, ctx());
    const machinesBefore = sandbox.machines.length;

    const pinged = await runtime.machine.ping("app_served", ctx());

    expect(pinged).toEqual({ state: "awake" });
    expect(sandbox.machines.length).toBe(machinesBefore);
  });

  it("ping on a sleeping machine wakes it and reports woke (the embed reloads once awake)", async () => {
    // A stored served app is asleep. A ping that finds the machine asleep is the
    // load-failure/stale-URL signal: it wakes the box and reports "woke" so
    // the embed shows the resuming state and re-opens for the fresh URL.
    const { sandbox, runtime } = await served();
    const machinesBefore = sandbox.machines.length;

    const pinged = await runtime.machine.ping("app_served", ctx());

    expect(pinged).toEqual({ state: "woke" });
    expect(sandbox.machines.length).toBeGreaterThan(machinesBefore);
    // The wake is shared: the follow-up open() reuses the live machine
    // instead of waking a second one.
    const afterPing = sandbox.machines.length;
    const surface = await runtime.open("app_served", ctx());
    expect(surface.kind).toBe("http");
    expect(sandbox.machines.length).toBe(afterPing);
  });

  it("ping refuses an app that has no machine", async () => {
    const world = setup();
    await seedAppRow(engineOverAdapter(world.store), appRow(), "user_ada");
    const error = await world.runtime.machine.ping("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("validation");
  });

  it("refuses to fork a served app (its surface lives in the machine, which never travels)", async () => {
    const { runtime } = await served();
    const error = await runtime.fork("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("conflict");
    expect((error as VendoError).message).toContain("cannot be forked");
  });

  it("every edit of a served app rides the box path (tree dialect is gone for it)", async () => {
    const { sandbox, runtime } = await served();
    const machinesBefore = sandbox.machines.length;
    const result = await runtime.edit("app_served", "Make the board header blue", ctx());
    expect(result.failure).toBeUndefined();
    expect(result.app.ui).toBe("http");
    expect(sandbox.machines.length).toBeGreaterThan(machinesBefore);
  });

  it("keeps the app it has when the box edit fails (the machine is discarded, nothing changed)", async () => {
    const { runtime } = await served({
      agent: () => ({ ok: false, summary: "could not build the app", filesChanged: [], testsRun: 0 }),
    });

    const result = await runtime.edit("app_served", "Make the board header blue", ctx());

    expect(result.failure).toMatchObject({ code: "edit-rejected" });
    const after = await runtime.get("app_served", ctx());
    expect(after?.ui).toBe("http");
    expect(after?.machine?.snapshotRef).toMatch(/^fakebox:/);
    // The pre-edit snapshot is still what the door serves.
    expect((await runtime.open("app_served", ctx())).kind).toBe("http");
  });

  /* DELETED with `experimentalMachines`: "keeps editing a served app whose
     machine already exists, even with layer 2 switched off". Layer 2 has no
     switch any more — the sandbox adapter's presence is the whole gate — so
     "off" now means there is no sandbox to wake the app's existing machine
     with, and the case the test described cannot be composed. The rule it
     guarded still holds and is still enforced in `lifecycle.provision`: an
     already-provisioned app is never refused, only NEW provisioning is. */

  it("keeps version history at its 50 cap — the box path prunes like every other write", async () => {
    // The box path appends its own version (the box already landed the write,
    // so that version is real history the moment it exists) and is therefore the
    // third site the cap is applied at. Nothing pinned it: dropping its
    // `pruneHistory` call left the log growing past 50 with the suite green.
    const { store, runtime } = await served();
    const history = createAppHistory(engineOverAdapter(store));
    const current = (await runtime.get("app_served", ctx()))!;
    for (let index = 1; index <= 50; index += 1) {
      await history.append("app_served", current, {
        at: new Date(1_754_000_000_000 + index).toISOString(),
        intent: `Edit ${index}`,
        rung: 3,
      });
    }
    const before = await runtime.history("app_served", ctx()).list();
    expect(before).toHaveLength(50);
    expect(before.at(-1)?.intent).toBe("Edit 1");

    const result = await runtime.edit("app_served", "Make the board header blue", ctx());
    expect(result.failure).toBeUndefined();

    const versions = await runtime.history("app_served", ctx()).list();
    // The cap held with this edit's version in it, and the oldest version in
    // the log is what paid for it.
    expect(versions).toHaveLength(50);
    expect(versions[0]?.intent).toBe("Make the board header blue");
    expect(versions.filter(({ intent }) => intent === "Edit 1")).toEqual([]);
  });
});
